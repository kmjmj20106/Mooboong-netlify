import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { zipFunctions } from '@netlify/zip-it-and-ship-it';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { readArchive } from '../lib/archive.mjs';
import { parseXlsx } from '../lib/workbook.mjs';

const root=resolve(import.meta.dirname,'..'),origin='https://mooboong-test.netlify.app';
function worker(directory){
  const env={...process.env,NETLIFY:'true',NODE_ENV:'production',APP_ORIGIN:origin,URL:origin,PG_POOL_MODE:'transaction',DATABASE_URL:'postgresql://postgres:test-only@127.0.0.1:54329/postgres',SETUP_TOKEN:'test-only-key',FUNCTION_MODULE:join(directory,'netlify/functions/api.mjs')};
  delete env.NODE_TEST_CONTEXT;
  const child=fork(join(root,'tests/netlify-worker.mjs'),[],{cwd:directory,env,stdio:['ignore','pipe','pipe','ipc']});
  let seq=0,logs='';const pending=new Map();child.stderr.on('data',d=>logs+=d);
  const ready=new Promise((done,reject)=>{child.on('error',reject);child.on('exit',code=>{if(code)reject(new Error(logs));});child.on('message',m=>{if(m.ready)done();});});
  child.on('message',m=>{if(m.id){const p=pending.get(m.id);pending.delete(m.id);if(m.error)p.reject(new Error(m.error));else{const bytes=Buffer.from(m.body,'base64');let body;try{body=JSON.parse(bytes.toString());}catch{}p.done({...m,bytes,body});}}});
  return {ready,logs:()=>logs,async stop(){if(child.exitCode!==null)return;await new Promise(done=>{child.once('exit',done);child.kill('SIGKILL');});},async request(path,{method='GET',body,raw,cookie='',headers={},ip}={}){
    await ready;const id=++seq;
    const bytes=raw??(body===undefined?undefined:Buffer.from(JSON.stringify(body)));
    return new Promise((done,reject)=>{pending.set(id,{done,reject});child.send({id,path,method,body:bytes?.toString('base64'),ip,headers:{Origin:origin,'X-Mooboong-Request':'1','Content-Type':raw?'application/octet-stream':'application/json',Cookie:cookie,...headers}});});
  }};
}
test('Netlify deployment bundle: independent workers share imports, uploads, sessions, limits and reservation locks',{timeout:90000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'mooboong-netlify-'));
  const engine=await PGlite.create(),socket=new PGLiteSocketServer({db:engine,port:54329,host:'127.0.0.1',maxConnections:12});
  const workers=[];
  try{
    const [artifact]=await zipFunctions(join(root,'netlify/functions'),join(directory,'zip'),{basePath:root,config:{'*':{nodeBundler:'esbuild',nodeVersion:'24',includedFiles:['schema.sql','public/templates/mooboong-import.xlsx'],includedFilesBasePath:root}}});
    assert.equal(artifact.runtimeAPIVersion,2);
    const files=await readArchive(await readFile(artifact.path));
    for(const [path,bytes]of files){const target=join(directory,path);await mkdir(dirname(target),{recursive:true});await writeFile(target,bytes);}
    assert.ok(files.has('schema.sql'));assert.ok(files.has('public/templates/mooboong-import.xlsx'));
    await socket.start();
    const a=worker(directory),b=worker(directory);workers.push(a,b);await Promise.all(workers.map(w=>w.ready));
    // First requests race on an empty schema: migration must be atomic.
    const cold=await Promise.all(workers.map(w=>w.request('/api/status')));
    for(const r of cold)assert.equal(r.status,200,JSON.stringify(r.body)+workers.map(w=>w.logs()).join(''));
    assert.equal((await a.request('/api/setup',{method:'POST',body:{id:'admin',name:'운영진',password:'SecureAdmin123!',setupToken:'wrong'}})).status,403);
    const setup=await a.request('/api/setup',{method:'POST',body:{id:'admin',name:'운영진',password:'SecureAdmin123!',setupToken:'test-only-key'}});
    assert.equal(setup.status,201,JSON.stringify(setup.body));assert.match(setup.headers['set-cookie'],/HttpOnly; SameSite=Strict.*Secure/);
    const cookie=setup.headers['set-cookie'].split(';')[0];
    assert.equal((await b.request('/api/me',{cookie})).status,200);
    assert.equal((await b.request('/api/logout',{method:'POST',cookie,headers:{Origin:'https://evil.invalid'}})).status,403);
    const workbook={members:[{'아이디':'member','이름':'부원','비밀번호':'MemberPassword123!','세션':'보컬','기수':'1','전화번호':'01012345678','팀':'','관리자여부':'N'}],teams:[{'팀명':'밴드','보컬':'member','기타1':'admin'}]};
    const preview=await a.request('/api/import/preview',{method:'POST',cookie,body:{workbook}});
    assert.equal(preview.status,200,JSON.stringify(preview.body));assert.ok(preview.body.token);
    const stored=(await engine.query('SELECT content FROM mooboong.transient_chunks')).rows[0].content;
    assert.ok(!Buffer.from(stored).includes(Buffer.from('MemberPassword123!')),'temporary data is encrypted with session-only key');
    assert.equal((await b.request('/api/import/commit',{method:'POST',cookie,body:{token:preview.body.token}})).status,200);
    assert.equal((await a.request('/api/import/commit',{method:'POST',cookie,body:{token:preview.body.token}})).status,400,'token cannot be replayed');
    const exported=await b.request('/api/members/export',{cookie});assert.equal(exported.status,200);
    const exportedRows=await parseXlsx(exported.bytes);assert.equal(exportedRows.members.find(m=>m['아이디']==='member')['팀'],'밴드');assert.ok(exportedRows.members.every(m=>m['비밀번호']===''));
    const overLimit=await a.request('/api/import/preview',{method:'POST',cookie,body:{members:Array.from({length:101},(_,i)=>({'아이디':'new-'+i,'이름':'신규 '+i}))}});
    assert.equal(overLimit.status,200);assert.equal(overLimit.body.preview.valid,false);assert.ok(overLimit.body.preview.errors.some(e=>e.message.includes('100명')));
    // Actual shared transaction-pooler mode must block overlapping reservations.
    const date=new Date(Date.now()+2*86400000).toISOString().slice(0,10);
    const reservation={type:'personal',date,start:'12:00',end:'13:00'};
    const concurrent=await Promise.all(workers.map(w=>w.request('/api/bookings',{method:'POST',cookie,body:reservation})));
    assert.deepEqual(concurrent.map(r=>r.status).sort(),[201,409],JSON.stringify(concurrent.map(r=>r.body)));
    const teamId=(await a.request('/api/teams',{cookie})).body.teams[0].id;
    const repeatUntil=new Date(new Date(date+'T00:00:00Z').valueOf()+350*86400000).toISOString().slice(0,10);
    const repeating={type:'team',teamId,date,start:'16:00',end:'17:00',repeatUntil};
    const series=await b.request('/api/bookings',{method:'POST',cookie,body:repeating});assert.equal(series.status,201,JSON.stringify(series.body));assert.equal(series.body.count,51);
    const removed=await a.request(`/api/bookings/${series.body.booking.id}/series`,{method:'DELETE',cookie});assert.equal(removed.status,200);assert.equal(removed.body.count,51);
    const lastEvent=await a.request('/api/events',{method:'POST',cookie,body:{title:'마지막 주 일정',date:repeatUntil,start:'16:00',end:'17:00'}});assert.equal(lastEvent.status,201);
    assert.equal((await b.request('/api/bookings',{method:'POST',cookie,body:repeating})).status,409);
    assert.equal((await engine.query("SELECT COUNT(*) n FROM mooboong.bookings WHERE type='team'")).rows[0].n,0,'late recurrence conflict leaves no partial series');
    const event=await b.request('/api/events',{method:'POST',cookie,body:{title:'대청소',date,start:'14:00',end:'15:00'}});assert.equal(event.status,201,JSON.stringify(event.body));
    const weekly=await a.request('/api/bookings?week='+date,{cookie});assert.ok(weekly.body.bookings.some(b=>b.title==='대청소'));
    const schedule=await b.request('/api/schedule?week='+date,{cookie});
    assert.equal(schedule.status,200,JSON.stringify(schedule.body));
    assert.deepEqual(schedule.body.bookings,weekly.body.bookings);
    assert.deepEqual(schedule.body.usage,weekly.body.usage);
    assert.equal(schedule.body.teams[0].id,teamId);
    assert.ok(schedule.body.bookingMembers.some(m=>m.id==='member'));
    assert.ok(schedule.body.bookingMembers.every(m=>Object.keys(m).sort().join(',')==='id,name'));
    assert.equal((await a.request('/api/schedule?week='+date)).status,401);
    const boot=await a.request('/api/bootstrap?route=schedule&week='+date,{cookie});
    assert.equal(boot.status,200,JSON.stringify(boot.body));
    assert.equal(boot.body.member.id,'admin');
    assert.deepEqual(boot.body.initial.data.bookingData,schedule.body);
    assert.ok(!JSON.stringify(boot.body).includes('password_hash'));
    const management=await b.request('/api/bootstrap?route=members',{cookie});
    assert.ok(management.body.initial.data.members.some(m=>m.id==='member'));
    const anonymous=await a.request('/api/bootstrap?route=members');
    assert.equal(anonymous.body.member,null);assert.equal(anonymous.body.setupRequired,false);assert.equal(anonymous.body.initial,undefined);
    const login=await a.request('/api/login',{method:'POST',body:{id:'member',password:'MemberPassword123!'}});
    const memberCookie=login.headers['set-cookie'].split(';')[0];
    const locked=await a.request('/api/bootstrap?route=members',{cookie:memberCookie});
    assert.equal(locked.body.member.mustChangePassword,true);assert.equal(locked.body.initial,undefined);
    await engine.query("UPDATE mooboong.members SET must_change_password=0 WHERE id='member'");
    const regular=await b.request('/api/bootstrap?route=members&week='+date,{cookie:memberCookie});
    assert.ok(regular.body.initial.key.startsWith('schedule:'));assert.equal(regular.body.initial.data.members,undefined);
    assert.deepEqual(regular.body.initial.data.bookingData.bookingMembers,[]);
    await engine.query("UPDATE mooboong.sessions SET expires_at=0 WHERE member_id='member'");
    const expired=await b.request('/api/bootstrap?route=schedule',{cookie:memberCookie});
    assert.equal(expired.body.member,null);assert.equal(expired.body.initial,undefined);
    const post=await a.request('/api/posts',{method:'POST',cookie,body:{kind:'notice',title:'첨부 테스트',body:'큰 파일'}});assert.equal(post.status,201,JSON.stringify(post.body));
    const attachmentPath=`/api/posts/${post.body.post.id}/attachments`;
    const large=randomBytes(7*1024*1024+13);
    const upload=await a.request('/api/uploads',{method:'POST',cookie,body:{path:attachmentPath,size:large.length}});
    assert.equal(upload.status,201,JSON.stringify(upload.body));
    assert.equal((await b.request(attachmentPath,{method:'POST',cookie,headers:{'X-Upload-Token':upload.body.token,'X-Filename':'large.zip'}})).status,400,'incomplete upload stays retryable');
    for(let offset=0;offset<large.length;offset+=1024*1024){const r=await workers[(offset/(1024*1024))%2].request(`/api/uploads/${upload.body.token}/${offset/(1024*1024)}`,{method:'PUT',cookie,raw:large.subarray(offset,offset+1024*1024)});assert.equal(r.status,200,JSON.stringify(r.body));}
    const attached=await b.request(attachmentPath,{method:'POST',cookie,headers:{'X-Upload-Token':upload.body.token,'X-Filename':'large.zip'}});assert.equal(attached.status,201,JSON.stringify(attached.body));
    const download=await a.request('/api/attachments/'+attached.body.attachment.id,{cookie});assert.equal(download.status,200);assert.deepEqual(download.bytes,large);
    const notion=await b.request('/api/wiki/import',{method:'POST',cookie,raw:Buffer.from('<html><title>Flow8</title><article><h1>안내</h1><script>alert(1)</script></article></html>')});assert.equal(notion.status,201,JSON.stringify(notion.body));
    const doc=await a.request(`/api/posts/${notion.body.id}/document`,{cookie});assert.equal(doc.status,200);assert.ok(!doc.bytes.toString().includes('<script'));assert.match(doc.headers['content-security-policy'],/script-src 'none'/);
    // Limits survive alternation between instances; IP comes from context.
    for(let i=0;i<8;i++)assert.equal((await workers[i%2].request('/api/login',{method:'POST',body:{id:'missing-account',password:'wrong'},ip:'198.51.100.2'})).status,401);
    assert.equal((await a.request('/api/login',{method:'POST',body:{id:'missing-account',password:'wrong'},ip:'198.51.100.3'})).status,429);
    assert.equal((await b.request('/api/logout',{method:'POST',cookie})).status,200);
    assert.equal((await a.request('/api/me',{cookie})).status,401);
    assert.equal((await engine.query('SELECT count(*) n FROM mooboong.transient_uploads')).rows[0].n,0);
  }finally{
    await Promise.all(workers.map(w=>w.stop()));await socket.stop();await new Promise(r=>setImmediate(r));await engine.runExclusive(async()=>{});await new Promise(r=>setImmediate(r));await engine.close();await rm(directory,{recursive:true,force:true});
  }
});

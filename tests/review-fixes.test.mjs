import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import vm from 'node:vm';
import {openDatabase} from '../lib/db.mjs';
import {wrapSqlite} from '../lib/database.mjs';
import {hashPassword} from '../lib/security.mjs';
import {applyImport,previewImport} from '../lib/import.mjs';
import {exportMembers} from '../lib/member-export.mjs';
import {parseXlsx} from '../lib/workbook.mjs';
import {reservationPolicy,validatePolicies} from '../lib/booking-policy.mjs';

test('8+ members survive export/import unchanged with the original Excel headers',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'mooboong-roundtrip-')),db=wrapSqlite(openDatabase(dir));
  try{
    db.prepare('INSERT INTO members(id,name,password_hash,admin,must_change_password) VALUES(?,?,?,?,0)').run('admin','관리자',hashPassword('test-password'),1);
    const members=Array.from({length:12},(_,i)=>({'아이디':'m'+i,'이름':i<2?'동명이인':'부원'+i}));
    await applyImport(db,{members,teams:[{'팀명':'큰 팀','보컬':members.map(m=>m['아이디']).join('\n')}]},'admin');
    const before=db.prepare('SELECT * FROM team_members ORDER BY slot').all();
    const workbook=await parseXlsx(await exportMembers(db));
    assert.equal(workbook.teams[0]['보컬'].split('\n').length,12);
    const preview=await previewImport(db,workbook,'admin');
    assert.equal(preview.summary.updatedMembers,0);assert.equal(preview.summary.updatedTeams,0);assert.equal(preview.summary.unchangedMembers,13);
    assert.ok(preview.members.every(m=>m.action==='unchanged'));
    await applyImport(db,workbook,'admin');assert.deepEqual(db.prepare('SELECT * FROM team_members ORDER BY slot').all(),before);
  }finally{db.close();await rm(dir,{recursive:true,force:true})}
});

test('special rules are opt-in, date bounded, and per-target quotas override hours only',()=>{
  const s={personalWeeklyHours:3,teamWeeklyHours:6,specialPolicy:{enabled:false,from:'2026-10-10',until:'2026-10-24',allowedSessions:['드럼','키보드'],personalWeeklyHours:1,teamWeeklyHours:4},quotaOverrides:[]};
  const target={type:'personal',memberId:'a',session:'보컬'};
  assert.deepEqual(reservationPolicy(s,'2026-10-15',target),{hours:3,allowed:true,active:false});
  s.specialPolicy.enabled=true;assert.equal(reservationPolicy(s,'2026-10-15',target).allowed,false);
  assert.equal(reservationPolicy(s,'2026-10-25',target).allowed,true);
  s.quotaOverrides=[{type:'personal',id:'a',from:'2026-10-10',until:'2026-10-24',hours:5}];
  assert.deepEqual(reservationPolicy(s,'2026-10-15',target),{hours:5,allowed:false,active:true});
  assert.equal(reservationPolicy(s,'2026-10-15',{...target,session:'기타, 드럼'}).allowed,true);
  assert.throws(()=>validatePolicies({quotaOverrides:[...s.quotaOverrides,...s.quotaOverrides]},x=>/^\d{4}-\d{2}-\d{2}$/.test(x),(_code,msg)=>{throw Error(msg)}),/겹칠/);
});

test('Markdown renders headings/lists/code and escapes raw HTML and unsafe links',async()=>{
  const {JSDOM}=await import('jsdom');const dom=new JSDOM('',{runScripts:'outside-only'});const context=dom.getInternalVMContext();vm.runInContext(await readFile(new URL('../public/markdown.js',import.meta.url),'utf8'),context);
  const result=context.window.renderMarkdown('# 제목\n- **내용**\n<script>alert(1)</script>\n[x](javascript:alert(1))\n[사이트](https://example.com)\n```\n<img onerror=x>\n```');
  assert.match(result,/<h2>제목<\/h2>/);assert.match(result,/<li><strong>내용/);assert.ok(!result.includes('<script>'));assert.ok(!result.includes('href="javascript:'));assert.ok(!result.includes('<img '));assert.match(result,/rel="noopener noreferrer"/);
});

test('review HTTP: member editing, team identity, special rules, conflict skipping and permissions',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'mooboong-review-http-'));const base='http://127.0.0.1:4357';
  const db=openDatabase(dir);db.prepare('INSERT INTO members(id,name,password_hash,admin,must_change_password,session) VALUES(?,?,?,?,0,?)').run('admin','운영진',hashPassword('test-admin-password'),1,'드럼');
  for(const [id,session]of [['drummer','드럼'],['vocal','보컬']])db.prepare('INSERT INTO members(id,name,password_hash,admin,must_change_password,session) VALUES(?,?,?,?,0,?)').run(id,id,hashPassword('test-member-password'),0,session);
  db.prepare('INSERT INTO teams(name) VALUES(?)').run('테스트팀');db.prepare('INSERT INTO teams(name) VALUES(?)').run('다른팀');db.prepare('INSERT INTO team_members(team_id,slot,member_id) VALUES(1,?,?)').run('drums','drummer');db.close();
  const child=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:'4357',DATA_DIR:dir,DATABASE_URL:'',NETLIFY:'',RENDER:'',NODE_ENV:'test',APP_ORIGIN:'',URL:'',RENDER_EXTERNAL_URL:'',HOST:'127.0.0.1'},stdio:['ignore','pipe','pipe']});
  const client=()=>{let cookie='';return async(path,method='GET',body)=>{const r=await fetch(base+'/api'+path,{method,headers:{'Content-Type':'application/json','Origin':base,'X-Mooboong-Request':'1',Cookie:cookie},body:body===undefined?undefined:JSON.stringify(body)});cookie=r.headers.get('set-cookie')?.split(';')[0]||cookie;return {status:r.status,data:await r.json()}}};
  try{
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('startup timeout')),10000);child.stdout.on('data',c=>{if(String(c).includes('http://127.0.0.1')){clearTimeout(timer);resolve()}});child.once('exit',()=>{clearTimeout(timer);reject(Error('early exit'))})});
    const admin=client(),member=client(),guest=client();
    const logged=await admin('/login','POST',{id:'admin',password:'test-admin-password'});assert.equal(logged.status,200);assert.equal(logged.data.initial.key,'members');assert.equal(logged.data.initial.data.members.length,3);
    assert.equal((await guest('/directory')).status,401);
    await member('/login','POST',{id:'drummer',password:'test-member-password'});
    assert.equal((await guest('/teams')).status,401);assert.equal((await member('/teams')).data.teams.length,1);
    assert.equal((await member('/directory')).status,403);assert.equal((await admin('/directory')).data.members.length,3);
    assert.equal((await member('/members/update','POST',{id:'admin',name:'oops',admin:true})).status,403);
    assert.equal((await member('/profile','PATCH',{name:'새 이름',admin:true,id:'admin'})).data.member.admin,false);
    assert.equal((await member('/me')).data.member.id,'drummer');
    assert.equal((await admin('/teams/update','POST',{id:1,name:'새 팀',slots:{vocal:'vocal',drums:'drummer\nadmin'}})).status,200);
    const team=(await admin('/teams')).data.teams.find(t=>t.id===1);assert.equal(team.members.length,3);assert.equal(team.name,'새 팀');
    assert.equal((await admin('/members/update','POST',{id:'vocal',name:'다른 이름',session:'보컬',generation:'27',phone:'01012345678',admin:false})).status,200);
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    const add=(d,n)=>new Date(Date.parse(d+'T12:00:00Z')+n*86400000).toISOString().slice(0,10),day=add(today,2),until=add(day,14);
    const settings={specialPolicy:{enabled:true,from:day,until,allowedSessions:['드럼'],personalWeeklyHours:1,teamWeeklyHours:6},quotaOverrides:[]};
    assert.equal((await admin('/settings','PUT',settings)).status,200);
    const personal={type:'personal',date:day,start:'10:00',end:'11:00'};
    assert.equal((await admin('/bookings','POST',{...personal,memberId:'vocal'})).status,403);
    assert.equal((await member('/bookings','POST',personal)).status,201);
    assert.equal((await member('/bookings','POST',{...personal,start:'11:00',end:'12:00'})).status,400);
    const repeat={type:'team',teamId:1,date:day,start:'10:00',end:'11:00',repeatUntil:until};
    assert.equal((await admin('/bookings','POST',repeat)).status,409);
    const created=await admin('/bookings','POST',{...repeat,skipConflicts:true});assert.equal(created.status,201,JSON.stringify(created));assert.equal(created.data.count,2);assert.equal(created.data.skipped.length,1);
    const concurrent=await Promise.all(Array.from({length:10},()=>admin('/bookings','POST',{type:'personal',date:add(day,1),start:'13:00',end:'14:00'})));
    assert.equal(concurrent.filter(r=>r.status===201).length,1);assert.equal(concurrent.filter(r=>r.status===409).length,9);
    assert.equal((await member('/feedback','POST',{message:'예약 UX 테스트'})).status,201);
    assert.equal((await member('/activity')).status,403);assert.ok((await admin('/activity')).data.entries.some(e=>e.action==='feedback'));
    const one=concurrent.find(r=>r.status===201).data.booking;
    assert.equal((await admin('/bookings/'+one.id,'DELETE')).status,200);
    assert.equal((await admin('/bookings/'+created.data.booking.id+'/series','DELETE')).status,200);
    const event=await admin('/events','POST',{title:'대청소',date:add(day,1),start:'15:00',end:'16:00'});
    assert.equal(event.status,201);assert.equal((await admin('/events/'+event.data.event.eventId,'DELETE')).status,200);
    const deleted=(await admin('/activity?filter=cancellations')).data.entries;
    assert.equal(deleted.length,3);assert.ok(deleted.every(e=>['booking.cancel','booking.cancel_series','event.delete'].includes(e.action)));
    assert.equal(deleted.find(e=>e.action==='booking.cancel').details.memberName,'운영진');
    assert.equal(deleted.find(e=>e.action==='booking.cancel_series').details.bookings[0].teamName,'새 팀');
    assert.equal(deleted.find(e=>e.action==='event.delete').details.title,'대청소');
    assert.equal((await admin('/bookings?week='+day)).data.bookings.some(b=>b.id===one.id),false);

    assert.equal((await member('/teams/create','POST',{name:'새로 추가'})).status,403);
    assert.equal((await admin('/teams/create','POST',{name:'새로 추가',slots:{vocal:'vocal'}})).status,200);
    assert.equal((await admin('/teams/create','POST',{name:'새로 추가'})).status,409);
    assert.equal((await admin('/teams/create','POST',{name:'실패 팀',slots:{vocal:'없는아이디'}})).status,400);
    const allTeams=(await admin('/teams')).data.teams;
    assert.ok(!allTeams.some(t=>t.name==='실패 팀'));assert.equal(allTeams.find(t=>t.name==='새로 추가').members[0].id,'vocal');
    await admin('/settings','PUT',{specialPolicy:{...settings.specialPolicy,enabled:false}});
    const ownerDate=add(day,3);
    const booking=(await admin('/bookings','POST',{type:'personal',memberId:'drummer',date:ownerDate,start:'10:00',end:'11:00'})).data.booking;
    assert.equal((await member('/bookings/'+booking.id+'/owner','PATCH',{memberId:'vocal'})).status,403);
    assert.equal((await admin('/bookings/'+booking.id+'/owner','PATCH',{})).status,400);
    const changed=await admin('/bookings/'+booking.id+'/owner','PATCH',{memberId:'vocal'});
    assert.equal(changed.status,200,JSON.stringify(changed.data));assert.equal(changed.data.booking.memberId,'vocal');assert.equal(changed.data.booking.createdBy,'admin');
    const occupied=await admin('/bookings','POST',{type:'personal',memberId:'drummer',date:ownerDate,start:'12:00',end:'12:30'});
    assert.equal(occupied.status,201);
    assert.equal((await admin('/bookings/'+booking.id+'/owner','PATCH',{memberId:'drummer'})).status,400);
    const repeated=await admin('/bookings','POST',{type:'team',teamId:1,date:ownerDate,start:'16:00',end:'17:00',repeatUntil:add(ownerDate,7)});
    assert.equal(repeated.status,201);
    const moved=await admin('/bookings/'+repeated.data.booking.id+'/owner','PATCH',{teamId:2});
    assert.equal(moved.status,200);assert.equal(moved.data.booking.teamId,2);assert.equal(moved.data.booking.seriesId,null);
    assert.ok((await admin('/activity')).data.entries.some(e=>e.action==='booking.transfer'));

  }finally{child.kill('SIGTERM');await new Promise(resolve=>child.exitCode!==null?resolve():child.once('exit',resolve));await rm(dir,{recursive:true,force:true})}
});

test('100,000 historical bookings keep weekly reads indexed and bounded',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'mooboong-calendar-load-')),db=openDatabase(dir);
  try{
    db.prepare('INSERT INTO members(id,name,password_hash,admin) VALUES(?,?,?,1)').run('admin','관리자','not-a-login-hash');
    db.exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<100000)
      INSERT INTO bookings(member_id,type,date,start_min,end_min) SELECT 'admin','personal',date('1900-01-01','+'||x||' days'),600,630 FROM n;`);
    const plan=db.prepare('EXPLAIN QUERY PLAN SELECT date,start_min,end_min FROM bookings WHERE date>=? AND date<?').all('2026-10-04','2026-10-11');
    assert.ok(plan.some(r=>r.detail.includes('bookings_date')));
    const started=performance.now();const rows=db.prepare('SELECT date,start_min,end_min FROM bookings WHERE date>=? AND date<?').all('2026-10-04','2026-10-11');
    assert.equal(rows.length,7);console.log('100k local SQLite weekly read ms:',Math.round((performance.now()-started)*100)/100);
  }finally{db.close();await rm(dir,{recursive:true,force:true})}
});

test('PostgreSQL v2 migration keeps existing membership and bookings, then accepts expanded teams',async()=>{
  const {PGlite}=await import('@electric-sql/pglite');
  const {postgresAdapter,initializePostgres}=await import('../lib/database.mjs');
  const engine=await PGlite.create();const old=process.env.NETLIFY;process.env.NETLIFY='true';
  try{
    const schema=await readFile(new URL('../schema.sql',import.meta.url),'utf8');
    await engine.exec(schema.slice(0,schema.indexOf('ALTER TABLE team_members DROP CONSTRAINT')));
    await engine.exec(`CREATE TABLE mooboong.netlify_schema_v2(version INTEGER PRIMARY KEY);
      INSERT INTO members(id,name,password_hash,admin,must_change_password) VALUES('admin','운영진','unchanged-hash',1,0);
      INSERT INTO teams(name) VALUES('기존 팀');
      INSERT INTO team_members(team_id,slot,member_id) VALUES(1,'vocal','admin');
      INSERT INTO bookings(member_id,team_id,type,date,start_min,end_min) VALUES('admin',1,'team','2026-10-15',600,660);`);
    const db=postgresAdapter({connect:async()=>({query:async(sql,args)=>sql.includes(';')?(await engine.exec(sql)).at(-1):engine.query(sql,args),release(){}}),end:async()=>{}},{transactionPooler:true});
    await initializePostgres(db);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM bookings').get()).n,1);
    assert.equal((await db.prepare('SELECT password_hash FROM members WHERE id=?').get('admin')).password_hash,'unchanged-hash');
    await applyImport(db,{members:[{아이디:'second',이름:'추가 부원'}],teams:[{팀명:'기존 팀',보컬:'admin\nsecond'}]},'admin');
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM team_members').get()).n,2);
    const workbook=await parseXlsx(await exportMembers(db));const preview=await previewImport(db,workbook,'admin');assert.equal(preview.summary.updatedMembers,0);assert.equal(preview.summary.updatedTeams,0);
    await applyImport(db,workbook,'admin');assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM bookings').get()).n,1);
  }finally{if(old===undefined)delete process.env.NETLIFY;else process.env.NETLIFY=old;await engine.close()}
});

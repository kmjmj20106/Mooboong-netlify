import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = new URL(process.env.BASE_URL || 'http://127.0.0.1:4320');
if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(base.hostname) || !base.port || base.port === '4319') {
  throw new Error('BASE_URL must be an unused loopback HTTP port, excluding the QA server on 4319.');
}
const python = process.env.PYTHON_BIN || 'python3';
const testDatabase = process.env.TEST_DATABASE_URL || '';
if(testDatabase && !['localhost','127.0.0.1'].includes(new URL(testDatabase).hostname)) throw new Error('Test database must be local and disposable.');

// Populate a copy of the distributed template using only Python's standard library.
function filledWorkbook() {
  return execFileSync(python, ['-c', String.raw`
import io, sys, zipfile, xml.etree.ElementTree as ET
ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
rows = {
 'xl/worksheets/sheet1.xml': [['test-user','테스트 보컬','','보컬','1','01000000000','HTTP 테스트','N']],
 'xl/worksheets/sheet2.xml': [['HTTP 테스트','test-user','','','','admin',''],['공석 테스트','','','','','','']],
}
output = io.BytesIO()
with zipfile.ZipFile(sys.argv[1]) as source, zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as target:
 for entry in source.infolist():
  content = source.read(entry.filename)
  if entry.filename in rows:
   doc = ET.fromstring(content)
   data = doc.find('{%s}sheetData' % ns)
   for row in list(data):
    if row.get('r') != '1': data.remove(row)
   for index, values in enumerate(rows[entry.filename], 2):
    row = ET.SubElement(data, '{%s}row' % ns, {'r':str(index)})
    for col, value in enumerate(values):
     cell = ET.SubElement(row, '{%s}c' % ns, {'r':chr(65+col)+str(index),'t':'inlineStr'})
     ET.SubElement(ET.SubElement(cell, '{%s}is' % ns), '{%s}t' % ns).text = value
   content = ET.tostring(doc, encoding='utf-8', xml_declaration=True)
  target.writestr(entry.filename, content)
sys.stdout.buffer.write(output.getvalue())
`, join(root, 'public/templates/mooboong-import.xlsx')], { maxBuffer: 5 * 1024 * 1024 });
}

test('real HTTP: setup, XLSX import, access control, booking rules and persistence', { timeout: 30000 }, async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'mooboong-http-test-'));
  let child;
  async function start() {
    await new Promise((done, reject) => {
      let stderr = '';
      child = spawn(process.execPath, ['server.mjs'], {
        cwd: root, env: { ...process.env, PORT: base.port, DATA_DIR: dataDirectory, PYTHON_BIN: python, DATABASE_URL: testDatabase, NODE_ENV:'test', RENDER:'', APP_ORIGIN:'', RENDER_EXTERNAL_URL:'', SETUP_TOKEN:'', HOST:'127.0.0.1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const timer = setTimeout(() => reject(new Error(`Server startup timed out. ${stderr}`)), 8000);
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited (${code}). ${stderr}`)); });
      child.stdout.on('data', chunk => {
        if (String(chunk).includes('http://127.0.0.1:')) { clearTimeout(timer); done(); }
      });
    });
  }
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const active = child;
    await new Promise(done => {
      const timer = setTimeout(() => active.kill('SIGKILL'), 2000);
      active.once('exit', () => { clearTimeout(timer); done(); });
      active.kill('SIGTERM');
    });
  }
  function client() {
    let cookie = '';
    return async (path, method = 'GET', body, headers = {}) => {
      const binary = Buffer.isBuffer(body);
      const response = await fetch(new URL(path, base), {
        method,
        headers: { Origin: base.origin, 'X-Mooboong-Request': '1',
          'Content-Type': binary ? 'application/octet-stream' : 'application/json', Cookie: cookie, ...headers },
        body: body === undefined ? undefined : binary ? body : JSON.stringify(body),
      });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const bytes = Buffer.from(await response.arrayBuffer());
      return { status: response.status, body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(bytes.toString()) : bytes.toString(), bytes, headers: response.headers };
    };
  }
  const admin = client(), member = client(), guest = client();
  try {
    await start();
    assert.equal((await guest('/api/status')).body.setupRequired, true);
    assert.equal((await guest('/api/members')).status, 401);
    const setup = await admin('/api/setup', 'POST', { id: 'admin', name: '테스트 운영진', password: 'AdminPassword123!' });
    assert.equal(setup.status, 201);
    assert.match(setup.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    assert.equal((await guest('/api/setup', 'POST', { id: 'other', name: '운영진', password: 'OtherPassword123!' })).status, 409);
    assert.equal((await guest('/api/login', 'POST', { id: 'admin', password: 'wrong' })).status, 401);
    assert.equal((await admin('/api/posts', 'POST', { kind: 'notice', title: '거절', body: '거절' }, { Origin: 'http://example.invalid' })).status, 403);
    const post = await admin('/api/posts', 'POST', { kind: 'notice', title: 'HTTP 저장 테스트', body: '서버를 재시작해도 유지됩니다.', category: '운영', pinned: true });
    assert.equal(post.status, 201);

    const upload = await admin('/api/import/file', 'POST', filledWorkbook());
    assert.equal(upload.status, 200, JSON.stringify(upload.body));
    assert.equal(upload.body.preview.valid, true, JSON.stringify(upload.body));
    assert.equal(upload.body.preview.summary.newMembers, 1);
    assert.equal(upload.body.preview.summary.newTeams, 2);
    assert.ok(upload.body.token);
    assert.ok(!JSON.stringify(upload.body).includes('20000000'), 'preview must not expose the default password');
    assert.equal((await admin('/api/import/commit', 'POST', { token: upload.body.token })).body.applied, true);
    assert.equal((await admin('/api/import/commit', 'POST', { token: upload.body.token })).status, 400, 'tokens are single-use');
    assert.equal((await admin('/api/members')).body.members.length, 2);
    const teams = (await admin('/api/teams')).body.teams;
    const teamId = teams.find(team => team.name === 'HTTP 테스트').id;
    const otherTeamId = teams.find(team => team.name === '공석 테스트').id;

    const login = await member('/api/login', 'POST', { id: 'test-user', password: '20000000' });
    assert.equal(login.status, 200);
    assert.equal(login.body.member.mustChangePassword, true);
    assert.equal((await member('/api/teams')).body.code, 'PASSWORD_CHANGE_REQUIRED');
    assert.equal((await member('/api/password', 'POST', { currentPassword: '20000000', newPassword: 'MemberPassword123!' })).status, 200);
    assert.equal((await member('/api/members')).status, 403);
    assert.equal((await guest('/api/members/export')).status, 401);
    assert.equal((await member('/api/members/export')).status, 403);
    const exported = await admin('/api/members/export?sort=name&order=desc');
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get('content-type'), /spreadsheetml/);
    assert.equal(exported.headers.get('cache-control'), 'no-store');
    assert.match(exported.headers.get('content-disposition'), /attachment; filename="mooboong-members-.*\.xlsx"/);
    const exportedRows = JSON.parse(execFileSync(python, ['lib/read_xlsx.py', '-'], { cwd: root, input: exported.bytes }).toString());
    assert.equal(exportedRows.members.length, 2);
    assert.ok(exportedRows.members.every(m => m['비밀번호'] === ''));
    assert.equal(exportedRows.members.find(m => m['아이디'] === 'test-user')['전화번호'], '01000000000');
    assert.equal(exportedRows.members.find(m => m['아이디'] === 'test-user')['팀'], 'HTTP 테스트');
    assert.equal(exportedRows.teams.find(t => t['팀명'] === 'HTTP 테스트')['드럼'], 'admin');
    const roundtrip = await admin('/api/import/file', 'POST', exported.bytes);
    assert.equal(roundtrip.body.preview.valid, true, JSON.stringify(roundtrip.body));
    assert.equal(roundtrip.body.preview.summary.newMembers, 0);
    assert.equal((await admin('/api/import/commit', 'POST', { token: roundtrip.body.token })).body.applied, true);
    assert.equal((await member('/api/me')).status, 200, 'export and reimport do not reset passwords or sessions');
    assert.equal((await member('/api/posts', 'POST', { kind: 'wiki', title: '권한', body: '권한' })).status, 403);

    const date = new Date(Date.now() + 36 * 3600000).toISOString().slice(0, 10);
    const competing = await Promise.all([0, 1].map(() => admin('/api/bookings', 'POST', { date, start: '09:00', end: '09:30', type: 'personal' })));
    assert.deepEqual(competing.map(result => result.status).sort(), [201, 409], 'concurrent overlapping writes cannot both succeed');
    assert.equal((await admin(`/api/bookings/${competing.find(result => result.status === 201).body.booking.id}`, 'DELETE')).status, 200);
    const personal = await member('/api/bookings', 'POST', { date, start: '10:00', end: '12:00', type: 'personal' });
    assert.equal(personal.status, 201, JSON.stringify(personal.body));
    assert.equal((await member('/api/bookings', 'POST', { date, start: '10:30', end: '11:00', type: 'personal' })).status, 409);
    assert.equal((await member('/api/bookings', 'POST', { date, start: '13:00', end: '15:00', type: 'personal' })).status, 400, 'personal weekly quota');
    assert.equal((await member('/api/bookings', 'POST', { date, start: '13:00', end: '14:00', type: 'team', teamId: otherTeamId })).status, 403);
    assert.equal((await member('/api/bookings', 'POST', { date, start: '13:00', end: '16:00', type: 'team', teamId })).status, 201);
    assert.equal((await member('/api/bookings', 'POST', { date, start: '16:00', end: '16:30', type: 'team', teamId })).status, 400, 'adjacent bookings count toward continuous limit');
    assert.equal((await member('/api/bookings', 'POST', { date, start: '17:00', end: '20:00', type: 'team', teamId })).status, 201);
    assert.equal((await member('/api/bookings', 'POST', { date, start: '21:00', end: '22:00', type: 'team', teamId })).status, 400, 'team weekly quota');
    assert.equal((await member(`/api/bookings/${personal.body.booking.id}`, 'DELETE')).status, 200);
    assert.equal((await member(`/api/bookings?week=${date}`)).body.bookings.length, 2);

    // The expanded operating window includes both endpoints.
    const day = offset => new Date(new Date(date+'T00:00:00Z').valueOf()+offset*86400000).toISOString().slice(0,10);
    for(const [start,end] of [['08:00','08:30'],['23:30','24:00']]) {
      const r=await admin('/api/bookings','POST',{date,start,end,type:'personal'});
      assert.equal(r.status,201,JSON.stringify(r.body));
      assert.equal((await admin(`/api/bookings/${r.body.booking.id}`,'DELETE')).status,200);
    }
    assert.equal((await admin('/api/bookings','POST',{date,start:'07:30',end:'08:00',type:'personal'})).status,400);
    const repeatDate=day(7), repeatEnd=day(21);
    const recurring=await member('/api/bookings','POST',{date:repeatDate,start:'08:00',end:'09:00',type:'team',teamId,repeatUntil:repeatEnd});
    assert.equal(recurring.status,201,JSON.stringify(recurring.body));
    assert.equal(recurring.body.count,3);
    assert.equal(new Set(recurring.body.bookings.map(b=>b.seriesId)).size,1);
    assert.equal(recurring.body.bookings[2].date,repeatEnd);
    assert.equal((await member('/api/bookings','POST',{date:repeatDate,start:'09:00',end:'10:00',type:'personal',repeatUntil:repeatEnd})).status,400);
    const blocker=await admin('/api/bookings','POST',{date:day(14),start:'11:00',end:'12:00',type:'personal'});
    assert.equal(blocker.status,201);
    const conflict=await member('/api/bookings','POST',{date:repeatDate,start:'11:00',end:'12:00',type:'team',teamId,repeatUntil:repeatEnd});
    assert.equal(conflict.status,409);
    assert.match(conflict.body.error,new RegExp(day(14)));
    assert.equal((await member(`/api/bookings?week=${repeatDate}`)).body.bookings.filter(b=>b.start==='11:00').length,0,'earlier occurrence must roll back');
    await admin('/api/settings','PUT',{recurringUntil:day(14)});
    assert.equal((await member('/api/bookings','POST',{date:repeatDate,start:'13:00',end:'14:00',type:'team',teamId,repeatUntil:repeatEnd})).status,400);
    await admin('/api/settings','PUT',{recurringUntil:''});

    // Series cancellation is scoped to one repeat group and remains atomic.
    const seriesPath=id=>`/api/bookings/${id}/series`;
    const sameTeamOtherSeries=await member('/api/bookings','POST',{date:repeatDate,start:'10:00',end:'10:30',type:'team',teamId,repeatUntil:repeatEnd});
    assert.equal(sameTeamOtherSeries.status,201,JSON.stringify(sameTeamOtherSeries.body));
    assert.notEqual(sameTeamOtherSeries.body.booking.seriesId,recurring.body.booking.seriesId);
    assert.equal((await guest(seriesPath(recurring.body.booking.id),'DELETE')).status,401);
    assert.equal((await member(`/api/bookings/${recurring.body.booking.id}`,'DELETE')).status,200);
    const remainingId=recurring.body.bookings[1].id;
    const preview=await member(seriesPath(remainingId));
    assert.equal(preview.body.count,2);assert.equal(preview.body.canCancelAll,true);
    assert.equal((await member(seriesPath(remainingId),'DELETE',undefined,{Origin:'https://other.invalid'})).status,403);
    const cancelled=await member(seriesPath(remainingId),'DELETE');
    assert.equal(cancelled.status,200);assert.equal(cancelled.body.count,2);
    assert.equal((await member(seriesPath(sameTeamOtherSeries.body.booking.id))).body.count,3,'another repeat group for same team survives');
    assert.equal((await member(seriesPath(remainingId),'DELETE')).status,404);

    // A blocked occurrence cannot be bypassed by choosing another future occurrence.
    const past=new Date(Date.now()-48*3600000).toISOString().slice(0,10);
    const setBookingDate=async(id,dateValue)=>{
      if(testDatabase){
        const {Client}=await import('pg');const fixtureDb=new Client({connectionString:testDatabase});await fixtureDb.connect();
        try{await fixtureDb.query('UPDATE mooboong.bookings SET date=$1 WHERE id=$2',[dateValue,id])}finally{await fixtureDb.end()}
      }else{
        const fixtureDb=new DatabaseSync(join(dataDirectory,'mooboong.sqlite'));
        try{fixtureDb.prepare('UPDATE bookings SET date=? WHERE id=?').run(dateValue,id)}finally{fixtureDb.close()}
      }
    };
    await setBookingDate(sameTeamOtherSeries.body.booking.id,past);
    const futureAnchor=sameTeamOtherSeries.body.bookings[1].id;
    assert.equal((await member(seriesPath(futureAnchor))).body.canCancelAll,false);
    assert.equal((await member(seriesPath(futureAnchor),'DELETE')).status,403);
    assert.equal((await admin(seriesPath(futureAnchor))).body.count,3,'failed batch changes nothing');
    const policyToday=new Date(Date.now()+9*3600000).toISOString().slice(0,10);
    await setBookingDate(sameTeamOtherSeries.body.booking.id,policyToday);
    await admin('/api/settings','PUT',{blockSameDayCancellation:true});
    assert.equal((await member(seriesPath(futureAnchor),'DELETE')).status,403);
    assert.equal((await admin(seriesPath(futureAnchor))).body.count,3);
    assert.equal((await admin(seriesPath(futureAnchor),'DELETE')).body.count,3);
    await admin('/api/settings','PUT',{blockSameDayCancellation:false});

    // Administrators can book any team, including a completely vacant team.
    const otherTeamSeries=await admin('/api/bookings','POST',{date:repeatDate,start:'18:00',end:'19:00',type:'team',teamId:otherTeamId,repeatUntil:repeatEnd});
    assert.equal(otherTeamSeries.status,201,JSON.stringify(otherTeamSeries.body));
    assert.equal(otherTeamSeries.body.count,3);
    assert.ok(otherTeamSeries.body.bookings.every(b=>b.createdBy==='admin')); 
    assert.equal((await member(seriesPath(otherTeamSeries.body.booking.id),'DELETE')).status,403);
    assert.equal((await admin(seriesPath(otherTeamSeries.body.booking.id),'DELETE')).body.count,3);

    // Personal proxy reservations belong to the selected account and consume its quota.
    assert.equal((await member('/api/booking-options')).status,403);
    const choices=(await admin('/api/booking-options')).body.members;
    assert.deepEqual(Object.keys(choices[0]).sort(),['id','name']);
    assert.equal(choices.length,2);
    const proxyBody={date:repeatDate,start:'14:00',end:'16:00',type:'personal',memberId:'test-user'};
    assert.equal((await member('/api/bookings','POST',{...proxyBody,memberId:'admin'})).status,403);
    assert.equal((await admin('/api/bookings','POST',{...proxyBody,memberId:'not-found'})).status,400);
    const proxy=await admin('/api/bookings','POST',proxyBody);
    assert.equal(proxy.status,201,JSON.stringify(proxy.body));
    assert.equal(proxy.body.booking.memberId,'test-user');
    assert.equal(proxy.body.booking.createdBy,'admin');
    assert.equal(proxy.body.booking.createdByName,'테스트 운영진');
    assert.equal((await member(`/api/bookings?week=${repeatDate}`)).body.bookings.find(b=>b.id===proxy.body.booking.id).createdBy,'admin');
    assert.equal((await member(`/api/bookings?week=${repeatDate}`)).body.usage.personalHours,2);
    assert.equal((await admin('/api/bookings','POST',{...proxyBody,start:'17:00',end:'19:00'})).status,400,'target account weekly quota applies');
    assert.equal((await admin('/api/bookings','POST',{...proxyBody,memberId:'admin'})).status,409,'admin proxy still checks room conflicts');
    assert.equal((await admin(seriesPath(proxy.body.booking.id),'DELETE')).status,400,'single reservation is not a series');
    assert.equal((await member(`/api/bookings/${proxy.body.booking.id}`,'DELETE')).status,200,'target owns proxy booking');

    // Existing same-day bookings are covered when an operator changes the policy.
    const now=new Date(Date.now()+9*3600000), today=now.toISOString().slice(0,10);
    let todayId;
    if(testDatabase){
      const { Client }=await import('pg');const fixtureDb=new Client({connectionString:testDatabase});await fixtureDb.connect();
      todayId=(await fixtureDb.query("INSERT INTO mooboong.bookings(member_id,type,date,start_min,end_min) VALUES('test-user','personal',$1,1410,1440) RETURNING id",[today])).rows[0].id;
      await fixtureDb.end();
    } else {
      const fixtureDb=new DatabaseSync(join(dataDirectory,'mooboong.sqlite'));
      todayId=Number(fixtureDb.prepare("INSERT INTO bookings(member_id,type,date,start_min,end_min) VALUES('test-user','personal',?,1410,1440)").run(today).lastInsertRowid);
      fixtureDb.close();
    }
    await admin('/api/settings','PUT',{blockSameDayCancellation:true});
    assert.equal((await member(`/api/bookings/${todayId}`,'DELETE')).status,403);
    const todayView=(await member(`/api/bookings?week=${today}`)).body.bookings.find(b=>b.id===todayId);
    assert.equal(todayView.canCancel,false);
    assert.equal((await admin(`/api/bookings/${todayId}`,'DELETE')).status,200);
    assert.equal((await member('/api/settings','PUT',{blockSameDayCancellation:false})).status,403);
    await admin('/api/settings','PUT',{blockSameDayCancellation:false});

    const guides=(await admin('/api/posts?kind=notice')).body.posts.filter(p=>p.title.includes('사이트 이용 안내'));
    assert.equal(guides.length,1);
    assert.equal((await admin('/api/admin-guide')).status,200);
    assert.equal((await member('/api/admin-guide')).status,403);
    const attachment=await admin(`/api/posts/${post.body.post.id}/attachments`,'POST',Buffer.from('notice attachment'),{'X-Filename':encodeURIComponent('안내.txt')});
    assert.equal(attachment.status,201,JSON.stringify(attachment.body));
    const attachmentPath=`/api/attachments/${attachment.body.attachment.id}`;
    assert.equal((await guest(attachmentPath)).status,401);
    const download=await member(attachmentPath);
    assert.equal(download.body,'notice attachment');
    assert.match(download.headers.get('content-disposition'),/^attachment;/);
    assert.equal((await member(`/api/posts/${post.body.post.id}/attachments`,'POST',Buffer.from('x'),{'X-Filename':'x.txt'})).status,403);
    assert.equal((await admin(`/api/posts/${post.body.post.id}/attachments`,'POST',Buffer.from('x'),{'X-Filename':'x.html'})).status,400);
    const imported=await admin('/api/wiki/import','POST',Buffer.from('<html><title>Flow8 guide</title><h1>Mixer guide</h1><script>alert(1)</script><p>Volume</p></html>'));
    assert.equal(imported.status,201,JSON.stringify(imported.body));
    assert.equal((await member('/api/wiki/import','POST',Buffer.from('<p>No</p>'))).status,403);
    const document=await member(`/api/posts/${imported.body.id}/document`);
    assert.equal(document.status,200);
    assert.ok(!document.body.includes('<script'));
    assert.match(document.headers.get('content-security-policy'),/script-src 'none'/);
    assert.equal((await guest(`/api/posts/${imported.body.id}/document`)).status,401);
    assert.equal((await admin('/api/posts','POST',{kind:'wiki',title:'bad URL',body:'test',sourceUrl:'javascript:alert(1)'})).status,400);

    // Custom schedules share the booking lock, block the room, and never use quotas.
    const eventBody = { title: '대청소 <안내>', description: '장갑을 준비해 주세요.', date: day(26), start: '08:00', end: '24:00' };
    assert.equal((await guest('/api/events', 'POST', eventBody)).status, 401);
    assert.equal((await member('/api/events', 'POST', eventBody)).status, 403);
    assert.equal((await admin('/api/events', 'POST', eventBody, { Origin: 'https://other.invalid' })).status, 403);
    for (const patch of [{ title: '' }, { title: 'x'.repeat(101) }, { date: '2026-02-30' }, { start: '07:30' }, { end: '08:00' }, { start: '08:15' }, { date: day(-5) }, { date: day(400) }]) {
      assert.equal((await admin('/api/events', 'POST', {...eventBody,...patch})).status, 400);
    }
    assert.equal((await admin('/api/events', 'POST', {...eventBody,date,start:'13:00',end:'14:00'})).status, 409, 'events cannot replace existing bookings');
    const usageBeforeEvent = (await admin('/api/bookings?week='+eventBody.date)).body.usage;
    const event = await admin('/api/events', 'POST', eventBody);
    assert.equal(event.status, 201, JSON.stringify(event.body));
    const eventId = event.body.event.eventId, eventPath = '/api/events/'+eventId;
    assert.equal(event.body.event.id, 'event-'+eventId);
    assert.equal(event.body.event.createdByName, '테스트 운영진');
    const memberSchedule = (await member('/api/bookings?week='+eventBody.date)).body.bookings;
    assert.equal(memberSchedule.find(x=>x.id===event.body.event.id).canCancel, false);
    assert.equal((await admin('/api/events','POST',eventBody)).status,409);
    assert.equal((await member(eventPath,'PUT',eventBody)).status,403);
    assert.equal((await member(eventPath,'DELETE')).status,403);
    assert.equal((await admin('/api/bookings','POST',{date:eventBody.date,start:'10:00',end:'11:00',type:'personal'})).status,409);
    assert.deepEqual((await admin('/api/bookings?week='+eventBody.date)).body.usage,usageBeforeEvent);
    const beforeSeries = (await admin('/api/bookings?week='+day(19))).body.bookings;
    const blockedSeries=await admin('/api/bookings','POST',{date:day(19),start:'08:00',end:'08:30',type:'team',teamId,repeatUntil:day(26)});
    assert.equal(blockedSeries.status,409);
    assert.deepEqual((await admin('/api/bookings?week='+day(19))).body.bookings,beforeSeries,'a late event collision rolls back the entire series');
    assert.equal((await admin(eventPath,'PUT',{...eventBody,date,start:'13:00',end:'14:00'})).status,409);
    assert.equal((await member('/api/bookings?week='+eventBody.date)).body.bookings.find(x=>x.eventId===eventId).start,'08:00','failed update preserves the event');
    assert.equal((await admin(eventPath,'PUT',{...eventBody,title:'면접',start:'18:00',end:'20:00'})).status,200);
    const adjacentEvent=await admin('/api/events','POST',{...eventBody,title:'면접 준비',start:'17:00',end:'18:00'});
    assert.equal(adjacentEvent.status,201);
    assert.equal((await admin('/api/events/'+adjacentEvent.body.event.eventId,'DELETE')).status,200);
    assert.equal((await admin('/api/events/'+adjacentEvent.body.event.eventId,'DELETE')).status,404);
    const freed=await admin('/api/bookings','POST',{date:eventBody.date,start:'17:00',end:'18:00',type:'personal'});
    assert.equal(freed.status,201,'deleting an event makes its time bookable');
    await admin('/api/bookings/'+freed.body.booking.id,'DELETE');
    const competingEvent = await Promise.all([
      admin('/api/events','POST',{...eventBody,start:'10:00',end:'11:00'}),
      admin('/api/bookings','POST',{date:eventBody.date,start:'10:00',end:'11:00',type:'personal'}),
    ]);
    assert.deepEqual(competingEvent.map(x=>x.status).sort(),[201,409],'event and booking cannot race into the same slot');
    if(competingEvent[0].status===201)await admin('/api/events/'+competingEvent[0].body.event.eventId,'DELETE');
    else await admin('/api/bookings/'+competingEvent[1].body.booking.id,'DELETE');

    await stop();
    if(testDatabase) await rm(dataDirectory,{recursive:true,force:true}); // Model Render discarding its disk.
    await start();
    assert.equal((await guest('/api/status')).body.setupRequired, false);
    assert.equal((await admin('/api/bookings?week='+eventBody.date)).body.bookings.find(x=>x.eventId===eventId).title,'면접','custom events persist across server restarts');
    assert.equal((await admin('/api/posts?kind=notice')).body.posts[0].id, post.body.post.id);
    assert.equal((await admin('/api/posts?kind=notice')).body.posts[0].title, 'HTTP 저장 테스트');
    assert.equal((await member(`/api/bookings?week=${date}`)).body.bookings.length, 2);
    assert.equal((await admin('/api/members')).body.members.length, 2);
    assert.equal((await admin('/api/posts?kind=notice')).body.posts.filter(p=>p.title.includes('사이트 이용 안내')).length,1);
    assert.equal((await member(attachmentPath)).body,'notice attachment');
    // Admin resets never disclose stored passwords; revoke every target session.
    const resetPath='/api/members/password-reset';
    const resetBody={memberId:'test-user',newPassword:'TemporaryPassword123!',operatorPassword:'AdminPassword123!'};
    assert.equal((await guest(resetPath,'POST',resetBody)).status,401);
    assert.equal((await member(resetPath,'POST',resetBody)).status,403);
    assert.equal((await admin(resetPath,'POST',{...resetBody,operatorPassword:'wrong'})).status,403);
    assert.equal((await member('/api/me')).status,200,'failed reset preserves target session');
    assert.equal((await admin(resetPath,'POST',{...resetBody,newPassword:'short'})).status,400);
    assert.equal((await admin(resetPath,'POST',{...resetBody,memberId:'missing'})).status,404);
    assert.equal((await admin(resetPath,'POST',{...resetBody,memberId:'admin'})).status,400);
    assert.equal((await admin(resetPath,'POST',resetBody,{Origin:'https://foreign.invalid'})).status,403);
    const secondDevice=client();
    assert.equal((await secondDevice('/api/login','POST',{id:'test-user',password:'MemberPassword123!'})).status,200);
    const reset=await admin(resetPath,'POST',resetBody);
    assert.equal(reset.status,200,JSON.stringify(reset.body));
    assert.equal(reset.body.mustChangePassword,true);
    assert.equal((await member('/api/me')).status,401);
    assert.equal((await secondDevice('/api/me')).status,401);
    assert.equal((await member('/api/login','POST',{id:'test-user',password:'MemberPassword123!'})).status,401);
    const temporaryLogin=await member('/api/login','POST',{id:'test-user',password:resetBody.newPassword});
    assert.equal(temporaryLogin.status,200);
    assert.equal(temporaryLogin.body.member.mustChangePassword,true);
    assert.equal((await member('/api/bookings')).status,403);
    assert.equal((await member('/api/password','POST',{currentPassword:resetBody.newPassword,newPassword:'FinalMemberPassword123!'})).status,200);
    assert.equal((await member('/api/bookings')).status,200);
    const safeList=await admin('/api/members');
    assert.ok(!JSON.stringify(safeList.body).includes('password_hash'));
    assert.ok(!JSON.stringify(safeList.body).includes(resetBody.newPassword));
    assert.equal(safeList.body.members.find(m=>m.id==='test-user').mustChangePassword,false);
    // A later reset remains usable after the member has changed their password.
    assert.equal((await admin(resetPath,'POST',{...resetBody,newPassword:'AdminTemporary123!'})).status,200);
    assert.equal((await member('/api/login','POST',{id:'test-user',password:'AdminTemporary123!'})).status,200);
    assert.equal((await member('/api/password','POST',{currentPassword:'AdminTemporary123!',newPassword:'FinalMemberPassword456!'})).status,200);
    assert.equal((await member('/api/logout', 'POST', {})).status, 200);
    assert.equal((await member('/api/me')).status, 401);
    const adminLogout=await admin('/api/logout','POST',{});
    assert.equal(adminLogout.status,200);
    assert.match(adminLogout.headers.get('set-cookie'),/Max-Age=0/);
    assert.equal((await admin('/api/me')).status,401);
    assert.equal((await admin('/api/members')).status,401);
  } finally {
    await stop();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

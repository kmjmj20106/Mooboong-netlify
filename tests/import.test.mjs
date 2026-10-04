import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../lib/db.mjs';
import { wrapSqlite } from '../lib/database.mjs';
import { hashPassword, verifyPassword } from '../lib/security.mjs';
import { previewImport, applyImport } from '../lib/import.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mooboong-import-'));
  const db = wrapSqlite(openDatabase(dir));
  db.prepare('INSERT INTO members(id,name,password_hash,admin,must_change_password) VALUES(?,?,?,?,0)').run('admin', '운영진', hashPassword('admin-test-strong'), 1);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return db;
}
const member = (overrides = {}) => ({ 아이디:'', 이름:'테스트멤버', 비밀번호:'', 세션:'기타', 기수:'40', 전화번호:'01012345678', 팀:'', 관리자여부:'', ...overrides });
const team = (overrides = {}) => ({ 팀명:'테스트팀', 보컬:'', 기타1:'테스트멤버', 기타2:'', 베이스:'', 드럼:'', 키보드:'', ...overrides });

test('new member defaults, vacant slots, multiple teams, and preview secret exclusion', async t => {
  const db = fixture(t);
  const workbook = { members:[member(), member({ 아이디:'두번째', 이름:'두번째멤버', 비밀번호:'unique-test-password-2026' })], teams:[team(), team({ 팀명:'두번째팀' })] };
  const before = (await previewImport(db, workbook, 'admin'));
  assert.equal(before.valid, true);
  assert.deepEqual(before.summary, { newMembers:2,updatedMembers:0,newTeams:2,updatedTeams:0,unchangedMembers:0,unchangedTeams:0,totalMembers:2,totalTeams:2,errors:0,warnings:0 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM members').get().n, 1);
  assert.equal(JSON.stringify(before).includes('unique-test-password-2026'), false);
  assert.equal(JSON.stringify(before).includes('20000000'), false);
  assert.equal(Object.hasOwn(before.members[0], 'password'), false);
  (await applyImport(db, workbook, 'admin'));
  const saved = db.prepare('SELECT * FROM members WHERE id=?').get('테스트멤버');
  assert.equal(saved.phone, '01012345678');
  assert.equal(saved.must_change_password, 1);
  assert.equal(verifyPassword('20000000', saved.password_hash), true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM team_members').get().n, 2);
  assert.equal(JSON.stringify(db.prepare('SELECT details FROM audit_log').all()).includes('unique-test-password-2026'), false);
});

test('updates preserve blank password and role; missing records are retained', async t => {
  const db = fixture(t);
  (await applyImport(db, {members:[member({ 아이디:'existing', 관리자여부:'Y' }), member({아이디:'untouched',이름:'유지멤버'})],teams:[team({기타1:'existing'})]}, 'admin'));
  const hash = db.prepare('SELECT password_hash FROM members WHERE id=?').get('existing').password_hash;
  (await applyImport(db, {members:[member({아이디:'existing', 이름:'이름변경', 전화번호:''})]}, 'admin'));
  const updated = db.prepare('SELECT * FROM members WHERE id=?').get('existing');
  assert.equal(updated.name, '이름변경');
  assert.equal(updated.password_hash, hash);
  assert.equal(updated.admin, 1);
  assert.equal(updated.phone, '');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM members').get().n, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM teams').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM team_members').get().n, 1);
});

test('invalid IDs, references, admin flags, and lost phone zeros block entire import', async t => {
  const db = fixture(t);
  const input = { members:[member({전화번호:1012345678}),member({관리자여부:'yes'})],teams:[team({보컬:'unknown'})] };
  const result = (await previewImport(db,input,'admin'));
  assert.equal(result.valid,false);
  for (const column of ['아이디','전화번호','관리자여부','보컬']) assert.ok(result.errors.some(e=>e.column===column));
  await assert.rejects(async ()=>(await applyImport(db,input,'admin')),{message:'등록 내용을 다시 확인해 주세요.'});
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM members').get().n,1);
});

test('member team cells are derived and explicit vacancies warn before clearing a slot', async t => {
  const db = fixture(t);
  assert.equal((await previewImport(db,{members:[member({팀:'없는팀'})]},'admin')).valid,true);
  assert.equal((await previewImport(db,{members:[member({팀:'테스트팀'})],teams:[team({기타1:''})]},'admin')).valid,true);
  (await applyImport(db,{members:[member()],teams:[team()]},'admin'));
  const update = {teams:[team({기타1:''})]};
  const preview = (await previewImport(db,update,'admin'));
  assert.equal(preview.valid,true);
  assert.ok(preview.warnings.some(w=>w.message.includes('공석')));
  (await applyImport(db,update,'admin'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM team_members').get().n,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM members').get().n,2);
});

test('self demotion and stale preview permissions cannot be applied', async t => {
  const db = fixture(t);
  assert.equal((await previewImport(db,{members:[member({아이디:'admin',관리자여부:'N'})]},'admin')).valid,false);
  const input = {members:[member()]};
  assert.equal((await previewImport(db,input,'admin')).valid,true);
  db.prepare('UPDATE members SET admin=0 WHERE id=?').run('admin');
  await assert.rejects(async ()=>(await applyImport(db,input,'admin')));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM members').get().n,1);
});

test('database failure rolls back new members, teams, and audit entry', async t => {
  const db = fixture(t);
  db.exec("CREATE TRIGGER fail_team BEFORE INSERT ON teams BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
  await assert.rejects(async ()=>(await applyImport(db,{members:[member()],teams:[team()]},'admin')));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM members').get().n,1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM teams').get().n,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n,0);
});

test('password reset stores hash, forces change, and revokes existing sessions', async t => {
  const db = fixture(t);
  (await applyImport(db,{members:[member()]},'admin'));
  db.prepare('INSERT INTO sessions(token_hash,member_id,expires_at,created_at) VALUES(?,?,?,?)').run('test-session','테스트멤버',9999999999,1);
  (await applyImport(db,{members:[member({비밀번호:'reset-password-123'})]},'admin'));
  assert.equal(verifyPassword('reset-password-123',db.prepare('SELECT password_hash FROM members WHERE id=?').get('테스트멤버').password_hash),true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,0);
  assert.equal(db.prepare('SELECT must_change_password FROM members WHERE id=?').get('테스트멤버').must_change_password,1);
});


test('teams-only imports automatically update existing members and preserve other memberships', async t=>{
  const db=fixture(t);
  (await applyImport(db,{members:[member(),member({아이디:'next',이름:'다음멤버'})]},'admin'));
  const plan=(await previewImport(db,{teams:[team(),team({팀명:'다른팀'})]},'admin'));
  assert.deepEqual(plan.membershipChanges.find(m=>m.id==='테스트멤버').after,['다른팀','테스트팀'].sort());
  assert.equal(db.prepare('SELECT COUNT(*) n FROM team_members').get().n,0);
  (await applyImport(db,{teams:[team(),team({팀명:'다른팀'})]},'admin'));
  (await applyImport(db,{teams:[team({기타1:'next'})]},'admin'));
  const names=id=>db.prepare('SELECT DISTINCT t.name FROM teams t JOIN team_members tm ON tm.team_id=t.id WHERE tm.member_id=? ORDER BY t.name').all(id).map(t=>t.name);
  assert.deepEqual(names('테스트멤버'),['다른팀']);assert.deepEqual(names('next'),['테스트팀']);
  (await applyImport(db,{members:[member({팀:''})]},'admin'));
  assert.deepEqual(names('테스트멤버'),['다른팀']);
});

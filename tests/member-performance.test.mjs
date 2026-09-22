import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../lib/db.mjs';
import { listMembers, listTeams } from '../lib/member-views.mjs';
import { postgresAdapter } from '../lib/database.mjs';

test('member/team queries stay constant as membership grows; roles, vacancies and privacy are preserved', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mooboong-list-test-'));
  const raw = openDatabase(directory);
  let calls = 0;
  const db = { prepare(sql) { calls++; return raw.prepare(sql); } };
  async function lists() {
    calls = 0;
    const members = await listMembers(db);
    const memberQueries = calls;
    calls = 0;
    const teams = await listTeams(db);
    return { members, teams, memberQueries, teamQueries: calls };
  }
  try {
    const empty = await lists();
    assert.deepEqual(empty.members, []); assert.deepEqual(empty.teams, []);
    for (let i = 0; i < 80; i++) raw.prepare('INSERT INTO members(id,name,password_hash,admin,must_change_password) VALUES(?,?,?,?,?)').run('member-'+i, '멤버 '+i, 'test-secret-hash', i===0?1:0, i===0?0:1);
    for (let i = 1; i <= 10; i++) raw.prepare('INSERT INTO teams(name) VALUES(?)').run(i+'팀');
    const first = raw.prepare('SELECT id FROM teams WHERE name=?').get('1팀').id;
    const second = raw.prepare('SELECT id FROM teams WHERE name=?').get('2팀').id;
    raw.prepare('INSERT INTO team_members(team_id,slot,member_id) VALUES(?,?,?)').run(first,'vocal','member-0');
    raw.prepare('INSERT INTO team_members(team_id,slot,member_id) VALUES(?,?,?)').run(first,'guitar1','member-0');
    raw.prepare('INSERT INTO team_members(team_id,slot,member_id) VALUES(?,?,?)').run(second,'drums','member-0');
    const full = await lists();
    assert.equal(full.members.length, 80);
    assert.equal(full.teams.length, 10);
    assert.equal(full.memberQueries, empty.memberQueries, 'list cost must not grow per member');
    assert.equal(full.teamQueries, empty.teamQueries, 'list cost must not grow per team');
    assert.ok(full.memberQueries <= 2 && full.teamQueries <= 2);
    const member = full.members.find(m=>m.id==='member-0');
    assert.equal(member.admin, true); assert.equal(member.mustChangePassword, false);
    assert.deepEqual(member.teams.map(t=>t.name), ['1팀','2팀']);
    assert.equal(full.members.find(m=>m.id==='member-1').teams.length,0);
    assert.ok(!JSON.stringify(full).includes('test-secret-hash'));
    assert.ok(!JSON.stringify(full).includes('password_hash'));
    assert.deepEqual(full.teams.map(t=>t.name), Array.from({length:10},(_,i)=>(i+1)+'팀'));
    const team = full.teams.find(t=>t.id===first);
    assert.equal(team.slots.vocal,'member-0'); assert.equal(team.slots.guitar1,'member-0');
    assert.equal(team.slots.bass,''); assert.equal(team.members.length,2);
    assert.equal(full.teams.find(t=>t.name==='10팀').members.length,0);
    raw.prepare("DELETE FROM team_members WHERE team_id=? AND slot='vocal'").run(first);
    raw.prepare("DELETE FROM team_members WHERE team_id=? AND slot='guitar1'").run(first);
    const changed = await lists();
    assert.deepEqual(changed.members.find(m=>m.id==='member-0').teams.map(t=>t.name),['2팀']);
    assert.equal(changed.teams.find(t=>t.id===first).slots.vocal,'');
  } finally { raw.close(); await rm(directory,{recursive:true,force:true}); }
});

test('PostgreSQL initializes each pooled connection once and retries failed initialization', async()=>{
  const statements=[];
  let releases=0, fail=false;
  const makeClient=()=>({query:async sql=>{statements.push(sql);if(fail){fail=false;throw new Error('test connection failure')}return {rows:[{n:1}],rowCount:1}},release(){releases++}});
  let client=makeClient();
  const db=postgresAdapter({connect:async()=>client,end:async()=>{}});
  await db.prepare('SELECT 1 n').get();
  await db.prepare('SELECT 1 n').get();
  assert.equal(statements.filter(s=>s.startsWith('SET search_path')).length,1);
  client=makeClient(); fail=true;
  await assert.rejects(()=>db.prepare('SELECT 1 n').get(),/test connection failure/);
  await db.prepare('SELECT 1 n').get();
  assert.equal(statements.filter(s=>s.startsWith('SET search_path')).length,3);
  assert.equal(releases,4);
});

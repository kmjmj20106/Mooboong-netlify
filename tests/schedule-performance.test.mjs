import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { postgresAdapter } from '../lib/database.mjs';
import { readSchedule } from '../lib/schedule.mjs';

test('calendar needs one PostgreSQL query, preserves quotas and never includes private member fields', async () => {
  const engine = await PGlite.create();
  try {
    await engine.exec(await readFile(new URL('../schema.sql', import.meta.url),'utf8'));
    await engine.exec(`INSERT INTO members(id,name,password_hash,phone,admin,must_change_password) VALUES
      ('admin','운영진','private-hash','private-phone',1,0),('member','부원','private-hash','private-phone',0,0),('other','다른 부원','private-hash','private-phone',0,0);
      INSERT INTO teams(name) VALUES ('10팀'),('2팀'),('공석팀');
      INSERT INTO team_members(team_id,slot,member_id) VALUES (1,'vocal','member'),(1,'guitar1','member'),(2,'drums','member'),(2,'bass','other');
      INSERT INTO bookings(member_id,team_id,type,date,start_min,end_min,created_by) VALUES
      ('member',NULL,'personal','2026-09-27',480,510,'admin'),
      ('other',NULL,'personal','2026-09-27',510,540,'other'),
      ('admin',1,'team','2026-09-28',600,720,'admin'),
      ('member',1,'team','2026-10-04',600,720,'member');
      INSERT INTO events(title,date,start_min,end_min,created_by) VALUES ('대청소','2026-09-29',720,840,'admin');
      INSERT INTO settings(key,value) VALUES ('teamWeeklyHours','8'),('blockSameDayCancellation','true');`);
    let queries = 0;
    const db = postgresAdapter({connect:async()=>({query:async(sql,args)=>{queries++;return engine.query(sql,args)},release(){}}),end:async()=>{}},{transactionPooler:true});
    const admin = await readSchedule(db,{id:'admin',admin:true},'2026-09-27','2026-10-04',true);
    assert.equal(queries,1);
    assert.equal(admin.rows.length,3); assert.equal(admin.events.length,1);
    assert.equal(admin.rows[0].creator_name,'운영진');
    assert.equal(admin.settings.teamWeeklyHours,8); assert.equal(admin.settings.blockSameDayCancellation,true);
    assert.deepEqual(admin.teams.map(t=>t.name),['2팀','10팀','공석팀']);
    assert.equal(admin.bookingMembers.length,3);
    assert.equal(admin.teams.find(t=>t.name==='공석팀').members.length,0);
    assert.ok(!JSON.stringify(admin).includes('private-'));
    const member = await readSchedule(db,{id:'member',admin:false},'2026-09-27','2026-10-04',true);
    assert.equal(queries,2);
    assert.deepEqual(member.bookingMembers,[]);
    assert.equal(member.usage.personalHours,.5);
    assert.equal(member.usage.teams.length,2,'duplicate member slots cannot duplicate team usage');
    assert.equal(member.usage.teams.find(t=>t.teamId===1).hours,2);
    assert.equal(member.usage.teams.find(t=>t.teamId===2).hours,0);
    const empty = await readSchedule(db,{id:'member',admin:false},'2026-11-01','2026-11-08');
    assert.equal(queries,3); assert.equal(empty.rows.length,0); assert.equal(empty.events.length,0);
    assert.equal(empty.usage.personalHours,0); assert.ok(empty.usage.teams.every(t=>t.hours===0));
    assert.equal(empty.teams,undefined); assert.equal(empty.bookingMembers,undefined);
  } finally { await engine.close(); }
});

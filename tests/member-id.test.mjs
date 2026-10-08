import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';import {openDatabase} from '../lib/db.mjs';import {wrapSqlite,postgresAdapter} from '../lib/database.mjs';import {changeMemberId} from '../lib/member-id.mjs';
for(const dialect of ['sqlite','postgres'])test(`${dialect}: ID change preserves ownership, quotas and privileges and revokes sessions`,async()=>{
 let db,engine,dir;
 if(dialect==='sqlite'){dir=await mkdtemp(join(tmpdir(),'mooboong-id-'));db=wrapSqlite(openDatabase(dir))}else{engine=await PGlite.create();await engine.exec(await readFile(new URL('../schema.sql',import.meta.url),'utf8'));db=postgresAdapter({connect:async()=>({query:(s,a)=>engine.query(s,a),release(){}}),end:async()=>{}},{transactionPooler:true})}
 try{
 await db.prepare('INSERT INTO members(id,name,password_hash,admin,super_admin) VALUES(?,?,?,1,1)').run('old','실명','unchanged-hash');
 await db.prepare('INSERT INTO teams(name) VALUES(?)').run('팀');await db.prepare("INSERT INTO team_members(team_id,slot,member_id) VALUES(1,'vocal','old')").run();
 await db.prepare("INSERT INTO bookings(member_id,type,date,start_min,end_min,created_by) VALUES('old','personal','2026-10-20',600,660,'old')").run();
 await db.prepare("INSERT INTO events(title,date,start_min,end_min,created_by) VALUES('청소','2026-10-21',600,660,'old')").run();
 await db.prepare("INSERT INTO posts(kind,title,body,author_id) VALUES('notice','공지','본문','old')").run();
 await db.prepare("INSERT INTO sessions(token_hash,member_id,expires_at,created_at) VALUES('token','old',9999999999999,0)").run();
 await db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').run('quotaOverrides','[]');await db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify([{type:'personal',id:'old',hours:2}]),'quotaOverrides');
 await assert.rejects(db.transaction(()=>changeMemberId(db,{id:'old'},'old')));assert.ok(await db.prepare("SELECT id FROM members WHERE id='old'").get());
 await db.transaction(()=>changeMemberId(db,{id:'old',name:'실명'},'new'));
 const m=await db.prepare("SELECT * FROM members WHERE id='new'").get();assert.equal(m.name,'실명');assert.equal(m.password_hash,'unchanged-hash');assert.equal(m.super_admin,1);assert.equal(await db.prepare("SELECT id FROM members WHERE id='old'").get(),undefined);
 for(const [table,column]of [['team_members','member_id'],['bookings','member_id'],['bookings','created_by'],['events','created_by'],['posts','author_id']])assert.equal((await db.prepare(`SELECT ${column} AS owner FROM ${table}`).get()).owner,'new');
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).n,0);assert.equal(JSON.parse((await db.prepare("SELECT value FROM settings WHERE key='quotaOverrides'").get()).value)[0].id,'new');
 }finally{if(engine)await engine.close();else{db.close();await rm(dir,{recursive:true,force:true})}}
});

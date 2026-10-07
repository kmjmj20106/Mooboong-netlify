import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
test('migration promotes only the verified account and recovers event groups from audit IDs',async()=>{
 const db=await PGlite.create();try{const sql=await readFile(new URL('../schema.sql',import.meta.url),'utf8');await db.exec(sql);
 await db.exec(`INSERT INTO members(id,name,password_hash,admin) VALUES('mooboong','김무붕','hash',1),('other','김무붕','hash',0);
 INSERT INTO events(title,description,date,start_min,end_min,created_by) VALUES('동일 제목','','2026-10-10',600,660,'mooboong'),('동일 제목','','2026-10-17',600,660,'mooboong'),('동일 제목','','2026-10-24',600,660,'mooboong');
 INSERT INTO audit_log(actor_id,action,details) VALUES('mooboong','event.create','{"eventIds":[1,2],"repeatUntil":"2026-10-17"}');`);
 await db.exec(sql);
 const members=(await db.query('SELECT id,super_admin FROM members ORDER BY id')).rows;assert.equal(members.find(m=>m.id==='mooboong').super_admin,1);assert.equal(members.find(m=>m.id==='other').super_admin,0);
 const events=(await db.query('SELECT id,series_id FROM events ORDER BY id')).rows;assert.ok(events[0].series_id);assert.equal(events[0].series_id,events[1].series_id);assert.equal(events[2].series_id,null);
 }finally{await db.close()}
});

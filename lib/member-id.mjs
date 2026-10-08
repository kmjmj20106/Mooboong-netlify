import {audit,getSettings} from './db.mjs';
export async function changeMemberId(db,member,newId){
 if(await db.prepare('SELECT id FROM members WHERE id=?').get(newId)){const e=new Error('이미 사용 중인 아이디입니다.');e.status=409;throw e}
 // Copy before moving foreign keys, so referential integrity stays enabled throughout.
 await db.prepare(`INSERT INTO members(id,name,password_hash,session,generation,phone,admin,super_admin,must_change_password,created_at,updated_at)
 SELECT ?,name,password_hash,session,generation,phone,admin,super_admin,must_change_password,created_at,updated_at FROM members WHERE id=?`).run(newId,member.id);
 for(const [table,column]of [['team_members','member_id'],['bookings','member_id'],['bookings','created_by'],['events','created_by'],['posts','author_id'],['audit_log','actor_id']])await db.prepare(`UPDATE ${table} SET ${column}=? WHERE ${column}=?`).run(newId,member.id);
 const settings=await getSettings(db);let changed=false;
 for(const rule of settings.quotaOverrides){if(rule.type==='personal'&&rule.id===member.id){rule.id=newId;changed=true}}
 if(changed)await db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(settings.quotaOverrides),'quotaOverrides');
 await db.prepare('DELETE FROM sessions WHERE member_id=?').run(member.id);
 await db.prepare('DELETE FROM members WHERE id=?').run(member.id);
 await audit(db,newId,'profile.id_change',{previousId:member.id,id:newId,name:member.name});
}

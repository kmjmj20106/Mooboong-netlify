import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { connectDatabase } from './lib/database.mjs';

const tables = ['members','teams','team_members','bookings','events','posts','attachments','wiki_assets','settings','audit_log'];
const identities = ['teams','bookings','events','posts','attachments','audit_log'];
const [mode, filename, sqliteFile] = process.argv.slice(2);
if (!['export','import'].includes(mode) || !filename) {
  console.error('내보내기: node transfer-data.mjs export 백업.json [기존SQLite파일]\n가져오기: node --env-file=.env transfer-data.mjs import 백업.json (빈 Supabase DB에만 가능)');
  process.exit(1);
}
if (mode === 'import' && !process.env.DATABASE_URL) throw new Error('가져오기는 DATABASE_URL이 설정된 빈 PostgreSQL DB에만 가능합니다.');
let db;
try {
  if (mode === 'export') {
    if(sqliteFile){
      const raw=new DatabaseSync(resolve(sqliteFile),{readOnly:true});
      db={prepare:sql=>raw.prepare(sql),transaction:async work=>{raw.exec('BEGIN');try{const result=await work();raw.exec('COMMIT');return result}catch(e){raw.exec('ROLLBACK');throw e}},close:()=>raw.close()};
    }else db=await connectDatabase(resolve(process.env.DATA_DIR||new URL('./data',import.meta.url).pathname));
    const backup=await db.transaction(async()=>{
      const data={};
      for(const table of tables){
        // Legacy SQLite files predate custom events and must remain exportable.
        if (sqliteFile && table === 'events' && !db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events'").get()) { data.events = []; continue; }
        data[table]=(await db.prepare(`SELECT * FROM ${table}`).all()).map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key,value instanceof Uint8Array?{base64:Buffer.from(value).toString('base64')}:value])));
      }
      return {format:'mooboong-backup-v1',createdAt:new Date().toISOString(),data};
    });
    await writeFile(resolve(filename),JSON.stringify(backup),{mode:0o600,flag:'wx'});
    console.log('백업 저장 완료. 계정·전화번호·첨부파일이 포함되므로 비공개로 보관하세요.');
  }else{
    const backup=JSON.parse(await readFile(resolve(filename),'utf8'));
    // v1 backups created before custom schedules have no events collection.
    if (backup.data && backup.data.events === undefined) backup.data.events = [];
    if(backup.format!=='mooboong-backup-v1'||!backup.data||!tables.every(t=>Array.isArray(backup.data[t])))throw new Error('무붕 백업 형식이 아닙니다.');
    db=await connectDatabase('');
    await db.transaction(async()=>{
      for(const table of tables.filter(t=>t!=='settings'))if((await db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()).n)throw new Error('대상 DB가 비어 있지 않습니다. 기존 데이터를 덮어쓰지 않았습니다.');
      await db.prepare('DELETE FROM settings').run();
      for(const table of tables){
        const allowed=new Set((await db.prepare("SELECT column_name FROM information_schema.columns WHERE table_schema='mooboong' AND table_name=?").all(table)).map(x=>x.column_name));
        for(const row of backup.data[table]){
          const columns=Object.keys(row);
          if(!columns.length||!columns.every(c=>allowed.has(c)&&/^[a-z_]+$/.test(c)))throw new Error(`지원하지 않는 백업 열: ${table}`);
          const values=columns.map(c=>c==='content'&&row[c]?.base64!==undefined?Buffer.from(row[c].base64,'base64'):row[c]);
          await db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(...values);
        }
      }
      for(const table of identities)await db.exec(`SELECT setval(pg_get_serial_sequence('mooboong.${table}','id'),COALESCE((SELECT MAX(id) FROM ${table}),1),(SELECT COUNT(*)>0 FROM ${table}))`);
    });
    console.log('가져오기 완료. 기존 계정으로 다시 로그인하세요.');
  }
}finally{if(db)await db.close();}

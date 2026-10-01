import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { postgresAdapter, initializePostgres } from '../lib/database.mjs';
import { sourceUrl, notionEmbedUrl } from '../lib/content.mjs';

test('Notion URLs and official embed code use only the published Notion frame origin',()=>{
  const page='https://band.notion.site/Flow8-1357c1da089c43898a054f246ada19a2?pvs=74';
  const embed='https://band.notion.site/ebd/1357c1da089c43898a054f246ada19a2?show_page_title=true';
  assert.equal(notionEmbedUrl(page),embed);
  assert.equal(notionEmbedUrl(sourceUrl(`<iframe src="${embed}" onload="alert(1)"></iframe>`)),embed);
  for(const u of ['javascript:alert(1)','https://notion.site.evil.example/1357c1da089c43898a054f246ada19a2','https://band.notion.site@evil.example/1357c1da089c43898a054f246ada19a2','https://band.notion.site:123/1357c1da089c43898a054f246ada19a2'])assert.equal(notionEmbedUrl(u),'');
  assert.throws(()=>sourceUrl('<iframe src="https://evil.example"></iframe>'));
});

test('existing Netlify v1 databases migrate once without changing reservations or member data',async()=>{
  const engine=await PGlite.create();const old=process.env.NETLIFY;process.env.NETLIFY='true';
  try{
    const schema=await readFile(new URL('../schema.sql',import.meta.url),'utf8');
    await engine.exec(schema.replace("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS display_name TEXT NOT NULL DEFAULT '';",''));
    await engine.exec(`CREATE TABLE mooboong.netlify_schema_v1 (version INTEGER PRIMARY KEY);
      INSERT INTO members(id,name,password_hash,admin) VALUES ('admin','운영진','original-hash',1);
      INSERT INTO bookings(member_id,type,date,start_min,end_min,created_by) VALUES ('admin','personal','2026-10-02',600,660,'admin');`);
    let count=0;
    const db=postgresAdapter({connect:async()=>({query:async(sql,args)=>{count++;return sql.includes(';') ? (await engine.exec(sql)).at(-1) : engine.query(sql,args)},release(){}}),end:async()=>{}},{transactionPooler:true});
    await initializePostgres(db);
    const booking=(await engine.query('SELECT * FROM mooboong.bookings')).rows[0];
    assert.equal(booking.display_name,'');assert.equal(booking.member_id,'admin');assert.equal(booking.start_min,600);
    assert.equal((await engine.query('SELECT password_hash FROM mooboong.members')).rows[0].password_hash,'original-hash');
    count=0;await initializePostgres(db);assert.equal(count,1,'warm schema check performs no DDL');
  }finally{if(old===undefined)delete process.env.NETLIFY;else process.env.NETLIFY=old;await engine.close()}
});

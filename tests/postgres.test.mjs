import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { Pool } from 'pg';
import { postgresAdapter, initializePostgres } from '../lib/database.mjs';

test('PostgreSQL protocol: PGlite HTTP suite, empty-disk restart and transactions', {timeout:90000}, async()=>{
  const directory=await mkdtemp(join(tmpdir(),'mooboong-pg-test-'));
  const port=54327;
  const engine=await PGlite.create();
  const pg=new PGLiteSocketServer({db:engine,port,host:'127.0.0.1',maxConnections:10});
  let started=false;
  const connectionString=`postgresql://postgres:test-only-password@127.0.0.1:${port}/postgres`;
  try {
    await pg.start();started=true;
    const a=postgresAdapter(new Pool({connectionString,max:3}));
    const b=postgresAdapter(new Pool({connectionString,max:3}));
    try {
      await initializePostgres(a);
      const insertOnce=db=>db.transaction(async()=>{
        const exists=await db.prepare('SELECT id FROM teams WHERE name=?').get('동시등록');
        if(exists)return false;
        await new Promise(resolve=>setTimeout(resolve,35));
        await db.prepare('INSERT INTO teams(name) VALUES(?)').run('동시등록');return true;
      });
      assert.deepEqual((await Promise.all([insertOnce(a),insertOnce(b)])).sort(),[false,true]);
      await a.prepare('DELETE FROM teams WHERE name=?').run('동시등록');
    } finally {await a.close();await b.close();}
    const result=await new Promise((resolvePromise,reject)=>{
      const childEnv={...process.env,TEST_DATABASE_URL:connectionString,BASE_URL:'http://127.0.0.1:4322'};delete childEnv.NODE_TEST_CONTEXT;
      const child=spawn(process.execPath,['--test','--test-reporter=tap','tests/http.test.mjs'],{cwd:resolve(import.meta.dirname,'..'),env:childEnv,stdio:['ignore','pipe','pipe']});
      let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
      const timer=setTimeout(()=>{child.kill('SIGTERM');reject(new Error('PostgreSQL HTTP suite timed out'));},60000);
      child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);resolvePromise({code,output})});
    });
    assert.equal(result.code,0,result.output);
    assert.match(result.output,/# pass 1/,result.output);
    const runTransfer=args=>new Promise((done,reject)=>{
      const childEnv={...process.env,DATABASE_URL:connectionString};delete childEnv.NODE_TEST_CONTEXT;
      const child=spawn(process.execPath,['transfer-data.mjs',...args],{cwd:resolve(import.meta.dirname,'..'),env:childEnv,stdio:['ignore','pipe','pipe']});
      let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
      child.on('error',reject);child.on('exit',code=>done({code,output}));
    });
    const backupFile=join(directory,'roundtrip.backup.json');
    const exported=await runTransfer(['export',backupFile]);
    assert.equal(exported.code,0,exported.output);
    const original=JSON.parse(await readFile(backupFile,'utf8'));
    assert.equal(original.data.members.length,2);
    assert.equal(original.data.events.length,1);
    assert.equal(original.data.events[0].title,'면접');
    assert.ok(original.data.attachments.length>0);
    assert.ok(original.data.attachments[0].content.base64);
    assert.ok(!JSON.stringify(original.data.audit_log).includes('TemporaryPassword123!'));
    const refused=await runTransfer(['import',backupFile]);
    assert.notEqual(refused.code,0,'restoring into populated database must fail');
    assert.match(refused.output,/비어 있지/);
    // This is the isolated in-memory test database, never a user database.
    await engine.exec('DROP SCHEMA mooboong CASCADE');
    const restored=await runTransfer(['import',backupFile]);
    assert.equal(restored.code,0,restored.output);
    const roundtripFile=join(directory,'restored.backup.json');
    assert.equal((await runTransfer(['export',roundtripFile])).code,0);
    const restoredData=JSON.parse(await readFile(roundtripFile,'utf8')).data;
    for(const table of Object.keys(original.data))assert.deepEqual(restoredData[table],original.data[table],table);
    const next=await engine.query("INSERT INTO mooboong.teams(name) VALUES('복원 후 새 팀') RETURNING id");
    assert.ok(next.rows[0].id>Math.max(...original.data.teams.map(t=>t.id)));
    // Older v1 backups contain no events field and remain supported.
    const {writeFile}=await import('node:fs/promises');
    const legacy=structuredClone(original);delete legacy.data.events;
    const legacyFile=join(directory,'legacy.backup.json');
    await writeFile(legacyFile,JSON.stringify(legacy));
    await engine.exec('DROP SCHEMA mooboong CASCADE');
    const legacyRestore=await runTransfer(['import',legacyFile]);
    assert.equal(legacyRestore.code,0,legacyRestore.output);
    assert.equal((await engine.query('SELECT COUNT(*) n FROM mooboong.events')).rows[0].n,0);
  } finally {
    if(started)await pg.stop();
    await new Promise(resolve=>setImmediate(resolve)); await engine.runExclusive(async()=>{}); await new Promise(resolve=>setImmediate(resolve)); await engine.close();
    await rm(directory,{recursive:true,force:true});
  }
});

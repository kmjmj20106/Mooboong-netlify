import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const root=resolve(import.meta.dirname,'..');
const origin='https://mooboong-test.onrender.com';
const base='http://127.0.0.1:4323';
function launch(extra){
  const env={...process.env,NODE_ENV:'production',HOST:'127.0.0.1',PORT:'4323',APP_ORIGIN:'',RENDER_EXTERNAL_URL:origin,RENDER:'true',DATABASE_URL:'',SETUP_TOKEN:'test-only-setup-token-123456789',...extra};
  delete env.NODE_TEST_CONTEXT;
  const child=spawn(process.execPath,['server.mjs'],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  return child;
}
async function stop(child){
  if(!child||child.exitCode!==null)return;
  await new Promise(resolve=>{child.once('exit',resolve);child.kill('SIGTERM')});
}

test('production refuses missing DATABASE_URL and secures Render setup', {timeout:30000}, async()=>{
  const missing=launch({});
  const denied=await new Promise((done,reject)=>{
    let output='';missing.stderr.on('data',d=>output+=d);missing.on('error',reject);missing.once('exit',code=>done({code,output}));
  });
  assert.notEqual(denied.code,0);
  assert.match(denied.output,/DATABASE_URL이 없습니다/);
  const engine=await PGlite.create();
  const socket=new PGLiteSocketServer({db:engine,port:54328,host:'127.0.0.1',maxConnections:10});
  let child;
  try{
    await socket.start();
    child=launch({DATABASE_URL:'postgresql://postgres:test-only@127.0.0.1:54328/postgres'});
    await new Promise((done,reject)=>{
      let output='';const timer=setTimeout(()=>reject(new Error('Production startup timeout: '+output)),10000);
      child.stderr.on('data',d=>output+=d);
      child.on('error',e=>{clearTimeout(timer);reject(e)});
      child.once('exit',code=>{clearTimeout(timer);reject(new Error(`Production exited ${code}: ${output}`))});
      child.stdout.on('data',d=>{if(String(d).includes('http://127.0.0.1:')){clearTimeout(timer);done()}});
    });
    const status=await (await fetch(base+'/api/status')).json();
    assert.equal(status.storage,'postgres');assert.equal(status.setupTokenRequired,true);
    const setup=async(token,requestOrigin=origin)=>fetch(base+'/api/setup',{method:'POST',headers:{'Content-Type':'application/json','X-Mooboong-Request':'1',Origin:requestOrigin},body:JSON.stringify({id:'production-admin',name:'테스트 운영진',password:'ProductionAdmin123!',setupToken:token})});
    assert.equal((await setup('wrong')).status,403);
    assert.equal((await setup('test-only-setup-token-123456789','https://wrong.invalid')).status,403);
    const response=await setup('test-only-setup-token-123456789');
    assert.equal(response.status,201,await response.text());
    assert.match(response.headers.get('set-cookie'),/; Secure/);
    assert.match(response.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
  }finally{await stop(child);await socket.stop();await new Promise(resolve=>setImmediate(resolve)); await engine.runExclusive(async()=>{}); await new Promise(resolve=>setImmediate(resolve)); await engine.close()}
});

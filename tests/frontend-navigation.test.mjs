import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

test('browser splits large uploads, preserves metadata and stops after a failed chunk',async()=>{
  const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const code=source.slice(source.indexOf('async function api('),source.indexOf('\nfunction button('));
  const calls=[];let failChunk=false;
  const context=vm.createContext({ArrayBuffer,Uint8Array,S:{cache:new Map()},fetch:async(path,options)=>{
    calls.push({path,...options});const failed=failChunk&&path.endsWith('/1');
    return {ok:!failed,status:failed?400:200,json:async()=>failed?{error:'upload failed'}:path==='/api/uploads'?{token:'upload-token'}:{ok:true}};
  }});
  vm.runInContext(code,context);
  await vm.runInContext("api('/wiki/import',{method:'POST',raw:true,body:new Uint8Array(4*1024*1024+9).buffer,headers:{'Content-Type':'application/octet-stream','X-Entry':'page.html'}})",context);
  assert.equal(calls.filter(c=>c.method==='PUT').length,5);
  for(const c of calls.filter(c=>c.method==='PUT')){assert.ok(c.body.byteLength<=1024*1024);assert.equal(c.credentials,'same-origin');assert.equal(c.headers['X-Mooboong-Request'],'1');}
  const last=calls.at(-1);assert.equal(last.path,'/api/wiki/import');assert.equal(last.body,undefined);assert.equal(last.headers['X-Entry'],'page.html');assert.equal(last.headers['X-Upload-Token'],'upload-token');
  calls.length=0;failChunk=true;
  await assert.rejects(vm.runInContext("api('/wiki/import',{method:'POST',raw:true,body:new Uint8Array(4*1024*1024).buffer})",context),/upload failed/);
  assert.ok(!calls.some(c=>c.path==='/api/wiki/import'));
});

test('cached navigation paints before network, preserves unchanged view and ignores logout-era responses',async()=>{
  const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const code=source.slice(source.indexOf('function renderRoute('),source.indexOf('\nfunction renderMembers('));
  const nodes={'#main':{innerHTML:'previous screen'},'#route-sync':{hidden:true}};
  const old={members:[{id:'a',name:'멤버'}],teams:[]};
  const state={me:{id:'admin',admin:true},request:0,route:'schedule',week:'2026-09-20',renderedKey:'schedule:2026-09-20',cache:new Map([['members',old]])};
  let paints=0,loads=[];
  const context=vm.createContext({S:state,location:{hash:'#members'},names:{members:'멤버',schedule:'예약'},$:s=>nodes[s],setTimeout,clearTimeout,
    shell(){nodes['#main'].innerHTML='initial loading'},
    renderMembers(){paints++;nodes['#main'].innerHTML='member list'},
    api(path){return new Promise(resolve=>loads.push({path,resolve}))},
    renderSchedule(){},renderGuide(){},renderSettings(){},renderPosts(){},refreshMemberTable(){},toast(){},esc:String,button(){return ''},
  });
  vm.runInContext(code,context);
  const first=vm.runInContext('navigate()',context);
  assert.equal(nodes['#main'].innerHTML,'member list','cached content appears while both requests are pending');
  assert.equal(paints,1);
  for(const load of loads)load.resolve(load.path==='/members'?{members:old.members}:{teams:old.teams});
  await first;
  assert.equal(paints,1,'unchanged refresh does not replace the visible DOM');
  loads=[];
  const second=vm.runInContext('navigate()',context);
  assert.equal(nodes['#main'].innerHTML,'member list','same-route reload keeps the current view');
  state.me=null;state.request++;state.cache.clear();nodes['#main'].innerHTML='login';
  for(const load of loads)load.resolve(load.path==='/members'?{members:old.members}:{teams:old.teams});
  await second;
  assert.equal(nodes['#main'].innerHTML,'login');assert.equal(state.cache.size,0);
});

test('schedule navigation obtains timetable, teams and admin booking options in one request',async()=>{
  const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const code=source.slice(source.indexOf('function renderRoute('),source.indexOf('\nfunction renderMembers('));
  const nodes={'#main':{innerHTML:''},'#route-sync':{hidden:true}};
  const payload={bookings:[],teams:[{id:1,name:'밴드',members:[]}],bookingMembers:[{id:'admin',name:'운영진'}],settings:{},usage:{personalHours:0,teams:[]}};
  const state={me:{id:'admin',admin:true},request:0,week:'2026-09-27',cache:new Map()};
  const calls=[];let paints=0;
  const context=vm.createContext({S:state,location:{hash:'#schedule'},names:{schedule:'예약'},$:s=>nodes[s],setTimeout,clearTimeout,
    shell(){},renderSchedule(){paints++},api:async path=>{calls.push(path);return payload},renderMembers(){},renderGuide(){},renderSettings(){},renderPosts(){},refreshMemberTable(){},toast(){},esc:String,button(){return ''},
  });
  vm.runInContext(code,context);
  await vm.runInContext('navigate()',context);
  assert.deepEqual(calls,['/schedule?week=2026-09-27']);assert.equal(paints,1);
  assert.equal(state.bookingData,payload);assert.equal(state.teams,payload.teams);
});

test('admin booking dialog opens immediately using calendar options without another member request',async()=>{
  const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const code=source.slice(source.indexOf('async function bookingModal('),source.indexOf('\nfunction readPost('));
  let shown=false,preview=false;const calls=[];
  const context=vm.createContext({S:{me:{id:'admin',admin:true},teams:[],bookingData:{settings:{},bookingMembers:[{id:'admin',name:'운영진'}]}},
    today:()=> '2026-09-29',addDays:()=> '2027-09-30',api:path=>{calls.push(path);return new Promise(()=>{})},
    showModal(){shown=true},updateBookingPreview(){preview=true},select:()=>'',field:()=>'',button:()=>'',icon:()=>'',esc:String,
  });
  vm.runInContext(code,context);
  const pending=vm.runInContext('bookingModal()',context);
  assert.equal(shown,true);assert.equal(preview,true);assert.deepEqual(calls,[]);await pending;
});

test('bootstrap data paints the first calendar without fetching it again',async()=>{
  const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const code=source.slice(source.indexOf('function renderRoute('),source.indexOf('\nfunction renderMembers('));
  const nodes={'#main':{innerHTML:''},'#route-sync':{hidden:true}};
  const data={bookingData:{settings:{},usage:{}},bookings:[],teams:[]};let paints=0;
  const context=vm.createContext({S:{me:{admin:true},request:0,week:'2026-09-27',cache:new Map()},initial:{key:'schedule:2026-09-27',data},location:{hash:'#schedule'},names:{schedule:'예약'},$:s=>nodes[s],setTimeout,clearTimeout,
    shell(){},renderSchedule(){paints++},api(){throw Error('unnecessary first-screen fetch')},renderMembers(){},renderGuide(){},renderSettings(){},renderPosts(){},refreshMemberTable(){},toast(){},esc:String,button(){return ''},
  });
  vm.runInContext(code,context);await vm.runInContext('navigate(initial)',context);assert.equal(paints,1);
});

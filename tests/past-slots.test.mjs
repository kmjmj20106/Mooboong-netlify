import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
test('past slots are gray and unavailable while existing booking details remain accessible',async()=>{
 const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
 const grid=source.slice(source.indexOf('function weeklyGrid('),source.indexOf('\nfunction ',source.indexOf('function weeklyGrid(')+1));
 const context=vm.createContext({calendarNow:()=>({date:'2026-10-07',minute:630}),minutes:t=>Number(t.slice(0,2))*60+Number(t.slice(3)),addDays:(d,n)=>new Date(Date.parse(d+'T12:00:00Z')+n*864e5).toISOString().slice(0,10),esc:String});vm.runInContext(grid,context);
 context.bookings=[{id:1,date:'2026-10-07',start:'09:00',end:'10:00',memberName:'부원',type:'personal'}];
 for(const preview of [false,true]){
 const html=vm.runInContext(`weeklyGrid(bookings,'2026-10-04',${preview})`,context),dom=new JSDOM(html),d=dom.window.document;
 const cell=(date,time)=>d.querySelector(`[data-date="${date}"][data-time="${time}"]`);
 assert.ok(cell('2026-10-06','23:30').disabled);assert.ok(cell('2026-10-07','10:30').disabled);assert.ok(cell('2026-10-07','10:30').classList.contains('past-slot'));assert.equal(cell('2026-10-07','11:00').disabled,false);assert.equal(cell('2026-10-08','08:00').disabled,false);assert.equal(cell('2026-10-07','09:00').disabled,preview);dom.window.close();
 }
});

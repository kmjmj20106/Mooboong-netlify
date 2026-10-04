import {readFile,writeFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const functions=['field','authScreen'];
let code="const esc=v=>String(v??'').replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]));const icon=name=>`<i data-lucide=\"${name}\"></i>`;";
for(const name of functions){const start=source.indexOf('function '+name+'('),end=source.indexOf('\nfunction ',start+1);code+=source.slice(start,end)+'\n';}
const app={innerHTML:''};vm.runInNewContext(code+'authScreen()',{$:()=>app,S:{cache:new Map()},icons(){}});
const path=new URL('../public/index.html',import.meta.url);let html=await readFile(path,'utf8');
html=html.replace(/<div id="app">[\s\S]*?<div id="toast"/,`<div id="app">${app.innerHTML}</div><div id="toast"`);
await writeFile(path,html);

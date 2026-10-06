import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {postgresAdapter} from '../lib/database.mjs';
import {JSDOM} from 'jsdom';

test('notice query includes attachment metadata in one PostgreSQL round trip',async()=>{
 const engine=await PGlite.create();try{
 await engine.exec(await readFile(new URL('../schema.sql',import.meta.url),'utf8'));
 await engine.exec(`INSERT INTO members(id,name,password_hash,admin) VALUES('a','작성자','secret',1);
 INSERT INTO posts(kind,title,body,author_id) VALUES('notice','Markdown','| 표 |','a'),('wiki','기존','내용','a');
 INSERT INTO attachments(post_id,name,mime,content) VALUES(1,'test.txt','text/plain',decode('616263','hex'));`);
 let calls=0;const db=postgresAdapter({connect:async()=>({query:async(sql,args)=>{calls++;return engine.query(sql,args)},release(){}}),end:async()=>{}},{transactionPooler:true});
 const source=await readFile(new URL('../server.mjs',import.meta.url),'utf8');
 const select=source.slice(source.indexOf('const postSelect ='),source.indexOf('async function listPosts('));
 const fn=source.slice(source.indexOf('async function listPosts('),source.indexOf('function validatePost('));
 const context=vm.createContext({db,postView:async(row,attachments)=>({...row,attachments})});vm.runInContext(select+fn,context);
 const posts=await vm.runInContext('listPosts()',context);assert.equal(calls,1);assert.equal(posts.length,2);assert.equal(posts.find(p=>p.title==='Markdown').attachments[0].size,3);assert.ok(!JSON.stringify(posts).includes('secret'));
 calls=0;assert.equal((await vm.runInContext("listPosts('notice')",context)).length,1);assert.equal(calls,1);
 }finally{await engine.close()}
});

test('Markdown supports tables, nested lists, tasks, code and blocks unsafe markup',async()=>{
 const dom=new JSDOM('',{runScripts:'outside-only'});dom.window.eval(await readFile(new URL('../public/markdown.js',import.meta.url),'utf8'));
 const html=dom.window.renderMarkdown('# 안내\n\n|항목|내용|\n|---|---|\n|합주|예약|\n\n- [x] 완료\n- 목록\n  - 하위\n\n```js\n<script>alert(1)</script>\n```\n\n[x](javascript:alert(1))\n<img src=x onerror=alert(1)>');
 const holder=dom.window.document.createElement('div');holder.innerHTML=html;
 assert.equal(holder.querySelectorAll('table').length,1);assert.ok(holder.querySelector('input[disabled][checked]'));assert.ok(holder.querySelector('li ul li'));assert.ok(holder.querySelector('pre code'));assert.equal(holder.querySelectorAll('script,img,[onerror],a[href^="javascript:"]').length,0);dom.window.close();
});

test('Markdown import fills a draft without saving and rejects overlong contents',async()=>{
 const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');const code=source.slice(source.indexOf('function updateMarkdownPreview()'),source.indexOf('let markdownLoading;'));
 const nodes={'#body':{value:''},'#markdown-preview':{hidden:true},'#post-error':{textContent:''}};nodes['#post-form']={title:{value:''},sourceUrl:{value:'https://old.notion.site'}};
 const c=vm.createContext({S:{viewPost:null},$:s=>nodes[s],TextDecoder,window:{renderMarkdown:s=>s},file:{name:'안내.md',size:30,arrayBuffer:async()=>new TextEncoder().encode('# 새 안내\n\n**내용**').buffer}});vm.runInContext(code,c);await vm.runInContext('importMarkdown(file)',c);
 assert.equal(nodes['#post-form'].title.value,'새 안내');assert.equal(nodes['#post-form'].sourceUrl.value,'');assert.equal(nodes['#markdown-preview'].hidden,false);assert.match(nodes['#body'].value,/내용/);
 c.file={name:'too-long.md',size:31000,arrayBuffer:async()=>new TextEncoder().encode('a'.repeat(30001)).buffer};await vm.runInContext('importMarkdown(file)',c);assert.match(nodes['#post-error'].textContent,/30,000/);assert.match(nodes['#body'].value,/내용/);
});

test('full notice app opens Markdown editor, previews a table and shows bootstrap posts without another fetch',async()=>{
 const dom=new JSDOM('<div id="app"></div><div id="modal-root"></div><div id="toast"></div>',{url:'https://example.test/#notice',runScripts:'outside-only'});const w=dom.window;let calls=[];
 w.matchMedia=()=>({matches:false,addEventListener(){}});w.lucide={createIcons(){}};
 w.fetch=async(path)=>{calls.push(path);return {ok:true,json:async()=>({member:{id:'admin',name:'관리자',admin:true},initial:{key:'notice',data:{posts:[]}}})}};
 w.eval(await readFile(new URL('../public/markdown.js',import.meta.url),'utf8'));
 w.eval(await readFile(new URL('../public/app.js',import.meta.url),'utf8'));
 await new Promise(r=>setTimeout(r,25));assert.equal(calls.length,1);assert.match(w.document.querySelector('#main').textContent,/공지/);
 w.document.querySelector('[data-action="new-post"]').click();
 assert.ok(w.document.querySelector('#markdown-file'));const body=w.document.querySelector('#body');body.value='| 항목 | 내용 |\n|---|---|\n| 합주 | 예약 |';
 w.document.querySelector('[data-action="markdown-preview"]').click();assert.ok(w.document.querySelector('#markdown-preview table'));
 assert.ok(w.document.querySelector('#post-files'));assert.ok(w.document.querySelector('[name="sourceUrl"]'));
 dom.window.close();
});

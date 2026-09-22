import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { zipSync } from 'fflate';
import { parseXlsx, buildWorkbook } from '../lib/workbook.mjs';
import { parseNotion } from '../lib/notion.mjs';
import { readArchive } from '../lib/archive.mjs';
import { MEMBER_HEADERS } from '../lib/import.mjs';

const zip=files=>Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name,value])=>[name,Buffer.isBuffer(value)?value:Buffer.from(value)]))));
const ns='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
function workbook(rows,headers=MEMBER_HEADERS){return zip({
  'xl/workbook.xml':`<workbook xmlns="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="멤버" r:id="rId1"/></sheets></workbook>`,
  'xl/_rels/workbook.xml.rels':'<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
  'xl/worksheets/sheet1.xml':`<worksheet xmlns="${ns}"><sheetData><row r="1">${headers.map((name,i)=>`<c r="${String.fromCharCode(65+i)}1" t="inlineStr"><is><t>${name}</t></is></c>`).join('')}</row>${rows}</sheetData></worksheet>`,
});}
test('JavaScript Excel reader agrees with the previous reader and keeps the supplied template unchanged',async()=>{
  const template=await readFile(new URL('../public/templates/mooboong-import.xlsx',import.meta.url));
  const payload={members:[{id:'=literal',name:'이름 & <문자> 🎸',session:'보컬',generation:'01',phone:'01012345678',admin:true,teams:[{name:'팀 A'}]}],teams:[{name:'팀 A',slots:{vocal:'=literal'}}]};
  const exported=await buildWorkbook(payload);
  const files=[template,exported,workbook('<row r="8"><c r="B8" t="inlineStr"><is><t>테스트</t></is></c><c r="F8" t="inlineStr"><is><t>01012345678</t></is></c></row>'),workbook('<row r="2"><c r="F2"><v>1012345678</v></c></row>')];
  for(const file of files){
    const expected=JSON.parse(execFileSync('python3',['lib/read_xlsx.py','-'],{cwd:new URL('..',import.meta.url),input:file}));
    assert.deepEqual(await parseXlsx(file),expected);
  }
  const parsed=await parseXlsx(exported);assert.equal(parsed.members[0]['비밀번호'],'');assert.equal(parsed.members[0]['아이디'],'=literal');assert.equal(parsed.members[0]['이름'],payload.members[0].name);
  const before=await readArchive(template),after=await readArchive(exported);
  for(const [path,bytes]of before)if(!['xl/worksheets/sheet1.xml','xl/worksheets/sheet2.xml'].includes(path))assert.deepEqual(after.get(path),bytes,path);
  assert.deepEqual(await readFile(new URL('../public/templates/mooboong-import.xlsx',import.meta.url)),template);
});
test('Excel rejects formulas, duplicate rows, wrong headers, invalid numbers, DTDs and oversized archives',async()=>{
  const invalidFiles=[
    workbook('<row r="2"><c r="B2"><f>1+1</f><v>2</v></c></row>'),
    workbook('<row r="2"/><row r="2"/>'),
    workbook('',Array(8).fill('이름')),
    workbook('<row r="2"><c r="J2" t="inlineStr"><is><t>추가</t></is></c></row>'),
    workbook('<row r="2"><c r="F2"><v>Infinity</v></c></row>'),
    workbook('<row r="2"><c r="B2" t="s"><v>-1</v></c></row>'),
    Buffer.alloc(4*1024*1024+1),
  ];
  const entries=await readArchive(workbook(''));
  for(const encoding of ['utf8','utf16le']){
    const files=Object.fromEntries(entries);files['xl/workbook.xml']=Buffer.from('<!DOCTYPE a [<!ENTITY b "test">]><a>&b;</a>',encoding);invalidFiles.push(zip(files));
  }
  for(const bytes of invalidFiles)await assert.rejects(()=>parseXlsx(bytes),error=>error.status===400);
  await assert.rejects(()=>readArchive(zip({'large.txt':Buffer.alloc(1025)}),{maxExpanded:1024}),{status:400});
  await assert.rejects(()=>readArchive(zip({'../escape.txt':'no'})),{status:400});
});
test('Notion preserves HTML, styles, links and archive images while removing executable markup',async()=>{
  const html='<html><title>Flow8</title><style>p{color:red}</style><article><h1>Guide</h1><script>alert(1)</script><p onclick="bad()">Hello <a href="javascript:alert(1)">bad link</a></p><iframe src="https://evil.test"></iframe><a href="https://notion.so">source</a><div style="background:url(https://evil.test)">safe</div><img src="file:///secret"><svg onload="bad()"></svg></article></html>';
  const result=await parseNotion(Buffer.from(html));assert.equal(result.title,'Flow8');
  for(const fragment of ['<script','<iframe','onclick=','javascript:','url(https://evil.test)','<svg','file:///'])assert.ok(!result.html.includes(fragment),fragment);
  for(const fragment of ['<h1>Guide</h1>','p{color:red}','href="https://notion.so"'])assert.ok(result.html.includes(fragment),fragment);
  const bundle=zip({'page.html':'<html><title>One</title><img src="assets/test.png"></html>','sub/page2.html':'<p>Two</p>','assets/test.png':'fake-image'});
  assert.deepEqual((await parseNotion(bundle)).pages,['page.html','sub/page2.html']);
  assert.match((await parseNotion(bundle,'page.html')).html,/data:image\/png;base64,/);
  for(const bytes of [Buffer.from('not HTML'),zip({'../page.html':'<p>bad</p>'}),zip({'file.txt':'hello'})])await assert.rejects(()=>parseNotion(bytes),{status:400});
  await assert.rejects(()=>parseNotion(bundle,'missing.html'),{status:400});
});

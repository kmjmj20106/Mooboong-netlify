import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { zipSync } from 'fflate';
import { readFile } from 'node:fs/promises';
import { posix, resolve } from 'node:path';
import { readArchive, invalid } from './archive.mjs';
import { MEMBER_HEADERS, TEAM_HEADERS } from './import.mjs';

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const children = (node, name) => Array.from(node?.childNodes || []).filter(n => n.nodeType === 1 && n.localName === name && n.namespaceURI === NS);
const first = (node, name) => children(node, name)[0];
const texts = node => Array.from(node.getElementsByTagNameNS(NS, 't')).map(n => n.textContent).join('');
function xml(bytes) {
  if (!bytes) invalid('엑셀 파일에 필요한 정보가 없습니다.');
  if (/<!DOCTYPE|<!ENTITY/i.test(bytes.toString('utf8').replaceAll('\0', ''))) invalid('외부 XML 정의가 있는 파일은 읽을 수 없습니다.');
  let encoding = 'utf-8';
  if ((bytes[0]===255 && bytes[1]===254) || (bytes[0]===60 && bytes[1]===0)) encoding = 'utf-16le';
  if ((bytes[0]===254 && bytes[1]===255) || (bytes[0]===0 && bytes[1]===60)) encoding = 'utf-16be';
  try { return new DOMParser({ onError: () => { throw new Error('XML'); } }).parseFromString(new TextDecoder(encoding, { fatal: true }).decode(bytes), 'application/xml'); }
  catch { invalid('엑셀 XML을 읽지 못했습니다. .xlsx 형식으로 다시 저장해 주세요.'); }
}
export async function parseXlsx(bytes) {
  const files = await readArchive(bytes, { maxInput:4*1024*1024, maxExpanded:25*1024*1024, maxEntries:400, maxEntry:25*1024*1024 });
  const shared = files.has('xl/sharedStrings.xml') ? Array.from(xml(files.get('xl/sharedStrings.xml')).getElementsByTagNameNS(NS,'si')).map(texts) : [];
  if (shared.length > 20001 || shared.some(v=>v.length>4096)) invalid('셀의 내용이 너무 깁니다.');
  const relations = new Map();
  for (const rel of Array.from(xml(files.get('xl/_rels/workbook.xml.rels')).documentElement.childNodes).filter(n=>n.nodeType===1)) {
    if (rel.getAttribute('TargetMode') === 'External') continue;
    const target = rel.getAttribute('Target') || '';
    const path = posix.normalize(target.startsWith('/') ? target.slice(1) : posix.join('xl', target));
    if (!path.startsWith('xl/') || path.includes('\\')) invalid('엑셀 시트 경로가 올바르지 않습니다.');
    relations.set(rel.getAttribute('Id'), path);
  }
  const result = { members:[], teams:[] }, found = new Set();
  const keys = new Map([['멤버','members'],['회원','members'],['members','members'],['팀','teams'],['teams','teams']]);
  const workbook = xml(files.get('xl/workbook.xml'));
  for (const sheet of Array.from(workbook.getElementsByTagNameNS(NS,'sheet'))) {
    const key = keys.get(sheet.getAttribute('name').trim()); if (!key) continue;
    if (found.has(key)) invalid('같은 종류의 시트가 여러 개 있습니다. 멤버와 팀은 각각 한 시트만 사용해 주세요.');
    found.add(key);
    const path = relations.get(sheet.getAttributeNS(REL,'id'));
    const root = xml(files.get(path)).documentElement;
    let header; const visited = new Set();
    for (const row of children(first(root,'sheetData'),'row')) {
      const rowNum = Number(row.getAttribute('r'));
      if (!Number.isInteger(rowNum) || rowNum<1 || rowNum>100001 || visited.has(rowNum)) invalid('행 번호가 올바르지 않거나 중복됩니다.');
      visited.add(rowNum); const cells = new Map(), seen = new Set();
      for (const cell of children(row,'c')) {
        const match = /^([A-Z]{1,3})([1-9][0-9]*)$/.exec(cell.getAttribute('r'));
        if (!match || Number(match[2])!==rowNum) invalid('셀 주소가 올바르지 않습니다.');
        const col = [...match[1]].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0);
        if (seen.has(col)) invalid('중복된 셀이 있습니다.'); seen.add(col);
        if (first(cell,'f')) invalid('등록 양식에는 수식 대신 값을 입력해 주세요.');
        const type = cell.getAttribute('t') || 'n'; let value = first(cell,'v')?.textContent ?? '';
        if (type==='s') { const n=Number(value); if (!/^\d+$/.test(value) || !Number.isInteger(n) || n>=shared.length) invalid('셀 문자열 정보가 올바르지 않습니다.'); value=shared[n]; }
        else if (type==='inlineStr') value=texts(cell);
        else if (type==='n' && value!=='') { value=Number(value); if(!Number.isFinite(value))invalid('숫자 셀의 값이 올바르지 않습니다.'); }
        else if (type==='b') value=value==='1';
        else if (!['str','n'].includes(type)) invalid('오류 또는 날짜 형식의 셀이 있습니다. 등록 항목은 문자로 입력해 주세요.');
        if (typeof value==='string' && value.length>4096) invalid('셀의 내용이 너무 깁니다.');
        if (value!=='') { if(col>32)invalid('양식 범위를 벗어난 열에 내용이 있습니다.'); cells.set(col,value); }
      }
      if (!cells.size) continue;
      if (!header) {
        if (rowNum!==1) invalid('첫 번째 행에 양식의 열 제목을 넣어 주세요.');
        header=new Map([...cells].map(([n,v])=>[n,String(v).trim()]));
        const expected=key==='members'?MEMBER_HEADERS:TEAM_HEADERS;
        if(header.size!==expected.length || new Set(header.values()).size!==expected.length || [...header.values()].some(v=>!expected.includes(v))) invalid('열 제목이 양식과 다릅니다. 내려받은 양식의 제목을 그대로 사용해 주세요.');
        continue;
      }
      if([...cells.keys()].some(c=>!header.has(c))) invalid('양식 범위를 벗어난 열에 내용이 있습니다.');
      if(result[key].length>=1000) invalid('한 시트에 최대 1000행까지 등록할 수 있습니다.');
      result[key].push({...Object.fromEntries([...header].map(([c,name])=>[name,cells.get(c)??''])),__row:rowNum});
    }
    if(!header) invalid('첫 번째 행에 양식의 열 제목이 필요합니다.');
  }
  if(!found.size) invalid('멤버 또는 팀 시트를 찾을 수 없습니다. 양식의 시트 이름을 유지해 주세요.');
  return result;
}

export async function buildWorkbook(payload) {
  const files=await readArchive(await readFile(process.env.NETLIFY ? resolve(process.cwd(),'public/templates/mooboong-import.xlsx') : new URL('../public/templates/mooboong-import.xlsx',import.meta.url)));
  const sheets={
    'xl/worksheets/sheet1.xml':payload.members.map(m=>[m.id,m.name,'',m.session||'',m.generation||'',m.phone||'',(m.teams||[]).map(t=>t.name).join(', '),m.admin?'Y':'N']),
    'xl/worksheets/sheet2.xml':payload.teams.map(t=>[t.name,...['vocal','guitar1','guitar2','bass','drums','keyboard'].map(s=>t.slots[s]||'')]),
  };
  for(const [path,values] of Object.entries(sheets)) {
    const doc=xml(files.get(path)), root=doc.documentElement, data=first(root,'sheetData'), rows=children(data,'row');
    const styles=rows.slice(1,3).map(r=>children(r,'c').map(c=>c.getAttribute('s')||'0'));
    for(const row of rows)if(row.getAttribute('r')!=='1')data.removeChild(row);
    values.forEach((fields,i)=>{
      const row=doc.createElementNS(NS,'row');row.setAttribute('r',String(i+2));row.setAttribute('ht','30');row.setAttribute('customHeight','1');
      fields.forEach((value,col)=>{
        const cell=doc.createElementNS(NS,'c');cell.setAttribute('r',String.fromCharCode(65+col)+(i+2));cell.setAttribute('t','inlineStr');cell.setAttribute('s',styles[i%styles.length]?.[col]||'0');
        const inline=doc.createElementNS(NS,'is'),text=doc.createElementNS(NS,'t');text.setAttributeNS('http://www.w3.org/XML/1998/namespace','xml:space','preserve');
        text.appendChild(doc.createTextNode(String(value??'').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]/gu,'')));
        inline.appendChild(text);cell.appendChild(inline);row.appendChild(cell);
      });data.appendChild(row);
    });
    first(root,'dimension')?.setAttribute('ref',`A1:${String.fromCharCode(64+children(rows[0],'c').length)}${Math.max(1,values.length+1)}`);
    files.set(path,Buffer.from(new XMLSerializer().serializeToString(doc)));
  }
  return Buffer.from(zipSync(Object.fromEntries(files),{level:6}));
}

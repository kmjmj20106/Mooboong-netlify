import {Marked} from 'marked';
import {zipSync} from 'fflate';
import {posix} from 'node:path';
import {readArchive,invalid} from './archive.mjs';
import {parseNotion} from './notion.mjs';
const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
export async function parseMarkdownArchive(bytes,entry=''){
 const source=await readArchive(bytes),files=new Map();
 for(const [name,data] of source){const key=name.normalize('NFC');if(files.has(key))invalid('같은 이름의 파일이 중복되어 있습니다.');files.set(key,data)}
 const pages=[...files.keys()].filter(p=>/\.(md|markdown)$/i.test(p)&&!p.startsWith('__MACOSX/')).sort();
 if(!pages.length)invalid('ZIP 안에 Markdown 문서가 없습니다.');
 if(!entry&&pages.length>1)return {pages};
 const page=(entry||pages[0]).normalize('NFC');if(!pages.includes(page))invalid('가져올 Markdown 문서를 선택해 주세요.');
 let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(files.get(page))}catch{invalid('UTF-8 Markdown 문서를 선택해 주세요.')}
 if(text.length>100000)invalid('Markdown 문서는 100,000자 이하로 나누어 주세요.');
 const parser=new Marked({gfm:true,breaks:true,renderer:{
 html({text}){return esc(text)},
 image({href,text}){
  let path;try{path=posix.normalize(posix.join(posix.dirname(page),decodeURIComponent(href))).normalize('NFC')}catch{invalid('이미지 경로를 확인해 주세요.')}
  if(!files.has(path)||! /\.(png|jpe?g|webp|gif)$/i.test(path))invalid(`이미지 파일을 찾을 수 없습니다: ${href}`);
  return `<img src="${esc(encodeURI(posix.relative(posix.dirname(page),path)))}" alt="${esc(text)}">`;
 }
 }});
 // Notion exports use aside wrappers around Markdown paragraphs.
 const html=parser.parse(text.replace(/<\/?aside\s*>/gi,''));
 const htmlPath=page.replace(/\.(md|markdown)$/i,'.html');
 const archive=Object.fromEntries([...files].filter(([name])=>/\.(png|jpe?g|webp|gif)$/i.test(name)));
 const title=text.match(/^#\s+(.+)$/m)?.[1]||posix.basename(page);
 archive[htmlPath]=Buffer.from(`<html><head><title>${esc(title)}</title></head><body>${html}</body></html>`);
 return parseNotion(Buffer.from(zipSync(archive)),htmlPath);
}

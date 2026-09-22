import { parse as parseHtml } from 'parse5';
import { posix } from 'node:path';
import { readArchive, invalid } from './archive.mjs';

const tags=new Set('article section main header footer div span p h1 h2 h3 h4 h5 h6 br hr a img figure figcaption table thead tbody tfoot tr td th caption colgroup col ul ol li blockquote pre code strong b em i u s del mark small sub sup details summary time dl dt dd'.split(' '));
const drop=new Set('script iframe object embed svg math form button textarea select template'.split(' '));
const voids=new Set(['br','hr','img','col']);
const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
function safeUrl(value) {
  value=value.trim();if(/[\x00-\x20\x7f]/.test(value))return '';
  if(value.startsWith('#'))return value;
  try{const u=new URL(value);return ['https:','http:','mailto:'].includes(u.protocol)&&!u.username?value:'';}catch{return '';}
}
const css=value=>/url\s*\(|expression|@import|behavior|binding|\\|</i.test(value)?'':value;
export async function parseNotion(raw,entry='') {
  if(raw.length>20*1024*1024)invalid('20MB 이하의 파일을 선택해 주세요.');
  let assets=new Map(),page='index.html';
  if(raw[0]===80&&raw[1]===75) {
    assets=await readArchive(raw);
    const pages=[...assets.keys()].filter(p=>/\.html?$/i.test(p)).sort((a,b)=>a.split('/').length-b.split('/').length||a.localeCompare(b));
    if(!pages.length)invalid('ZIP 안에 HTML 페이지가 없습니다.');
    if(!entry&&pages.length>1)return {pages};
    page=entry||pages[0];if(!pages.includes(page))invalid('가져올 HTML 페이지를 선택해 주세요.');raw=assets.get(page);
  }
  let source;try{source=new TextDecoder('utf-8',{fatal:true}).decode(raw);}catch{invalid('UTF-8 HTML 파일을 선택해 주세요.');}
  if(!/<(?:html|article|div|p|h1)\b/i.test(source))invalid('노션에서 내보낸 HTML 또는 ZIP 파일을 선택해 주세요.');
  const text=[],titles=[];let size=0;
  function walk(node,depth=0) {
    if(depth>200)invalid('문서 구조가 너무 복잡합니다.');
    if(node.nodeName==='#text'){text.push(node.value);return esc(node.value);}
    const tag=node.tagName;
    if(drop.has(tag))return '';
    if(tag==='title'){titles.push((node.childNodes||[]).map(n=>n.value||'').join(''));return '';}
    if(tag==='style'){const value=css((node.childNodes||[]).map(n=>n.value||'').join(''));return value?`<style>${value}</style>`:'';}
    let attributes=[];
    const attrs=Object.fromEntries((node.attrs||[]).map(a=>[a.name,a.value]));
    for(const [k,v]of Object.entries(attrs)) {
      if(['class','id','title','alt','colspan','rowspan','start','width','height'].includes(k))attributes.push([k,v.slice(0,500)]);
      if(k==='style'&&css(v))attributes.push([k,css(v)]);
    }
    if(tag==='a'){const href=safeUrl(attrs.href||'');if(href)attributes.push(['href',href],['target','_blank'],['rel','noopener noreferrer']);}
    if(tag==='img') {
      let src=attrs.src||'',path='';
      try{path=posix.normalize(posix.join(posix.dirname(page),decodeURIComponent(src.split(/[?#]/)[0])));}catch{}
      const asset=assets.get(path),mime={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp'}[posix.extname(path).toLowerCase()];
      src=asset?(mime?`data:${mime};base64,${asset.toString('base64')}`:''):(/^https?:/i.test(src)?safeUrl(src):'');
      if(!src)return '';
      // Bound repeated embedded images as well as compressed archive size.
      size+=src.length;if(size>18*1024*1024)invalid('이미지가 많아 페이지가 너무 큽니다. 페이지를 나누어 올려 주세요.');
      attributes.push(['src',src],['loading','lazy'],['referrerpolicy','no-referrer']);
    }
    const content=(node.childNodes||[]).map(n=>walk(n,depth+1)).join('');
    if(!tags.has(tag))return content;
    return `<${tag}${attributes.map(([k,v])=>` ${k}="${esc(v)}"`).join('')}>${content}${voids.has(tag)?'':`</${tag}>`}`;
  }
  const body=walk(parseHtml(source));
  const html='<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:16px/1.8 -apple-system,sans-serif;max-width:900px;margin:24px auto;padding:0 20px;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{display:block;overflow:auto}pre{overflow:auto}a{color:#bd4633}</style></head><body>'+body+'</body></html>';
  if(Buffer.byteLength(html)>18*1024*1024)invalid('페이지와 이미지의 크기가 너무 큽니다. 페이지를 나누어 올려 주세요.');
  return {title:titles.join('').trim().slice(0,150)||'노션 문서',html,text:text.join(' ').trim().slice(0,2000)};
}

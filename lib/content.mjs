import { parseNotion } from './notion.mjs';
import { adminGuide } from './guides.mjs';

export function sourceUrl(value) {
  if (!value) return '';
  try { const u=new URL(value); if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw 0; return u.href; }
  catch { const e=new Error('http:// 또는 https://로 시작하는 원문 주소를 입력해 주세요.');e.status=400;throw e; }
}
export async function contentRoutes(req,res,url,db,member,{readBody,send,fail,transaction}) {
  const path=url.pathname;
  if(path==='/api/admin-guide'&&req.method==='GET') {
    if(!member.admin)fail(403,'운영진만 사용할 수 있습니다.');
    send(res,200,{sections:adminGuide});return true;
  }
  const doc=path.match(/^\/api\/posts\/(\d+)\/document$/);
  if(doc&&req.method==='GET') {
    const p=(await db.prepare('SELECT document_html FROM posts WHERE id=?').get(Number(doc[1])));
    if(!p?.document_html)fail(404,'가져온 문서를 찾을 수 없습니다.');
    res.setHeader('Content-Security-Policy', "sandbox allow-same-origin allow-popups allow-popups-to-escape-sandbox; default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline'; script-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'");
    res.setHeader('X-Frame-Options','SAMEORIGIN');
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(p.document_html);return true;
  }
  if(path==='/api/wiki/import'&&req.method==='POST') {
    if(!member.admin)fail(403,'운영진만 사용할 수 있습니다.');
    const bytes=await readBody(req,20*1024*1024);
    let entry='';try{entry=decodeURIComponent(req.headers['x-entry']||'')}catch{fail(400,'페이지 이름을 확인해 주세요.')}
    const parsed=await parseNotion(bytes,entry);
    if(parsed.pages){send(res,200,{pages:parsed.pages});return true;}
    const id=(await transaction(async ()=>Number((await db.prepare("INSERT INTO posts(kind,title,body,category,author_id,document_html) VALUES('wiki',?,?, '노션 문서',?,?)").run(parsed.title,parsed.text||'노션에서 가져온 문서',member.id,parsed.html)).lastInsertRowid)));
    send(res,201,{id,title:parsed.title});return true;
  }
  const attach=path.match(/^\/api\/posts\/(\d+)\/attachments$/);
  if(attach&&req.method==='POST') {
    if(!member.admin)fail(403,'운영진만 사용할 수 있습니다.');
    const id=Number(attach[1]);if(!(await db.prepare('SELECT id FROM posts WHERE id=?').get(id)))fail(404,'게시물을 찾을 수 없습니다.');
    if((await db.prepare('SELECT COUNT(*) n FROM attachments WHERE post_id=?').get(id)).n>=5)fail(400,'게시물당 최대 5개 파일을 첨부할 수 있습니다.');
    let name;try{name=decodeURIComponent(req.headers['x-filename']||'')}catch{fail(400,'파일 이름을 확인해 주세요.')}
    name=name.replace(/[\x00-\x1f/\\]/g,'_').slice(0,180);
    if(!/\.(pdf|png|jpe?g|webp|gif|txt|csv|xlsx|xls|docx|pptx|zip)$/i.test(name))fail(400,'PDF·이미지·텍스트·엑셀·문서·ZIP 파일을 첨부해 주세요.');
    const bytes=await readBody(req,10*1024*1024);if(!bytes.length)fail(400,'빈 파일은 첨부할 수 없습니다.');
    const aid=(await transaction(async ()=>{
      if((await db.prepare('SELECT COUNT(*) n FROM attachments WHERE post_id=?').get(id)).n>=5)fail(400,'게시물당 최대 5개 파일을 첨부할 수 있습니다.');
      return Number((await db.prepare("INSERT INTO attachments(post_id,name,mime,content) VALUES(?,?,'application/octet-stream',?)").run(id,name,bytes)).lastInsertRowid);
    }));
    send(res,201,{attachment:{id:aid,name,size:bytes.length}});return true;
  }
  const download=path.match(/^\/api\/attachments\/(\d+)$/);
  if(download&&req.method==='GET') {
    const a=(await db.prepare('SELECT * FROM attachments WHERE id=?').get(Number(download[1])));if(!a)fail(404,'첨부파일을 찾을 수 없습니다.');
    res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(a.name)}`,'Cache-Control':'no-store'});res.end(a.content);return true;
  }
  return false;
}

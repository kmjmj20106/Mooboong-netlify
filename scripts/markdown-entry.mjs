import {zipSync} from 'fflate';
window.zipMarkdownFiles=zipSync;
import {Marked} from 'marked';
import DOMPurify from 'dompurify';
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const parser=new Marked({gfm:true,breaks:true,renderer:{
 html({text}){return escape(text)},
 heading({tokens,depth}){const n=Math.min(6,depth+1);return `<h${n}>${this.parser.parseInline(tokens)}</h${n}>`},
 // Keep notice content self-contained: external/local Markdown images become links.
 image({href,text}){return /^https?:\/\//i.test(href)?`<a href="${escape(href)}">${escape(text||'이미지 열기')}</a>`:escape(text||'이미지');},
 link({href,tokens}){const text=this.parser.parseInline(tokens);return /^https?:\/\//i.test(href)?`<a href="${escape(href)}" target="_blank" rel="noopener noreferrer">${text}</a>`:text;}
}});
window.renderMarkdown=text=>DOMPurify.sanitize(parser.parse(String(text||'').replace(/^\uFEFF/,'')),{
 ALLOWED_TAGS:['h2','h3','h4','h5','h6','p','br','strong','em','del','ul','ol','li','blockquote','pre','code','hr','table','thead','tbody','tr','th','td','a','input'],
 ALLOWED_ATTR:['href','target','rel','type','checked','disabled','start','align'],ALLOW_DATA_ATTR:false
});

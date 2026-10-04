/* Small, escaped Markdown subset. Raw HTML and images are intentionally not rendered. */
(function(){
  const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function inline(s){
    const tokens=[];let value=String(s).replace(/`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>"']+)/g,(all,code,label,url,bare)=>{
      tokens.push(code?`<code>${escape(code)}</code>`:`<a href="${escape(url||bare)}" target="_blank" rel="noopener noreferrer">${escape(label||bare)}</a>`);return `\u0000${tokens.length-1}\u0000`;
    });
    value=escape(value).replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/\*([^*]+)\*/g,'<em>$1</em>').replace(/~~([^~]+)~~/g,'<del>$1</del>');
    return value.replace(/\u0000(\d+)\u0000/g,(_,n)=>tokens[Number(n)]||'');
  }
  window.renderMarkdown=function(text){
    const out=[],lines=String(text||'').replace(/\u0000/g,'').split(/\r?\n/);let code=null,list=null;
    const close=()=>{if(list){out.push(`</${list}>`);list=null}};
    for(const line of lines){
      if(/^```/.test(line)){close();if(code!==null){out.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`);code=null}else code=[];continue}
      if(code!==null){code.push(line);continue}
      const item=/^\s*(?:([-*])|\d+\.)\s+(.+)/.exec(line);
      if(item){const kind=item[1]?'ul':'ol';if(list!==kind){close();out.push(`<${kind}>`);list=kind}out.push(`<li>${inline(item[2])}</li>`);continue}close();
      const heading=/^(#{1,6})\s+(.+)/.exec(line);
      if(heading){const level=Math.min(6,heading[1].length+1);out.push(`<h${level}>${inline(heading[2])}</h${level}>`)}
      else if(/^>\s?/.test(line))out.push(`<blockquote>${inline(line.replace(/^>\s?/,''))}</blockquote>`);
      else if(line.trim())out.push(`<p>${inline(line)}</p>`);
    }close();if(code!==null)out.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`);return out.join('');
  };
})();

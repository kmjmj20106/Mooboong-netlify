import { Readable } from 'node:stream';

// Reuse the tested API routes without opening a listening port in a Function.
export function requestHandler(handle) {
  return async (request, context = {}) => {
    const url=new URL(request.url);
    if(!url.pathname.startsWith('/api/'))return new Response('Not found',{status:404});
    const req=request.body?Readable.fromWeb(request.body):Readable.from([]);
    req.url=url.pathname+url.search;req.method=request.method;
    req.headers={...Object.fromEntries(request.headers),host:url.host};
    req.socket={remoteAddress:context.ip||'unknown'};
    let status=200,body=Buffer.alloc(0);
    const headers=new Headers();
    const res={
      headersSent:false,destroyed:false,
      setHeader(name,value){headers.set(name,String(value));},
      writeHead(code,values={}){status=code;for(const [key,value]of Object.entries(values))headers.set(key,String(value));this.headersSent=true;},
      end(value){if(value!==undefined)body=Buffer.isBuffer(value)?value:Buffer.from(value);this.headersSent=true;},
    };
    await handle(req,res);
    if(body.length>19*1024*1024)return new Response(JSON.stringify({error:'문서가 너무 큽니다. 운영진에게 페이지를 나누어 달라고 요청해 주세요.'}),{status:413,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
    if(request.method==='HEAD'||[204,304].includes(status))return new Response(null,{status,headers});
    // Explicit streaming preserves downloads above the buffered 6 MB limit.
    let offset=0;
    const stream=new ReadableStream({pull(controller){
      if(offset>=body.length){controller.close();return;}
      const end=Math.min(offset+64*1024,body.length);controller.enqueue(body.subarray(offset,end));offset=end;
    }});
    return new Response(stream,{status,headers});
  };
}

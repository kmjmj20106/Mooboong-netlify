import { requestHandler } from '../../lib/netlify-handler.mjs';

let application;
export default async function handler(request,context) {
  process.env.NETLIFY='true';
  try {
    // Site URL comes from trusted platform context, never the request Host header.
    if(!process.env.APP_ORIGIN&&!process.env.URL&&context?.site?.url)process.env.URL=context.site.url;
    application ||= import('../../server.mjs');
    const {handleRequest}=await application;
    return await requestHandler(handleRequest)(request,context);
  } catch(error) {
    console.error('Function initialization failed:',error.code||error.name);
    return new Response(JSON.stringify({error:'서버 연결을 준비하지 못했습니다. 운영진은 Netlify의 환경변수와 함수 로그를 확인해 주세요.'}),{status:503,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
  }
}
export const config={path:'/api/*'};

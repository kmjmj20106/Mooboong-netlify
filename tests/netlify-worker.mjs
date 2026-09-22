// Isolated test worker: invoke the actual bundled Functions v2 entry point.
import { pathToFileURL } from 'node:url';
const {default:handler}=await import(pathToFileURL(process.env.FUNCTION_MODULE));
process.on('message',async message=>{
  const {id,path,method='GET',headers={},body,ip='192.0.2.1'}=message;
  try{
    const request=new Request(process.env.APP_ORIGIN+path,{method,headers,body:body===undefined?undefined:Buffer.from(body,'base64')});
    const response=await handler(request,{ip,site:{url:process.env.APP_ORIGIN}});
    process.send({id,status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer()).toString('base64')});
  }catch(error){process.send({id,error:String(error.stack)});}
});
process.send({ready:true});

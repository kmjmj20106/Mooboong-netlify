import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { randomToken } from './security.mjs';

export const transientSchema = `
CREATE TABLE IF NOT EXISTS transient_uploads (
 token TEXT PRIMARY KEY, session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
 purpose TEXT NOT NULL, total_size INTEGER NOT NULL, expires_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS transient_chunks (
 token TEXT NOT NULL REFERENCES transient_uploads(token) ON DELETE CASCADE,
 part INTEGER NOT NULL, content BYTEA NOT NULL, PRIMARY KEY(token,part)
);
CREATE INDEX IF NOT EXISTS transient_expiry ON transient_uploads(expires_at);
CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, until_at BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS login_attempts_expiry ON login_attempts(until_at);
`;
function error(message,status=400){throw Object.assign(new Error(message),{status});}
function key(secret){return createHash('sha256').update('mooboong-upload-v1:').update(secret).digest();}
function seal(bytes,session,token,part){
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key(session.secret),iv);
  cipher.setAAD(Buffer.from(`${token}:${part}`));
  const body=Buffer.concat([cipher.update(bytes),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),body]);
}
function unseal(bytes,session,token,part){
  const decipher=createDecipheriv('aes-256-gcm',key(session.secret),bytes.subarray(0,12));
  decipher.setAAD(Buffer.from(`${token}:${part}`));decipher.setAuthTag(bytes.subarray(12,28));
  return Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]);
}
export function transientState(db){
  const clean=async()=>{
    await db.prepare('DELETE FROM transient_uploads WHERE expires_at<?').run(Date.now());
    await db.prepare('DELETE FROM login_attempts WHERE until_at<?').run(Date.now());
  };
  const clear=session=>db.prepare('DELETE FROM transient_uploads WHERE session_hash=?').run(session);
  async function create(session,purpose,totalSize){
    return db.transaction(async()=>{
      await db.prepare('DELETE FROM transient_uploads WHERE expires_at<?').run(Date.now());
      const usage=await db.prepare('SELECT COUNT(*) n, COALESCE(SUM(total_size),0) size FROM transient_uploads WHERE session_hash=?').get(session.hash);
      if(usage.n>=5||Number(usage.size)+totalSize>40*1024*1024)error('검토 중인 파일이 너무 많습니다. 잠시 후 다시 올려 주세요.');
      const token=randomToken();
      await db.prepare('INSERT INTO transient_uploads(token,session_hash,purpose,total_size,expires_at) VALUES(?,?,?,?,?)').run(token,session.hash,purpose,totalSize,Date.now()+15*60*1000);
      return token;
    });
  }
  async function info(session,token,purpose){
    if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))error('업로드 정보를 확인해 주세요.');
    const entry=await db.prepare('SELECT * FROM transient_uploads WHERE token=? AND session_hash=? AND expires_at>?').get(token,session.hash,Date.now());
    if(!entry||(purpose&&entry.purpose!==purpose))error('업로드 검토가 만료되었습니다. 파일을 다시 올려 주세요.');
    return entry;
  }
  async function put(session,token,part,bytes){
    await db.transaction(async()=>{
      const entry=await info(session,token);
      const count=Math.ceil(entry.total_size/(1024*1024));
      if(!Number.isInteger(part)||part<0||part>=count||bytes.length!==Math.min(1024*1024,entry.total_size-part*1024*1024))error('파일 조각의 크기나 순서를 확인해 주세요.');
      await db.prepare('INSERT INTO transient_chunks(token,part,content) VALUES(?,?,?) ON CONFLICT(token,part) DO UPDATE SET content=excluded.content').run(token,part,seal(bytes,session,token,part));
    });
  }
  async function take(session,token,purpose){
    return db.transaction(async()=>{
      const entry=await info(session,token,purpose);
      const chunks=await db.prepare('SELECT part,content FROM transient_chunks WHERE token=? ORDER BY part').all(token);
      if(chunks.length!==Math.ceil(entry.total_size/(1024*1024)))error('파일 업로드가 완료되지 않았습니다. 다시 올려 주세요.');
      let bytes;
      try{bytes=Buffer.concat(chunks.map((chunk,i)=>unseal(Buffer.from(chunk.content),session,token,i)));}catch{error('파일을 확인할 수 없습니다. 다시 올려 주세요.');}
      if(bytes.length!==entry.total_size)error('파일 크기가 일치하지 않습니다.');
      await db.prepare('DELETE FROM transient_uploads WHERE token=?').run(token);
      return bytes;
    });
  }
  async function preview(session,workbook){
    await clear(session.hash);
    const bytes=Buffer.from(JSON.stringify(workbook));
    const token=await create(session,'preview',bytes.length);
    for(let i=0;i<Math.ceil(bytes.length/(1024*1024));i++)await put(session,token,i,bytes.subarray(i*1024*1024,(i+1)*1024*1024));
    return token;
  }
  const rateKey=value=>createHash('sha256').update(value).digest('hex');
  async function rate(ip,id){
    // Commit the counters even when a limit is reached, across all instances.
    const denied=await db.transaction(async()=>{
      let denied=false;
      for(const [value,limit] of [[`ip:${ip}`,40],[`id:${id}`,8]]){
        const key=rateKey(value),now=Date.now();
        await db.prepare(`INSERT INTO login_attempts(key,count,until_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET
          count=CASE WHEN login_attempts.until_at>? THEN login_attempts.count+1 ELSE 1 END,
          until_at=CASE WHEN login_attempts.until_at>? THEN login_attempts.until_at ELSE excluded.until_at END`).run(key,now+900000,now,now);
        const entry=await db.prepare('SELECT count FROM login_attempts WHERE key=?').get(key);
        if(Number(entry.count)>limit)denied=true;
      }
      return denied;
    });
    if(denied)error('로그인 시도가 너무 많습니다. 15분 뒤에 다시 시도해 주세요.',429);
  }
  return {clean,clear,create,put,take,preview,rate,clearRate:id=>db.prepare('DELETE FROM login_attempts WHERE key=?').run(rateKey(`id:${id}`))};
}

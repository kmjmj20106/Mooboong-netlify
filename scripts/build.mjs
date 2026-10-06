import {build} from 'esbuild';
await build({entryPoints:['scripts/markdown-entry.mjs'],outfile:'public/markdown.js',bundle:true,minify:true,format:'iife',platform:'browser'});
import './static-login.mjs';
import { access, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
// Build never connects to the database or changes live club data.
for(const path of ['public/index.html','public/app.js','public/templates/mooboong-import.xlsx','schema.sql','netlify/functions/api.mjs'])await access(path);
for(const path of ['server.mjs','public/app.js','netlify/functions/api.mjs'])execFileSync(process.execPath,['--check',path],{stdio:'inherit'});
const template=await readFile('public/templates/mooboong-import.xlsx');
if(template.readUInt32LE(0)!==0x04034b50)throw new Error('Missing XLSX template');
console.log('Netlify 배포 파일 확인 완료. 데이터베이스는 빌드 중 변경하지 않습니다.');

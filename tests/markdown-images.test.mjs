import test from 'node:test';
import assert from 'node:assert/strict';
import {zipSync} from 'fflate';
import {parseMarkdownArchive} from '../lib/markdown-import.mjs';
const zip=files=>Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([p,v])=>[p,Buffer.from(v)]))));
test('Markdown archive resolves Korean decomposed paths, embeds images and sanitizes HTML',async()=>{
 const parsed=await parseMarkdownArchive(zip({'안내.md':'# 장비 안내\n\n![사진](%EC%82%AC%EC%A7%84/a.png)\n\n<aside>\n**강조**\n</aside>\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1))',['사진/a.png'.normalize('NFD')]:'image bytes'}));
 assert.equal(parsed.title,'장비 안내');assert.match(parsed.html,/data:image\/png;base64/);assert.match(parsed.html,/<strong>강조<\/strong>/);assert.doesNotMatch(parsed.html,/<script|href="javascript:/);assert.equal((parsed.html.match(/<img /g)||[]).length,1);
});
test('Markdown archive requires selecting multiple pages and rejects missing or unsafe image paths',async()=>{
 const bytes=zip({'a.md':'# A','b.md':'# B'});assert.deepEqual((await parseMarkdownArchive(bytes)).pages,['a.md','b.md']);assert.equal((await parseMarkdownArchive(bytes,'b.md')).title,'B');
 for(const path of ['missing.png','https://example.com/a.png','../../outside.png','a.svg'])await assert.rejects(parseMarkdownArchive(zip({'a.md':`![x](${path})`})),/이미지 파일/);
});

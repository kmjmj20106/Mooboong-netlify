import {reservationPolicy,validatePolicies} from './lib/booking-policy.mjs';
import http from 'node:http';
import { seedGuides } from './lib/guides.mjs';
import { contentRoutes, sourceUrl, notionEmbedUrl } from './lib/content.mjs';
import { readFile, stat, realpath } from 'node:fs/promises';
import { dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseXlsx } from './lib/workbook.mjs';
import { transientState, transientSchema } from './lib/transient-state.mjs';
import { getSettings, audit } from './lib/db.mjs';
import { hashPassword, verifyPassword, randomToken, tokenHash, readCookies } from './lib/security.mjs';
import { previewImport, applyImport } from './lib/import.mjs';

import { connectDatabase } from './lib/database.mjs';
import { memberView, listMembers, listTeams, readDirectory } from './lib/member-views.mjs';
import { exportMembers } from './lib/member-export.mjs';
import { readSchedule } from './lib/schedule.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const publicRoot = resolve(root, 'public');
const port = Number(process.env.PORT || 4318);
const configuredOrigin = process.env.APP_ORIGIN || process.env.URL || process.env.RENDER_EXTERNAL_URL;
const appOrigin = configuredOrigin ? new URL(configuredOrigin).origin : null;
if (appOrigin && !appOrigin.startsWith('https://')) throw new Error('APP_ORIGIN must use HTTPS.');
if (process.env.HOST && !['127.0.0.1', 'localhost', '::1'].includes(process.env.HOST) && !appOrigin) throw new Error('Public hosting requires APP_ORIGIN.');
const secureCookie = appOrigin?.startsWith('https:') ? '; Secure' : '';
let db, state, initializing;
export async function initializeApp() {
  if (db) return;
  if (!initializing) initializing = (async () => {
    const connected = await connectDatabase(resolve(process.env.DATA_DIR || resolve(root, 'data')));
    try {
      if (connected.dialect === 'sqlite') await connected.exec(transientSchema);
      if (!process.env.NETLIFY) await seedGuides(connected);
      state=transientState(connected); db=connected;
    } catch(error) { await connected.close(); throw error; }
  })().catch(error => { initializing=null; throw error; });
  await initializing;
}
const sessionLifetime = 14 * 24 * 60 * 60 * 1000;
const dummyHash = hashPassword(randomToken());
const slotNames = ['vocal', 'guitar1', 'guitar2', 'bass', 'drums', 'keyboard'];

class RequestError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}
const fail = (status, message, extra) => { throw new RequestError(status, message, extra); };
const cleanText = (value, max = 100) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const pad = value => String(value).padStart(2, '0');
const toTime = minute => `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`;
const isoDate = date => date.toISOString().slice(0, 10);
const addDays = (date, amount) => isoDate(new Date(new Date(`${date}T00:00:00Z`).valueOf() + amount * 86400000));

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && isoDate(date) === value;
}
function seoulNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map(({ type, value }) => [type, value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minute: Number(parts.hour) * 60 + Number(parts.minute) };
}
function sunday(date) { return addDays(date, -new Date(`${date}T00:00:00Z`).getUTCDay()); }
function minutes(value) {
  if(value==='24:00')return 1440;
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):(?:00|30)$/.test(value)) fail(400, '예약 시간은 30분 단위로 선택해 주세요.');
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}
async function transaction(work) { return (await db.transaction(work)); }

async function safeMember(member) {
  if (!member) return null;
  const teams = await db.prepare(`SELECT t.id,t.name,tm.slot FROM teams t JOIN team_members tm ON tm.team_id=t.id
    WHERE tm.member_id=? ORDER BY t.name,tm.slot`).all(member.id);
  return memberView(member, teams);
}
async function teamList() { return listTeams(db); }
async function sessionFrom(req) {
  const raw = readCookies(req.headers.cookie).mooboong_session;
  if (!raw || !/^[A-Za-z0-9_-]{43}$/.test(raw)) return null;
  const hash = tokenHash(raw);
  const member = await db.prepare(`SELECT m.* FROM sessions s JOIN members m ON m.id=s.member_id
    WHERE s.token_hash=? AND s.expires_at>?`).get(hash, Date.now());
  return member ? { hash, member, secret: raw } : null;
}
async function requireMember(req, { admin = false, allowPasswordChange = false } = {}) {
  const session = (await sessionFrom(req));
  if (!session) fail(401, '로그인이 필요합니다.');
  if (!allowPasswordChange && session.member.must_change_password) fail(403, '먼저 비밀번호를 변경해 주세요.', { code: 'PASSWORD_CHANGE_REQUIRED' });
  if (admin && !session.member.admin) fail(403, '운영진만 사용할 수 있습니다.');
  return session;
}
async function createSession(res, memberId) {
  const raw = randomToken();
  const hash = tokenHash(raw);
  (await db.prepare('INSERT INTO sessions(token_hash,member_id,expires_at,created_at) VALUES (?,?,?,?)')
    .run(hash, memberId, Date.now() + sessionLifetime, Date.now()));
  res.setHeader('Set-Cookie', `mooboong_session=${raw}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(sessionLifetime / 1000)}${secureCookie}`);
  return hash;
}
function clearSession(res) { res.setHeader('Set-Cookie', 'mooboong_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' + secureCookie); }
async function removeUploads(hash) { await state.clear(hash); }
let nextSessionCleanup = 0;
async function cleanExpired() {
  const now = Date.now();
  if (now < nextSessionCleanup) return;
  nextSessionCleanup = now + 5 * 60 * 1000;
  try {
    await db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(now);
    await state.clean();
  } catch (error) { nextSessionCleanup = 0; throw error; }
}
async function checkLoginRate(req, id) { await state.rate(req.socket.remoteAddress, id); }
async function readBody(req, limit = 2 * 1024 * 1024) {
  if (req.headers['x-upload-token']) {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (!['/api/wiki/import','/api/markdown/import','/api/import/file'].includes(path) && !/^\/api\/posts\/\d+\/attachments$/.test(path)) fail(400, '지원하지 않는 업로드 요청입니다.');
    const session = await requireMember(req, {admin:true});
    const bytes = await state.take(session,req.headers['x-upload-token'],path);
    if (bytes.length > limit) fail(413, '파일 또는 요청이 너무 큽니다.');
    return bytes;
  }
  if (Number(req.headers['content-length'] || 0) > limit) fail(413, '파일 또는 요청이 너무 큽니다.');
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) fail(413, '파일 또는 요청이 너무 큽니다.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function jsonBody(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) fail(415, 'JSON 요청이 필요합니다.');
  let body;
  try { body = JSON.parse((await readBody(req)).toString('utf8')); }
  catch (error) { if (error.status) throw error; fail(400, '요청 형식을 확인해 주세요.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, '요청 형식을 확인해 주세요.');
  return body;
}
function csrf(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return;
  if (req.headers['x-mooboong-request'] !== '1') fail(403, '요청을 확인할 수 없습니다. 화면을 새로고침해 주세요.');
  let origin;
  try { origin = new URL(req.headers.origin); } catch { fail(403, '요청 출처를 확인할 수 없습니다.'); }
  if (appOrigin ? origin.origin !== appOrigin : (origin.protocol !== 'http:' || origin.host !== req.headers.host)) fail(403, '허용되지 않은 요청 출처입니다.');
}
function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function bookingView(row, member, context = null) {
  const now = context?.now || seoulNow();
  const upcoming = row.date > now.date || (row.date === now.date && row.start_min > now.minute && !(context?.settings || await getSettings(db)).blockSameDayCancellation);
  return {
    id: row.id, date: row.date, start: toTime(row.start_min), end: toTime(row.end_min), type: row.type,
    displayName:row.display_name || '', reservationName:row.display_name || row.creator_name || row.member_name, createdBy:row.created_by || row.member_id, createdByName:row.creator_name || row.member_name, seriesId:row.series_id, recurrenceEnd:row.recurrence_end, memberId: row.member_id, memberName: row.member_name, teamId: row.team_id, teamName: row.team_name,
    canCancel: Boolean(member.admin || (upcoming && (row.member_id === member.id || (row.team_id && (context ? context.teamIds.has(row.team_id) : await db.prepare('SELECT 1 FROM team_members WHERE team_id=? AND member_id=?').get(row.team_id, member.id)))))),
  };
}
const bookingSelect = `SELECT b.*,m.name AS member_name,t.name AS team_name,creator.name AS creator_name FROM bookings b
  JOIN members m ON m.id=b.member_id LEFT JOIN teams t ON t.id=b.team_id
  LEFT JOIN members creator ON creator.id=COALESCE(b.created_by,b.member_id)`;
const eventSelect = `SELECT e.*,m.name AS creator_name FROM events e JOIN members m ON m.id=e.created_by`;
function eventView(row, member) {
  return { id: `event-${row.id}`, eventId: row.id, type: 'event', title: row.title, description: row.description,
    date: row.date, start: toTime(row.start_min), end: toTime(row.end_min),
    createdBy: row.created_by, createdByName: row.creator_name, canCancel: Boolean(member.admin), canEdit: Boolean(member.admin) };
}
async function saveEvent(body, actor, id = null) {
  if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 100) fail(400, '일정 제목은 1~100자로 입력해 주세요.');
  if (body.description !== undefined && (typeof body.description !== 'string' || body.description.length > 2000)) fail(400, '일정 설명은 2,000자 이내로 입력해 주세요.');
  if (!validDate(body.date)) fail(400, '일정 날짜를 확인해 주세요.');
  if (body.repeatUntil) fail(400, '커스텀 일정은 날짜별로 등록해 주세요.');
  const start = minutes(body.start), end = minutes(body.end), now = seoulNow();
  if (start < 480 || end > 1440 || end <= start) fail(400, '일정은 08:00부터 24:00 사이에 등록할 수 있습니다.');
  if (body.date < now.date || (body.date === now.date && start <= now.minute)) fail(400, '이미 지난 시간에는 일정을 등록할 수 없습니다.');
  if (body.date > addDays(now.date, 366)) fail(400, '커스텀 일정은 최대 1년 뒤까지 등록할 수 있습니다.');
  if (id !== null && !await db.prepare('SELECT id FROM events WHERE id=?').get(id)) fail(404, '일정을 찾을 수 없습니다.');
  if (await db.prepare('SELECT id FROM bookings WHERE date=? AND start_min<? AND end_min>?').get(body.date, end, start)) fail(409, '기존 예약과 시간이 겹칩니다. 예약을 확인한 뒤 빈 시간에 등록해 주세요.');
  if (await db.prepare('SELECT id FROM events WHERE date=? AND start_min<? AND end_min>? AND id<>?').get(body.date, end, start, id ?? -1)) fail(409, '다른 커스텀 일정과 시간이 겹칩니다.');
  const values = [body.title.trim(), (body.description || '').trim(), body.date, start, end];
  const editing = id !== null;
  if (editing) await db.prepare('UPDATE events SET title=?,description=?,date=?,start_min=?,end_min=? WHERE id=?').run(...values, id);
  else id = Number((await db.prepare('INSERT INTO events(title,description,date,start_min,end_min,created_by) VALUES (?,?,?,?,?,?)').run(...values, actor.id)).lastInsertRowid);
  await audit(db, actor.id, editing ? 'event.update' : 'event.create', { eventId: id });
  return eventView(await db.prepare(`${eventSelect} WHERE e.id=?`).get(id), actor);
}
async function getBooking(id, member) { const row = (await db.prepare(`${bookingSelect} WHERE b.id=?`).get(id)); return row ? (await bookingView(row, member)) : null; }
async function createBooking(body,member,req,replaceId=null) {
  return transaction(async()=>{
    member=(await requireMember(req)).member;
    let previous=null;
    if(replaceId!==null){
      if(!member.admin)fail(403,'운영진만 예약 명의를 변경할 수 있습니다.');
      previous=await db.prepare('SELECT * FROM bookings WHERE id=?').get(replaceId);
      if(!previous)fail(404,'예약을 찾을 수 없습니다.');
      if(previous.type==='personal'&&typeof body.memberId!=='string')fail(400,'예약할 멤버를 선택해 주세요.');
      if(previous.type==='personal'?body.memberId===previous.member_id:Number(body.teamId)===previous.team_id)return {booking:await getBooking(replaceId,member)};
      const time=n=>String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0');
      body={memberId:previous.type==='personal'?body.memberId:previous.member_id,teamId:body.teamId,type:previous.type,date:previous.date,start:time(previous.start_min),end:time(previous.end_min)};
    }
    const {type,date}=body;
    if(!validDate(date))fail(400,'예약 날짜를 확인해 주세요.');
    if(!['personal','team'].includes(type))fail(400,'개인 연습 또는 팀 합주를 선택해 주세요.');
    const start=minutes(body.start),end=minutes(body.end),now=seoulNow(),settings=await getSettings(db);
    if(start<480||end>1440||end<=start)fail(400,'예약은 08:00부터 24:00 사이에 가능합니다.');
    if(date<now.date||(date===now.date&&start<=now.minute))fail(400,'이미 지난 시간은 예약할 수 없습니다.');
    if(replaceId===null&&date>addDays(now.date,settings.advanceWeeks*7))fail(400,`예약은 ${settings.advanceWeeks}주 뒤까지 가능합니다.`);
    let ownerMember=member;
    if(body.memberId!==undefined){
      if(typeof body.memberId!=='string'||!body.memberId.trim()||body.memberId.length>100)fail(400,'예약할 멤버를 선택해 주세요.');
      const ownerId=body.memberId.trim().normalize('NFC');
      if(!member.admin&&ownerId!==member.id)fail(403,'다른 멤버 대신 예약하는 기능은 운영진만 사용할 수 있습니다.');
      ownerMember=await db.prepare('SELECT id,session FROM members WHERE id=?').get(ownerId);
      if(!ownerMember)fail(400,'예약할 멤버를 찾을 수 없습니다.');
    }
    let teamId=null;
    if(type==='team'){
      teamId=Number(body.teamId);
      if(!Number.isSafeInteger(teamId)||!await db.prepare('SELECT id FROM teams WHERE id=?').get(teamId))fail(400,'팀을 선택해 주세요.');
      if(!member.admin&&!await db.prepare('SELECT 1 FROM team_members WHERE team_id=? AND member_id=?').get(teamId,member.id))fail(403,'소속 팀의 합주만 예약할 수 있습니다.');
    }
    const dates=[date];let seriesId=null;
    if(body.repeatUntil){
      if(type!=='team')fail(400,'매주 반복은 팀 합주에서만 사용할 수 있습니다.');
      if(!validDate(body.repeatUntil)||body.repeatUntil<date)fail(400,'반복 종료일은 시작 날짜 이후로 선택해 주세요.');
      if(body.repeatUntil>addDays(now.date,366))fail(400,'정기예약은 최대 1년까지 가능합니다.');
      if(settings.recurringUntil&&body.repeatUntil>settings.recurringUntil)fail(400,`운영진이 설정한 정기예약 마감일 ${settings.recurringUntil}을 넘을 수 없습니다.`);
      for(let day=addDays(date,7);day<=body.repeatUntil;day=addDays(day,7))dates.push(day);
      seriesId=randomToken();
    }
    // Fetch the relevant range once, then validate every date under the DB lock.
    const from=sunday(date),until=addDays(sunday(dates.at(-1)),7);
    const [rows,events]=await Promise.all([
      db.prepare('SELECT date,start_min,end_min,type,member_id,team_id FROM bookings WHERE date>=? AND date<? AND id<>?').all(from,until,replaceId??-1),
      db.prepare('SELECT date,start_min,end_min FROM events WHERE date>=? AND date<?').all(from,until)
    ]);
    const own=rows.filter(r=>r.type===type&&(type==='team'?r.team_id===teamId:r.member_id===ownerMember.id));
    const accepted=[],skipped=[];
    for(const day of dates){
      const policy=reservationPolicy(settings,day,{memberId:ownerMember.id,teamId,type,session:ownerMember.session});
      if(!policy.allowed)fail(403,`${day}: 특별 운영 기간에는 허용된 세션만 개인 연습을 예약할 수 있습니다.`);
      const limit=policy.hours*60;
      const collision=r=>r.date===day&&r.start_min<end&&r.end_min>start;
      if(body.skipConflicts===true && seriesId && (rows.some(collision)||events.some(collision))){skipped.push({date:day,reason:'기존 예약 또는 일정과 겹침'});continue;}
      if(rows.some(collision))fail(409,`${day}: 다른 예약과 시간이 겹칩니다. 빈 시간을 다시 선택해 주세요.`);
      if(events.some(collision))fail(409,`${day}: 커스텀 일정이 있는 시간입니다. 다른 시간을 선택해 주세요.`);
      if(type==='personal'&&own.some(r=>r.date===day))fail(400,`${day}: 개인 연습은 같은 사람 명의로 하루 한 번만 예약할 수 있습니다. 기존 예약을 취소한 뒤 다시 예약해 주세요.`);
      const week=sunday(day),next=addDays(week,7);
      const used=own.filter(r=>r.date>=week&&r.date<next).reduce((n,r)=>n+r.end_min-r.start_min,0);
      if(used+end-start>limit)fail(400,`${day}: ${type==='team'?'팀':'개인'} 주간 예약 한도 ${limit/60}시간을 초과합니다.`);
      let low=start,high=end,changed=true;
      while(changed){changed=false;for(const r of own.filter(r=>r.date===day))if(r.end_min>=low&&r.start_min<=high){const l=Math.min(low,r.start_min),h=Math.max(high,r.end_min);if(l!==low||h!==high){low=l;high=h;changed=true;}}}
      if(high-low>settings.maxContinuousHours*60)fail(400,`${day}: 연속 예약은 최대 ${settings.maxContinuousHours}시간입니다. 이어지는 예약도 포함됩니다.`);
      accepted.push(day);
    }
    if(!accepted.length)fail(409,'모든 날짜가 기존 일정과 겹칩니다. 다른 시간을 선택해 주세요.');
    if(previous){
      await db.prepare('UPDATE bookings SET member_id=?,team_id=?,series_id=NULL,recurrence_end=NULL WHERE id=?').run(ownerMember.id,teamId,replaceId);
      await audit(db,member.id,'booking.transfer',{bookingId:replaceId,previousMemberId:previous.member_id,memberId:ownerMember.id,previousTeamId:previous.team_id,teamId});
      return {booking:await getBooking(replaceId,member)};
    }
    const values=accepted.flatMap(day=>[ownerMember.id,teamId,type,day,start,end,seriesId,body.repeatUntil||null,member.id]);
    const inserted=await db.prepare('INSERT INTO bookings(member_id,team_id,type,date,start_min,end_min,series_id,recurrence_end,created_by) VALUES '+accepted.map(()=>'(?,?,?,?,?,?,?,?,?)').join(',')+' RETURNING id').all(...values);
    await db.prepare('INSERT INTO audit_log(actor_id,action,details) VALUES '+inserted.map(()=>'(?,?,?)').join(',')).run(...inserted.flatMap(r=>[member.id,'booking.create',JSON.stringify({bookingId:r.id,memberId:ownerMember.id,teamId,date:accepted[inserted.indexOf(r)],start:body.start,end:body.end,type,seriesId})]));
    const saved=await db.prepare(`${bookingSelect} WHERE b.id IN (${inserted.map(()=>'?').join(',')}) ORDER BY b.date,b.start_min`).all(...inserted.map(r=>r.id));
    const context={now,settings,teamIds:new Set(teamId===null?[]:[teamId])};
    const bookings=await Promise.all(saved.map(row=>bookingView(row,member,context)));
    return {booking:bookings[0],bookings,count:bookings.length,skipped};
  });
}

async function postView(row, attachments = null) {
  return { id: row.id, kind: row.kind, title: row.title, body: row.body, category: row.category,
    pinned: Boolean(row.pinned), authorId: row.author_id, authorName: row.author_name,
    sourceUrl:row.source_url, embedUrl:notionEmbedUrl(row.source_url), hasDocument:Boolean(row.has_document ?? row.document_html), attachments:attachments ?? (await db.prepare('SELECT id,name,length(content) AS size FROM attachments WHERE post_id=?').all(row.id)), createdAt: row.created_at, updatedAt: row.updated_at };
}
const postSelect = `SELECT p.id,p.kind,p.title,p.body,p.category,p.pinned,p.author_id,p.created_at,p.updated_at,p.source_url,CASE WHEN length(p.document_html)>0 THEN 1 ELSE 0 END AS has_document,m.name AS author_name FROM posts p JOIN members m ON m.id=p.author_id`;
async function listPosts(kind=null) {
  const filter=kind?' WHERE p.kind=?':'';
  let rows;
  if(db.dialect==='postgres'){
    const sql=postSelect.replace(' FROM posts p',`,COALESCE((SELECT json_agg(json_build_object('id',a.id,'name',a.name,'size',length(a.content))) FROM attachments a WHERE a.post_id=p.id),'[]'::json) AS attachment_list FROM posts p`);
    rows=await db.prepare(sql+filter+' ORDER BY p.pinned DESC,p.updated_at DESC,p.id DESC').all(...(kind?[kind]:[]));
    return Promise.all(rows.map(r=>postView(r,r.attachment_list)));
  }
  rows=await db.prepare(postSelect+filter+' ORDER BY p.pinned DESC,p.updated_at DESC,p.id DESC').all(...(kind?[kind]:[]));
  const attachments=await db.prepare(`SELECT a.id,a.post_id,a.name,length(a.content) AS size FROM attachments a JOIN posts p ON p.id=a.post_id${filter}`).all(...(kind?[kind]:[]));
  const byPost=new Map();for(const {post_id,...a}of attachments){if(!byPost.has(post_id))byPost.set(post_id,[]);byPost.get(post_id).push(a)}
  return Promise.all(rows.map(r=>postView(r,byPost.get(r.id)||[])));
}
function validatePost(body) {
  if (!['notice', 'wiki'].includes(body.kind)) fail(400, '공지 또는 위키를 선택해 주세요.');
  if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 150) fail(400, '제목은 1~150자로 입력해 주세요.');
  const url=sourceUrl(body.sourceUrl);
  if(notionEmbedUrl(url) && (body.body == null || (typeof body.body === 'string' && !body.body.trim())))body.body='노션 페이지';
  if (typeof body.body !== 'string' || !body.body.trim() || body.body.length > 30000) fail(400, '내용은 1~30,000자로 입력해 주세요.');
  return [body.kind, body.title.trim(), body.body.trim(), cleanText(body.category, 50), body.pinned === true ? 1 : 0, url];
}
async function storePreview(workbook, session) {
  const preview = (await previewImport(db, workbook, session.member.id));
  let token = null;
  if (preview.valid) {
    await removeUploads(session.hash);
    token = await state.preview(session,workbook);
  }
  return { token, preview };
}
async function scheduleData(member, dateValue, includeOptions = true) {
    const date = dateValue || seoulNow().date;
    if (!validDate(date)) fail(400, '날짜를 확인해 주세요.');
    const week = sunday(date);
    const {rows, settings, usage, events, ...options} = await readSchedule(db, member, week, addDays(week, 7), includeOptions);
    const context = {now:seoulNow(), settings, teamIds:new Set(usage.teams.map(t=>t.teamId))};
    const bookings = [...await Promise.all(rows.map(row => bookingView(row, member, context))), ...events.map(row => eventView(row, member))];
    bookings.sort((a,b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
    return { bookings, week, settings, usage, ...options };
}

async function initialData(member,routeValue,weekValue) {
    // Forced password changes must never expose calendar or management data.
    if (member.must_change_password) return {member:memberView(member,[]),setupRequired:false};
    let route = routeValue || (member.admin ? 'members' : 'schedule');
    if (!['schedule','members','settings','guide','notice','wiki'].includes(route) ||
        (!member.admin && ['members','settings','guide'].includes(route))) route='schedule';
    let initial, view;
    if (route === 'schedule') {
      const b = await scheduleData(member,weekValue);
      const memberships = b.teams.flatMap(t=>t.members.filter(m=>m.id===member.id).map(m=>({id:t.id,name:t.name,slot:m.slot})));
      view=memberView(member,memberships);
      initial={key:'schedule:'+b.week,data:{bookingData:b,bookings:b.bookings,teams:b.teams}};
    } else if (route === 'members') {
      const {members,teams}=await readDirectory(db);
      view=members.find(m=>m.id===member.id);
      initial={key:'members',data:{members,teams}};
    } else if(route==='notice'||route==='wiki'){
      const [profile,posts]=await Promise.all([safeMember(member),listPosts()]);
      view=profile;initial={key:'notice',data:{posts}};
    } else view=await safeMember(member);
    return {member:view,setupRequired:false,initial};
}

async function api(req, res, url) {
  const path = url.pathname; const method = req.method;
  if (path === '/api/logout' && method === 'POST') {
    clearSession(res);
    const raw = readCookies(req.headers.cookie).mooboong_session;
    if (raw && /^[A-Za-z0-9_-]{43}$/.test(raw)) {
      const hash = tokenHash(raw);
      await db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash);
      await removeUploads(hash);
    }
    return send(res, 200, { ok: true });
  }
  // Expiry is enforced in session/upload/rate queries. Reclaim storage on writes,
  // so a read-only first visit never waits for maintenance DELETEs.
  if (!['GET','HEAD'].includes(method)) await cleanExpired();
  if (path === '/api/bootstrap' && method === 'GET') {
    const session = await sessionFrom(req);
    if (!session) return send(res, 200, {member:null,
      setupRequired:!(await db.prepare('SELECT 1 FROM members LIMIT 1').get()),
      setupTokenRequired:Boolean(process.env.SETUP_TOKEN)});
    return send(res,200,await initialData(session.member,url.searchParams.get('route'),url.searchParams.get('week')));
  }
  if (path === '/api/status' && method === 'GET') return send(res, 200, { service:'mooboong', storage:db.dialect, setupRequired: !(await db.prepare('SELECT 1 FROM members LIMIT 1').get()), setupTokenRequired:Boolean(process.env.SETUP_TOKEN) });
  if (path === '/api/setup' && method === 'POST') {
    if ((await db.prepare('SELECT 1 FROM members LIMIT 1').get())) fail(409, '이미 초기 설정이 완료되었습니다. 로그인해 주세요.');
    const body = await jsonBody(req);
    await checkLoginRate(req, '__initial_setup__');
    if(process.env.SETUP_TOKEN && body.setupToken !== process.env.SETUP_TOKEN)fail(403,'초기 설정 키를 확인해 주세요.');
    if(appOrigin && !process.env.SETUP_TOKEN)fail(503,'공개 운영의 초기 설정 키가 필요합니다.');
    const id = cleanText(body.id, 100).normalize('NFC'), name = cleanText(body.name, 100).normalize('NFC');
    if (!id || !name || typeof body.password !== 'string' || body.password.length < 4 || body.password.length > 128 || body.password === '20000000') fail(400, '이름·아이디와 기본값이 아닌 4~128자 비밀번호를 입력해 주세요.');
    (await transaction(async () => {
      if ((await db.prepare('SELECT 1 FROM members LIMIT 1').get())) fail(409, '이미 초기 설정이 완료되었습니다. 로그인해 주세요.');
      (await db.prepare('INSERT INTO members(id,name,password_hash,admin,must_change_password) VALUES (?,?,?,1,0)').run(id, name, hashPassword(body.password)));
      (await audit(db, id, 'setup.complete'));
    }));
    (await seedGuides(db));
    (await createSession(res, id));
    return send(res, 201, { member: (await safeMember((await db.prepare('SELECT * FROM members WHERE id=?').get(id)))) });
  }
  if (path === '/api/login' && method === 'POST') {
    const body = await jsonBody(req); const id = cleanText(body.id, 100).normalize('NFC');
    await checkLoginRate(req, id);
    const member = (await db.prepare('SELECT * FROM members WHERE id=?').get(id));
    const password = typeof body.password === 'string' && body.password.length <= 128 ? body.password : '';
    if (!verifyPassword(password, member?.password_hash || dummyHash) || !member) fail(401, '아이디 또는 비밀번호를 확인해 주세요.');
    await state.clearRate(id);
    (await createSession(res, id));
    return send(res, 200, await initialData(member,body.route,body.week));
  }
  if (path === '/api/me' && method === 'GET') return send(res, 200, { member: (await safeMember((await requireMember(req, { allowPasswordChange: true })).member)) });
  if (path === '/api/password' && method === 'POST') {
    const session = (await requireMember(req, { allowPasswordChange: true })); const body = await jsonBody(req);
    if (typeof body.newPassword !== 'string' || body.newPassword.length < 4 || body.newPassword.length > 128 || body.newPassword === body.currentPassword || body.newPassword === '20000000') fail(400, '기본값·기존 비밀번호와 다른 4~128자 비밀번호를 입력해 주세요.');
    (await transaction(async () => {
      const fresh = await requireMember(req, { allowPasswordChange: true });
      if (typeof body.currentPassword !== 'string' || body.currentPassword.length > 128 || !verifyPassword(body.currentPassword, fresh.member.password_hash)) fail(400, '현재 비밀번호가 올바르지 않습니다.');
      (await db.prepare("UPDATE members SET password_hash=?,must_change_password=0,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(hashPassword(body.newPassword), session.member.id));
      (await db.prepare('DELETE FROM sessions WHERE member_id=? AND token_hash<>?').run(session.member.id, session.hash));
      (await audit(db, session.member.id, 'password.change'));
    }));
    await removeUploads(session.hash);
    return send(res, 200, { member: (await safeMember((await db.prepare('SELECT * FROM members WHERE id=?').get(session.member.id)))) });
  }
  const session = (await requireMember(req));
  const member = session.member;
  if (path === '/api/uploads' && method === 'POST') {
    if (!member.admin) fail(403, '운영진만 사용할 수 있습니다.');
    const body=await jsonBody(req);
    const limit=['/api/wiki/import','/api/markdown/import'].includes(body.path)?20:body.path==='/api/import/file'?4:/^\/api\/posts\/\d+\/attachments$/.test(body.path||'')?10:0;
    if (!limit || !Number.isInteger(body.size) || body.size<1 || body.size>limit*1024*1024) fail(400,'파일 크기 또는 업로드 경로를 확인해 주세요.');
    return send(res,201,{token:await state.create(session,body.path,body.size)});
  }
  const chunkMatch=path.match(/^\/api\/uploads\/([A-Za-z0-9_-]{43})\/(\d+)$/);
  if(chunkMatch && method==='PUT') {
    if (!member.admin) fail(403, '운영진만 사용할 수 있습니다.');
    await state.put(session,chunkMatch[1],Number(chunkMatch[2]),await readBody(req,1024*1024));
    return send(res,200,{ok:true});
  }
  if(await contentRoutes(req,res,url,db,member,{readBody,send,fail,transaction}))return;
  if(path==='/api/feedback'&&method==='POST'){
    const body=await jsonBody(req),message=cleanText(body.message,2000);
    if(!message)fail(400,'문의 내용을 입력해 주세요.');
    await transaction(async()=>{
      const actor=(await requireMember(req)).member;
      const count=await db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE actor_id=? AND action='feedback' AND created_at>=?").get(actor.id,new Date(Date.now()-86400000).toISOString());
      if(Number(count.n)>=5)fail(429,'문의는 하루 최대 5건까지 보낼 수 있습니다.');
      await audit(db,actor.id,'feedback',{message});
    });
    return send(res,201,{ok:true});
  }
  if(path==='/api/activity'&&method==='GET'){
    if(!member.admin)fail(403,'운영진만 사용할 수 있습니다.');
    const rows=await db.prepare(`SELECT a.id,a.action,a.details,a.created_at,m.name AS actor_name FROM audit_log a LEFT JOIN members m ON m.id=a.actor_id WHERE (?=0 OR a.action IN ('booking.cancel','booking.cancel_series','event.delete')) ORDER BY a.id DESC LIMIT 100`).all(url.searchParams.get('filter')==='cancellations'?1:0);
    return send(res,200,{entries:rows.map(r=>({...r,details:JSON.parse(r.details)}))});
  }
  if (path === '/api/profile' && method === 'PATCH') {
    const body=await jsonBody(req);
    const name=cleanText(body.name,100).normalize('NFC');
    if(!name)fail(400,'이름을 입력해 주세요.');
    await transaction(async()=>{
      const actor=(await requireMember(req)).member;
      await db.prepare("UPDATE members SET name=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(name,actor.id);
      await audit(db,actor.id,'profile.update',{name});
    });
    return send(res,200,{member:await safeMember(await db.prepare('SELECT * FROM members WHERE id=?').get(member.id))});
  }
  if (path === '/api/members/update' && method === 'POST') {
    if(!member.admin)fail(403,'운영진만 사용할 수 있습니다.');
    const body=await jsonBody(req);
    if(typeof body.id!=='string'||!await db.prepare('SELECT id FROM members WHERE id=?').get(body.id))fail(404,'멤버를 찾을 수 없습니다.');
    const result=await applyImport(db,{members:[{'아이디':body.id,'이름':body.name,'세션':body.session,'기수':body.generation,'전화번호':body.phone,'관리자여부':body.admin===true?'Y':'N'}]},member.id);
    return send(res,200,result);
  }
  if (['/api/teams/update','/api/teams/create'].includes(path) && method === 'POST') {
    if(!member.admin)fail(403,'운영진만 사용할 수 있습니다.');
    const body=await jsonBody(req),creating=path==='/api/teams/create';let id=Number(body.id);
    if(!creating&&(!Number.isSafeInteger(id)||id<1))fail(400,'팀 번호를 확인해 주세요.');
    const name=cleanText(body.name,100).normalize('NFC');
    if(!name||name.includes(','))fail(400,'쉼표 없이 팀 이름을 입력해 주세요.');
    await transaction(async()=>{
      const actor=(await requireMember(req,{admin:true})).member;
      const before=creating?{name:''}:await db.prepare('SELECT name FROM teams WHERE id=?').get(id);
      if(!before)fail(404,'팀을 찾을 수 없습니다.');
      if(await db.prepare('SELECT id FROM teams WHERE name=? AND id<>?').get(name,creating?-1:id))fail(409,'같은 이름의 팀이 있습니다.');
      if(creating)id=Number((await db.prepare('INSERT INTO teams(name) VALUES (?)').run(name)).lastInsertRowid);
      else await db.prepare('UPDATE teams SET name=? WHERE id=?').run(name,id);
      await applyImport(db,{teams:[{'팀명':name,...Object.fromEntries(Object.entries({보컬:'vocal',기타1:'guitar1',기타2:'guitar2',베이스:'bass',드럼:'drums',키보드:'keyboard'}).map(([label,slot])=>[label,body.slots?.[slot]||'']))}]},actor.id);
      await audit(db,actor.id,creating?'team.create':'team.update',{teamId:id,previousName:before.name,name});
    });
    return send(res,200,{ok:true});
  }
  if (path === '/api/directory' && method === 'GET') {
    if(!member.admin)fail(403,'운영진만 사용할 수 있습니다.');
    return send(res,200,await readDirectory(db));
  }
  if (path === '/api/members' && method === 'GET') {
    if (!member.admin) fail(403, '운영진만 사용할 수 있습니다.');
    return send(res, 200, { members: await listMembers(db) });
  }
  if (path === '/api/members/export' && method === 'GET') {
    if (!member.admin) fail(403, '운영진만 사용할 수 있습니다.');
    const workbook = await exportMembers(db, url.searchParams.get('sort'), url.searchParams.get('order'));
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="mooboong-members-${seoulNow().date}.xlsx"`,
      'Content-Length': workbook.length, 'Cache-Control': 'no-store',
    });
    return res.end(workbook);
  }
  if (path === '/api/members/password-reset' && method === 'POST') {
    const operator = await requireMember(req, { admin: true });
    const body = await jsonBody(req);
    const targetId = cleanText(body.memberId, 100).normalize('NFC');
    if (!targetId) fail(400, '멤버 아이디를 확인해 주세요.');
    if (targetId === operator.member.id) fail(400, '본인 비밀번호는 비밀번호 변경 메뉴에서 바꿔 주세요.');
    if (typeof body.newPassword !== 'string' || body.newPassword.length < 4 || body.newPassword.length > 128 || !body.newPassword.trim()) fail(400, '임시 비밀번호는 4~128자로 입력해 주세요.');
    await checkLoginRate(req, operator.member.id);
    await transaction(async () => {
      const current = await requireMember(req, { admin: true });
      if (typeof body.operatorPassword !== 'string' || body.operatorPassword.length > 128 || !verifyPassword(body.operatorPassword, current.member.password_hash)) fail(403, '운영진 본인의 현재 비밀번호를 확인해 주세요.');
      const target = await db.prepare('SELECT * FROM members WHERE id=?').get(targetId);
      if (!target) fail(404, '멤버를 찾을 수 없습니다.');
      if (verifyPassword(body.newPassword, target.password_hash)) fail(400, '기존 비밀번호와 다른 임시 비밀번호를 입력해 주세요.');
      await db.prepare("UPDATE members SET password_hash=?,must_change_password=1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(hashPassword(body.newPassword), targetId);
      const oldSessions = await db.prepare('SELECT token_hash FROM sessions WHERE member_id=?').all(targetId);
      await db.prepare('DELETE FROM sessions WHERE member_id=?').run(targetId);
      await audit(db, current.member.id, 'password.reset', { memberId: targetId });
      for (const old of oldSessions) await removeUploads(old.token_hash);
    });
    await state.clearRate(operator.member.id);
    return send(res, 200, { ok: true, mustChangePassword: true });
  }
  if (path === '/api/booking-options' && method === 'GET') {
    if (!member.admin) fail(403, '운영진만 사용할 수 있습니다.');
    return send(res, 200, { members: await db.prepare('SELECT id,name,session FROM members ORDER BY name,id').all() });
  }
  if (path === '/api/teams' && method === 'GET') {const teams=await teamList();return send(res,200,{teams:member.admin?teams:teams.filter(t=>t.members.some(m=>m.id===member.id))});}
  if (['/api/bookings','/api/schedule'].includes(path) && method === 'GET') {
    return send(res, 200, await scheduleData(member, url.searchParams.get('week'), path === '/api/schedule'));
  }
  const eventMatch = path.match(/^\/api\/events\/(\d+)$/);
  if ((path === '/api/events' && method === 'POST') || (eventMatch && ['PUT', 'DELETE'].includes(method))) {
    if (!member.admin) fail(403, '운영진만 커스텀 일정을 관리할 수 있습니다.');
    const body = method === 'DELETE' ? null : await jsonBody(req);
    const result = await transaction(async () => {
      // Recheck privileges while holding the same lock used by booking creation.
      const current = await requireMember(req, { admin: true });
      const id = eventMatch ? Number(eventMatch[1]) : null;
      if (method === 'DELETE') {
        const before=await db.prepare('SELECT title,date,start_min,end_min FROM events WHERE id=?').get(id);
        if(!before)fail(404,'일정을 찾을 수 없습니다.');
        await db.prepare('DELETE FROM events WHERE id=?').run(id);
        await audit(db, current.member.id, 'event.delete', { eventId:id,title:before.title,date:before.date,start:toTime(before.start_min),end:toTime(before.end_min) });
        return { ok: true };
      }
      return { event: await saveEvent(body, current.member, id) };
    });
    return send(res, method === 'POST' ? 201 : 200, result);
  }
  if (path === '/api/bookings' && method === 'POST') return send(res, 201, (await createBooking(await jsonBody(req), member, req)));
  const ownerMatch=path.match(/^\/api\/bookings\/(\d+)\/owner$/);
  if(ownerMatch&&method==='PATCH')return send(res,200,await createBooking(await jsonBody(req),member,req,Number(ownerMatch[1])));
  const nameMatch=path.match(/^\/api\/bookings\/(\d+)\/name$/);
  if (nameMatch && method === 'PATCH') {
    const body=await jsonBody(req);
    if(typeof body.name!=='string'||body.name.trim().length>100)fail(400,'표시할 이름은 100자 이내로 입력해 주세요.');
    const id=Number(nameMatch[1]);
    await transaction(async()=>{
      const actor=(await requireMember(req,{admin:true})).member;
      const before=await db.prepare('SELECT display_name FROM bookings WHERE id=?').get(id);
      if(!before)fail(404,'예약을 찾을 수 없습니다.');
      const name=body.name.trim();
      await db.prepare('UPDATE bookings SET display_name=? WHERE id=?').run(name,id);
      await audit(db,actor.id,'booking.rename',{bookingId:id,previousName:before.display_name,name});
    });
    return send(res,200,{booking:await getBooking(id,member)});
  }
  const seriesMatch = path.match(/^\/api\/bookings\/(\d+)\/series$/);
  if (seriesMatch && ['GET', 'DELETE'].includes(method)) {
    const loadSeries = async viewer => {
      const selected = await db.prepare('SELECT series_id,type FROM bookings WHERE id=?').get(Number(seriesMatch[1]));
      if (!selected) fail(404, '예약을 찾을 수 없습니다.');
      if (selected.type !== 'team' || !selected.series_id) fail(400, '반복으로 등록된 팀 합주만 전체 취소할 수 있습니다.');
      const rows = await db.prepare(`${bookingSelect} WHERE b.series_id=? ORDER BY b.date,b.start_min,b.id`).all(selected.series_id);
      const [settings, memberships] = await Promise.all([getSettings(db), db.prepare('SELECT team_id FROM team_members WHERE member_id=?').all(viewer.id)]);
      const context = {now:seoulNow(), settings, teamIds:new Set(memberships.map(t=>t.team_id))};
      const bookings = await Promise.all(rows.map(row => bookingView(row, viewer, context)));
      return { seriesId: selected.series_id, bookings, count: bookings.length, canCancelAll: bookings.every(b => b.canCancel) };
    };
    if (method === 'GET') return send(res, 200, await loadSeries(member));
    const count = await transaction(async () => {
      const current = await requireMember(req);
      const series = await loadSeries(current.member);
      if (!series.canCancelAll) fail(403, '전체 예약 중 취소할 수 없는 날짜가 있습니다. 지난 예약·당일 취소 제한 또는 소속 팀을 확인하고 운영진에게 문의해 주세요.');
      const deleted = await db.prepare('DELETE FROM bookings WHERE series_id=?').run(series.seriesId);
      await audit(db, current.member.id, 'booking.cancel_series', { seriesId: series.seriesId, bookingIds: series.bookings.map(b => b.id), bookings:series.bookings.map(b=>({id:b.id,date:b.date,start:b.start,end:b.end,memberName:b.memberName,teamId:b.teamId,teamName:b.teamName,reservationName:b.reservationName})), count: deleted.changes });
      return deleted.changes;
    });
    return send(res, 200, { ok: true, count });
  }
  const bookingMatch = path.match(/^\/api\/bookings\/(\d+)$/);
  if (bookingMatch && method === 'DELETE') {
    await transaction(async () => {
      const booking = await getBooking(Number(bookingMatch[1]), member);
      if (!booking) fail(404, '예약을 찾을 수 없습니다.');
      if (!booking.canCancel) fail(403, '취소할 수 없는 예약입니다. 당일 취소 제한 또는 시작 시간을 확인하고 운영진에게 문의해 주세요.');
      await db.prepare('DELETE FROM bookings WHERE id=?').run(booking.id);
      await audit(db, member.id, 'booking.cancel', { bookingId: booking.id,date:booking.date,start:booking.start,end:booking.end,memberId:booking.memberId,memberName:booking.memberName,teamId:booking.teamId,teamName:booking.teamName,reservationName:booking.reservationName,seriesId:booking.seriesId });
    });
    return send(res, 200, { ok: true });
  }
  if (path === '/api/posts' && method === 'GET') {
    const kind = url.searchParams.get('kind');
    if (kind && !['notice', 'wiki'].includes(kind)) fail(400, '게시물 종류를 확인해 주세요.');
    return send(res,200,{posts:await listPosts(kind)});
  }

  const postMatch = path.match(/^\/api\/posts\/(\d+)$/);
  if (postMatch && method === 'DELETE') {
    await transaction(async()=>{
      const actor=(await requireMember(req,{admin:true})).member;
      const id=Number(postMatch[1]);
      const post=await db.prepare('SELECT system_key FROM posts WHERE id=?').get(id);
      if (!(await db.prepare('DELETE FROM posts WHERE id=?').run(id)).changes) fail(404,'게시물을 찾을 수 없습니다.');
      await audit(db,actor.id,'post.delete',{postId:id,systemKey:post?.system_key});
    });
    return send(res,200,{ok:true});
  }
  if ((path === '/api/posts' && method === 'POST') || (postMatch && method === 'PUT')) {
    (await requireMember(req, { admin: true }));
    const values = validatePost(await jsonBody(req));
    const id = (await transaction(async () => {
      let id;
      if (postMatch) {
        id = Number(postMatch[1]);
        if (!(await db.prepare('SELECT id FROM posts WHERE id=?').get(id))) fail(404, '게시물을 찾을 수 없습니다.');
        (await db.prepare("UPDATE posts SET kind=?,title=?,body=?,category=?,pinned=?,source_url=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(...values, id));
      } else id = Number((await db.prepare('INSERT INTO posts(kind,title,body,category,pinned,source_url,author_id) VALUES (?,?,?,?,?,?,?)').run(...values, member.id)).lastInsertRowid);
      (await audit(db, member.id, postMatch ? 'post.update' : 'post.create', { postId: id })); return id;
    }));
    return send(res, postMatch ? 200 : 201, { post: (await postView((await db.prepare(`${postSelect} WHERE p.id=?`).get(id)))) });
  }
  if (path === '/api/settings' && method === 'GET') {if(!member.admin)fail(403,'운영진만 사용할 수 있습니다.');return send(res,200,{settings:await getSettings(db)});}
  if (path === '/api/settings' && method === 'PUT') {
    (await requireMember(req, { admin: true })); const body = await jsonBody(req);
    const settings = await transaction(async () => {
    const settings = await getSettings(db);
    for (const key of ['personalWeeklyHours', 'teamWeeklyHours', 'maxContinuousHours']) {
      const value = body[key];
      if (value !== undefined) {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.5 || value > 40 || value * 2 !== Math.round(value * 2)) fail(400, '시간 제한은 0.5~40시간을 0.5시간 단위로 입력해 주세요.');
        settings[key] = value;
      }
    }
    validatePolicies(body,validDate,fail);
    if(body.specialPolicy!==undefined)settings.specialPolicy=body.specialPolicy;
    if(body.quotaOverrides!==undefined){
      for(const r of body.quotaOverrides){if(!await db.prepare(r.type==='team'?'SELECT id FROM teams WHERE id=?':'SELECT id FROM members WHERE id=?').get(r.id))fail(400,'개별 한도의 대상을 찾을 수 없습니다.');}
      settings.quotaOverrides=body.quotaOverrides;
    }
    if (body.advanceWeeks !== undefined) {
      if (!Number.isInteger(body.advanceWeeks) || body.advanceWeeks < 1 || body.advanceWeeks > 52) fail(400, '예약 가능 범위는 1~52주로 입력해 주세요.');
      settings.advanceWeeks = body.advanceWeeks;
    }
    if(body.blockSameDayCancellation!==undefined){if(typeof body.blockSameDayCancellation!=='boolean')fail(400,'당일 취소 제한 설정을 확인해 주세요.');settings.blockSameDayCancellation=body.blockSameDayCancellation;}
    if (body.recurringUntil !== undefined) {
      if (body.recurringUntil !== '' && !validDate(body.recurringUntil)) fail(400, '정기예약 종료일을 확인해 주세요.');
      settings.recurringUntil = body.recurringUntil;
    }
      for (const [key, value] of Object.entries(settings)) (await db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)));
      (await audit(db, member.id, 'settings.update', settings));
    return settings;
    });
    return send(res, 200, { settings });
  }
  if (path === '/api/import/file' && method === 'POST') {
    (await requireMember(req, { admin: true }));
    if (!['application/octet-stream', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'].includes(String(req.headers['content-type'] || '').split(';')[0])) fail(415, '.xlsx 파일을 업로드해 주세요.');
    const bytes = await readBody(req, 4 * 1024 * 1024);
    if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) fail(400, '올바른 .xlsx 파일을 선택해 주세요.');
    return send(res, 200, (await storePreview(await parseXlsx(bytes), session)));
  }
  if (path === '/api/import/preview' && method === 'POST') {
    (await requireMember(req, { admin: true })); const body = await jsonBody(req);
    return send(res, 200, (await storePreview(body.workbook || body, session)));
  }
  if (path === '/api/import/commit' && method === 'POST') {
    (await requireMember(req, { admin: true })); const body = await jsonBody(req);
    let workbook;
    if (typeof body.token === 'string') {
      workbook = JSON.parse((await state.take(session,body.token,'preview')).toString('utf8'));
    } else if (body.workbook) workbook = body.workbook;
    else fail(400, '먼저 엑셀 파일을 업로드하고 검토해 주세요.');
    const result = (await applyImport(db, workbook, member.id));
    return send(res, 200, result);
  }
  fail(404, '요청한 기능을 찾을 수 없습니다.');
}

const mimeTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.woff2': 'font/woff2' };
async function staticFile(req, res, url) {
  if (!['GET', 'HEAD'].includes(req.method)) fail(405, '지원하지 않는 요청입니다.');
  let decoded;
  try { decoded = decodeURIComponent(url.pathname); } catch { fail(400, '잘못된 주소입니다.'); }
  if (decoded.includes('\0') || decoded.includes('\\')) fail(400, '잘못된 주소입니다.');
  const filename = resolve(publicRoot, `.${decoded === '/' ? '/index.html' : decoded}`);
  if (!filename.startsWith(publicRoot + sep)) fail(404, '파일을 찾을 수 없습니다.');
  let info;
  try {
    if (!(await realpath(filename)).startsWith((await realpath(publicRoot)) + sep)) fail(404, '파일을 찾을 수 없습니다.');
    info = await stat(filename);
  } catch { fail(404, '파일을 찾을 수 없습니다.'); }
  if (!info.isFile()) fail(404, '파일을 찾을 수 없습니다.');
  res.writeHead(200, { 'Content-Type': mimeTypes[extname(filename)] || 'application/octet-stream', 'Content-Length': info.size, 'Cache-Control': 'no-cache' });
  res.end(req.method === 'HEAD' ? undefined : await readFile(filename));
}

export async function handleRequest(req, res) {
  const requestId=randomToken().slice(0,12),started=performance.now();let responseStatus=200,initMs=0;
  const originalWriteHead=res.writeHead.bind(res);res.writeHead=(status,...args)=>{responseStatus=status;res.setHeader('Server-Timing',`init;dur=${initMs.toFixed(1)}, app;dur=${(performance.now()-started).toFixed(1)}`);return originalWriteHead(status,...args)};
  res.setHeader('X-Request-ID',requestId);

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self' https://*.notion.site; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  try {
    const initStart=performance.now();await initializeApp();initMs=performance.now()-initStart;
    if (!(appOrigin ? [new URL(appOrigin).host,`127.0.0.1:${port}`,`localhost:${port}`] : [`127.0.0.1:${port}`, `localhost:${port}`]).includes(req.headers.host)) fail(403, '로컬 주소로 접속해 주세요.');
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) { csrf(req); await db.withRequest(async () => (await api(req, res, url))); }
    else await staticFile(req, res, url);
  } catch (error) {
    if (res.headersSent || res.destroyed) { res.end(); return; }
    const status = Number.isInteger(error.status) ? error.status : 500;
    if (status === 500) console.error('Request failed:', error.code || error.name || 'Error');
    const result = { requestId, error: status === 500 ? '서버에서 요청을 처리하지 못했습니다.' : error.message };
    if (error.code && status !== 500) result.code = error.code;
    if (error.preview) result.preview = error.preview;
    send(res, status, result);
  } finally {
    const durationMs=Math.round(performance.now()-started);
    if(req.url.startsWith('/api/')&&(durationMs>=1000||responseStatus>=500))console.info(JSON.stringify({event:'api.request',requestId,method:req.method,route:req.url.split('?')[0].split('/').slice(0,3).join('/'),status:responseStatus,durationMs}));
  }
}
export const server = http.createServer(handleRequest);
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.on('error', async error => {
  if (error.code === 'EADDRINUSE') {
    console.error(`${port}번 포트가 이미 사용 중입니다. start.command로 실행하면 기존 무붕 사이트를 확인할 수 있습니다.`);
  } else {
    console.error(`서버를 시작하지 못했습니다: ${error.code || error.message}`);
  }
  (await db.close());
  process.exitCode = 1;
});
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await initializeApp();
  server.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`무붕 로컬 미리보기: http://127.0.0.1:${port}`));
}
function shutdown() { server.close(async () => { (await db.close()); process.exit(0); }); }
if (!process.env.NETLIFY) { process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown); }
export const closeDatabase = () => db?.close();

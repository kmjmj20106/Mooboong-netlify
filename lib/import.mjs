import { hashPassword } from './security.mjs';

export const MEMBER_HEADERS = ['아이디', '이름', '비밀번호', '세션', '기수', '전화번호', '팀', '관리자여부'];
export const TEAM_HEADERS = ['팀명', '보컬', '기타1', '기타2', '베이스', '드럼', '키보드'];
export const SLOTS = Object.freeze({ 보컬: 'vocal', 기타1: 'guitar1', 기타2: 'guitar2', 베이스: 'bass', 드럼: 'drums', 키보드: 'keyboard' });
const DEFAULT_PASSWORD = '20000000';
const MAX_ROWS = 1000;

async function planImport(db, workbook, actorId) {
  const errors = [], warnings = [];
  const error = (sheet, row, column, message) => errors.push({ sheet, row, column, message });
  const warn = (sheet, row, column, message) => warnings.push({ sheet, row, column, message });
  const existingMembers = new Map((await db.prepare('SELECT * FROM members').all()).map(m => [m.id, m]));
  const existingTeams = new Map((await db.prepare('SELECT * FROM teams').all()).map(t => [t.name, { ...t, slots: {} }]));
  const teamById = new Map([...existingTeams.values()].map(t => [t.id, t]));
  for (const link of (await db.prepare('SELECT team_id,slot,member_id FROM team_members').all())) {
    if (link.member_id && teamById.has(link.team_id)) teamById.get(link.team_id).slots[link.slot] = link.member_id;
  }
  if (!existingMembers.get(actorId)?.admin) error('파일', 0, '', '관리자만 일괄 등록할 수 있습니다.');
  if (!workbook || typeof workbook !== 'object' || Array.isArray(workbook)) {
    error('파일', 0, '', '등록할 파일 형식이 올바르지 않습니다.');
    workbook = {};
  }
  for (const key of ['members', 'teams']) {
    if (workbook[key] !== undefined && !Array.isArray(workbook[key])) error('파일', 0, '', '멤버와 팀은 행 목록이어야 합니다.');
    if (Array.isArray(workbook[key]) && workbook[key].length > MAX_ROWS) error(key === 'members' ? '멤버' : '팀', 0, '', `한 시트에 최대 ${MAX_ROWS}행까지 등록할 수 있습니다.`);
  }
  const memberRows = Array.isArray(workbook.members) ? workbook.members.slice(0, MAX_ROWS) : [];
  const teamRows = Array.isArray(workbook.teams) ? workbook.teams.slice(0, MAX_ROWS) : [];
  const members = [], teams = [], seenMembers = new Set(), seenTeams = new Set();
  const text = (value, sheet, row, column, max = 100) => {
    if (value === undefined || value === null) return '';
    if (!['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) {
      error(sheet, row, column, '문자 또는 숫자로 입력해 주세요.'); return '';
    }
    const result = String(value).trim().normalize('NFC');
    if (result.length > max) error(sheet, row, column, `${max}자 이하로 입력해 주세요.`);
    if (/[\u0000-\u001f\u007f]/u.test(result)) error(sheet, row, column, '줄바꿈이나 제어 문자는 사용할 수 없습니다.');
    return result.slice(0, max);
  };
  function validRow(raw, headers, sheet, index) {
    const row = Number.isSafeInteger(raw?.__row) && raw.__row >= 2 ? raw.__row : index + 2;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { error(sheet, row, '', '행 형식이 올바르지 않습니다.'); return null; }
    const populated = headers.some(h => raw[h] !== undefined && raw[h] !== null && String(raw[h]).trim() !== '');
    if (!populated) return null;
    for (const key of Object.keys(raw)) if (!headers.includes(key) && key !== '__row') error(sheet, row, '', '양식에 없는 열이 있습니다. 내려받은 양식의 제목을 사용해 주세요.');
    return row;
  }
  memberRows.forEach((raw, i) => {
    const row = validRow(raw, MEMBER_HEADERS, '멤버', i); if (!row) return;
    const name = text(raw['이름'], '멤버', row, '이름');
    const id = text(raw['아이디'], '멤버', row, '아이디') || name;
    if (!name) error('멤버', row, '이름', '이름을 입력해 주세요.');
    if (!id) error('멤버', row, '아이디', '아이디 또는 이름이 필요합니다.');
    if (seenMembers.has(id)) error('멤버', row, '아이디', '파일 안에 같은 아이디가 있습니다. 동명이인은 서로 다른 아이디를 입력해 주세요.');
    seenMembers.add(id);
    const existing = existingMembers.get(id);
    const adminInput = text(raw['관리자여부'], '멤버', row, '관리자여부', 10).toUpperCase();
    if (adminInput && !['Y', 'N'].includes(adminInput)) error('멤버', row, '관리자여부', '관리자여부는 Y 또는 N으로 입력해 주세요.');
    const admin = adminInput === 'Y' ? 1 : adminInput === 'N' ? 0 : existing?.admin || 0;
    if (id === actorId && !admin) error('멤버', row, '관리자여부', '현재 로그인한 관리자의 권한은 일괄 등록으로 해제할 수 없습니다.');
    if (admin && !existing?.admin) warn('멤버', row, '관리자여부', '관리자 권한을 부여합니다.');
    const phone = text(raw['전화번호'], '멤버', row, '전화번호', 40);
    if (typeof raw['전화번호'] === 'number' || (phone && !/^(?:0[\d ()-]{8,18}|\+[\d ()-]{8,20})$/.test(phone))) {
      error('멤버', row, '전화번호', '전화번호는 0 또는 국가번호(+)로 시작하는 문자로 입력해 주세요. 앞자리 0이 사라졌는지 확인해 주세요.');
    }
    const teamNames = [];
    if (raw['팀'] != null && String(raw['팀']).trim()) warn('멤버', row, '팀', '팀 칸은 자동으로 채워집니다. 입력한 값 대신 팀 시트의 구성을 적용합니다.');
    let password = raw['비밀번호'] == null ? '' : raw['비밀번호'];
    if (!['string', 'number'].includes(typeof password) || (typeof password === 'number' && !Number.isFinite(password))) {
      error('멤버', row, '비밀번호', '비밀번호는 문자 또는 숫자로 입력해 주세요.'); password = '';
    }
    password = String(password);
    if (!password.trim()) password = '';
    if (password && (password.length < 8 || password.length > 128)) error('멤버', row, '비밀번호', '비밀번호는 8자 이상 128자 이하로 입력해 주세요.');
    if (/[\u0000-\u001f\u007f]/u.test(password)) error('멤버', row, '비밀번호', '비밀번호에는 줄바꿈이나 제어 문자를 사용할 수 없습니다.');
    const passwordAction = password ? (existing ? '재설정' : '지정 비밀번호') : existing ? '유지' : '기본 비밀번호';
    members.push({ row, id, name, session: text(raw['세션'], '멤버', row, '세션'), generation: text(raw['기수'], '멤버', row, '기수', 50), phone, admin, teamNames, action: existing ? 'update' : 'create', passwordAction, password: password || (existing ? null : DEFAULT_PASSWORD) });
  });
  const futureMemberIds = new Set([...existingMembers.keys(), ...members.map(m => m.id)]);
  teamRows.forEach((raw, i) => {
    const row = validRow(raw, TEAM_HEADERS, '팀', i); if (!row) return;
    const name = text(raw['팀명'], '팀', row, '팀명');
    if (!name) error('팀', row, '팀명', '팀명을 입력해 주세요.');
    if (name.includes(',')) error('팀', row, '팀명', '팀명에는 쉼표를 사용할 수 없습니다.');
    if (seenTeams.has(name)) error('팀', row, '팀명', '파일 안에 같은 팀명이 있습니다.');
    seenTeams.add(name);
    const slots = {}, assigned = new Set(), existing = existingTeams.get(name);
    for (const [label, slot] of Object.entries(SLOTS)) {
      const memberId = text(raw[label], '팀', row, label);
      if (!memberId) continue;
      if (!futureMemberIds.has(memberId)) error('팀', row, label, '등록되지 않은 멤버 아이디입니다. 멤버 시트에 먼저 추가해 주세요.');
      if (assigned.has(memberId)) warn('팀', row, label, '같은 멤버가 이 팀의 여러 자리를 맡습니다.');
      assigned.add(memberId); slots[slot] = memberId;
    }
    for (const [slot, memberId] of Object.entries(existing?.slots || {})) {
      if (slots[slot] !== memberId) {
        const label = Object.entries(SLOTS).find(([, s]) => s === slot)?.[0] || slot;
        warn('팀', row, label, slots[slot] ? '기존 자리의 멤버를 변경합니다.' : '기존 자리의 멤버를 해제하고 공석으로 변경합니다.');
      }
    }
    teams.push({ row, name, id: existing?.id, slots, action: existing ? 'update' : 'create' });
  });
  const futureTeams = new Map([...existingTeams].map(([name, team]) => [name, team]));
  for (const team of teams) futureTeams.set(team.name, team);
  for (const member of members) {
    const actual = [...futureTeams.values()].filter(t => Object.values(t.slots).includes(member.id)).map(t => t.name);
    member.teams = actual;
  }
  const membershipChanges = [...futureMemberIds].map(id => ({
    id, name: members.find(m => m.id === id)?.name || existingMembers.get(id)?.name || id,
    before: [...existingTeams.values()].filter(t => Object.values(t.slots).includes(id)).map(t => t.name).sort(),
    after: [...futureTeams.values()].filter(t => Object.values(t.slots).includes(id)).map(t => t.name).sort(),
  })).filter(m => JSON.stringify(m.before) !== JSON.stringify(m.after));
  const futureAdmins = new Map([...existingMembers.values()].map(m => [m.id, m.admin]));
  for (const m of members) futureAdmins.set(m.id, m.admin);
  if (![...futureAdmins.values()].some(Boolean)) error('파일', 0, '관리자여부', '관리자는 최소 한 명 이상이어야 합니다.');
  if (!members.length && !teams.length) error('파일', 0, '', '등록할 내용이 없습니다. 양식의 두 번째 행부터 입력해 주세요.');
  if (process.env.NETLIFY && members.filter(m=>m.password!==null).length>100) error('멤버',0,'비밀번호','한 번에 신규 등록하거나 비밀번호를 설정할 멤버는 최대 100명입니다. 파일을 나누어 올려 주세요. 기존 멤버의 비밀번호 칸을 비우면 1000명까지 정보를 수정할 수 있습니다.');
  const summary = {
    newMembers: members.filter(m => m.action === 'create').length,
    updatedMembers: members.filter(m => m.action === 'update').length,
    newTeams: teams.filter(t => t.action === 'create').length,
    updatedTeams: teams.filter(t => t.action === 'update').length,
    totalMembers: members.length, totalTeams: teams.length, errors: errors.length, warnings: warnings.length,
  };
  return { valid: errors.length === 0, summary, members, teams, membershipChanges, errors, warnings };
}

function publicPreview(plan) {
  return {
    valid: plan.valid, summary: plan.summary, errors: plan.errors, warnings: plan.warnings,
    members: plan.members.map(({ password, teamNames, ...safe }) => safe),
    teams: plan.teams,
    membershipChanges: plan.membershipChanges,
  };
}

export async function previewImport(db, workbook, actorId) {
  return publicPreview((await planImport(db, workbook, actorId)));
}

export async function applyImport(db, workbook, actorId) {
  return (await db.transaction(async () => {
    const plan = (await planImport(db, workbook, actorId));
    if (!plan.valid) {
      const err = new Error('등록 내용을 다시 확인해 주세요.');
      err.status = 400; err.preview = publicPreview(plan); throw err;
    }
    if (db.dialect === 'postgres') await applyPostgresPlan(db,plan);
    else {
    const insertMember = db.prepare('INSERT INTO members(id,name,password_hash,session,generation,phone,admin,must_change_password) VALUES(?,?,?,?,?,?,?,1)');
    const updateMember = db.prepare("UPDATE members SET name=?,session=?,generation=?,phone=?,admin=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?");
    const updatePassword = db.prepare('UPDATE members SET password_hash=?,must_change_password=1 WHERE id=?');
    for (const member of plan.members) {
      if (member.action === 'create') (await insertMember.run(member.id, member.name, hashPassword(member.password), member.session, member.generation, member.phone, member.admin));
      else {
        (await updateMember.run(member.name, member.session, member.generation, member.phone, member.admin, member.id));
        if (member.password !== null) {
          (await updatePassword.run(hashPassword(member.password), member.id));
          (await db.prepare('DELETE FROM sessions WHERE member_id=?').run(member.id));
        }
      }
    }
    for (const team of plan.teams) {
      let id = team.id;
      if (team.action === 'create') id = Number((await db.prepare('INSERT INTO teams(name) VALUES(?)').run(team.name)).lastInsertRowid);
      else (await db.prepare("UPDATE teams SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(id));
      (await db.prepare('DELETE FROM team_members WHERE team_id=?').run(id));
      for (const [slot, memberId] of Object.entries(team.slots)) (await db.prepare('INSERT INTO team_members(team_id,slot,member_id) VALUES(?,?,?)').run(id, slot, memberId));
    }
    }
    (await db.prepare('INSERT INTO audit_log(actor_id,action,details) VALUES(?,?,?)').run(actorId, 'import', JSON.stringify(plan.summary)));
    return { ...publicPreview(plan), applied: true, reauthenticate: plan.members.some(m => m.id === actorId && m.password !== null) };
  }));
}

async function applyPostgresPlan(db,plan) {
  // Batch writes avoid one cross-region database round trip for every member/slot.
  const members=plan.members.map(m=>({...m,password_hash:m.password===null?null:hashPassword(m.password)}));
  const types='id text,name text,password_hash text,session text,generation text,phone text,admin integer';
  const created=members.filter(m=>m.action==='create'),updated=members.filter(m=>m.action==='update');
  if(created.length)await db.prepare(`INSERT INTO members(id,name,password_hash,session,generation,phone,admin,must_change_password)
    SELECT id,name,password_hash,session,generation,phone,admin,1 FROM jsonb_to_recordset(CAST(? AS jsonb)) AS changes(${types})`).run(JSON.stringify(created));
  if(updated.length)await db.prepare(`UPDATE members SET name=changes.name,session=changes.session,generation=changes.generation,phone=changes.phone,admin=changes.admin,
    password_hash=COALESCE(changes.password_hash,members.password_hash),
    must_change_password=CASE WHEN changes.password_hash IS NULL THEN members.must_change_password ELSE 1 END,
    updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM jsonb_to_recordset(CAST(? AS jsonb)) AS changes(${types}) WHERE members.id=changes.id`).run(JSON.stringify(updated));
  const reset=updated.filter(m=>m.password!==null).map(m=>m.id);
  if(reset.length)await db.prepare('DELETE FROM sessions WHERE member_id IN (SELECT jsonb_array_elements_text(CAST(? AS jsonb)))').run(JSON.stringify(reset));
  if(plan.teams.length){
    const teams=await db.prepare(`INSERT INTO teams(name) SELECT name FROM jsonb_to_recordset(CAST(? AS jsonb)) AS changes(name text)
      ON CONFLICT(name) DO UPDATE SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') RETURNING id,name`).all(JSON.stringify(plan.teams.map(t=>({name:t.name}))));
    const byName=new Map(teams.map(t=>[t.name,t.id]));
    await db.prepare('DELETE FROM team_members WHERE team_id IN (SELECT value::integer FROM jsonb_array_elements_text(CAST(? AS jsonb)) AS value)').run(JSON.stringify(teams.map(t=>t.id)));
    const links=plan.teams.flatMap(t=>Object.entries(t.slots).map(([slot,member_id])=>({team_id:byName.get(t.name),slot,member_id})));
    if(links.length)await db.prepare(`INSERT INTO team_members(team_id,slot,member_id) SELECT team_id,slot,member_id
      FROM jsonb_to_recordset(CAST(? AS jsonb)) AS changes(team_id integer,slot text,member_id text)`).run(JSON.stringify(links));
  }
}

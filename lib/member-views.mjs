const slots = ['vocal', 'guitar1', 'guitar2', 'bass', 'drums', 'keyboard'];
const byName = (a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true });

export function memberView(member, memberships) {
  if (!member) return null;
  return {
    id: member.id, name: member.name, session: member.session, generation: member.generation,
    phone: member.phone, admin: Boolean(member.admin), mustChangePassword: Boolean(member.must_change_password),
    teams: memberships.filter((team, i, all) => all.findIndex(other => other.id === team.id) === i).sort(byName),
  };
}

export async function listMembers(db) {
  const [members, memberships] = await Promise.all([
    db.prepare('SELECT id,name,session,generation,phone,admin,must_change_password FROM members ORDER BY name,id').all(),
    db.prepare(`SELECT tm.member_id,t.id,t.name,tm.slot FROM team_members tm
      JOIN teams t ON t.id=tm.team_id ORDER BY t.name,tm.slot`).all(),
  ]);
  const teamsByMember = new Map();
  for (const { member_id, ...team } of memberships) {
    if (!teamsByMember.has(member_id)) teamsByMember.set(member_id, []);
    teamsByMember.get(member_id).push(team);
  }
  return members.map(member => memberView(member, teamsByMember.get(member.id) || []));
}

export async function listTeams(db) {
  const [teams, memberships] = await Promise.all([
    db.prepare('SELECT id,name FROM teams ORDER BY name').all(),
    db.prepare(`SELECT tm.team_id,m.id,m.name,tm.slot FROM team_members tm
      JOIN members m ON m.id=tm.member_id ORDER BY tm.slot`).all(),
  ]);
  const membersByTeam = new Map();
  for (const { team_id, ...member } of memberships) {
    if (!membersByTeam.has(team_id)) membersByTeam.set(team_id, []);
    membersByTeam.get(team_id).push(member);
  }
  return teams.map(team => {
    const members = membersByTeam.get(team.id) || [];
    return { ...team, slots: Object.fromEntries(slots.map(slot => [slot, members.filter(member=>member.slot===slot||member.slot.startsWith(slot+':')).sort((a,b)=>a.slot.localeCompare(b.slot,'en',{numeric:true})).map(m=>m.id).join('\n')])), members };
  }).sort(byName);
}

// A single cross-region round trip for both management tabs.
export async function readDirectory(db) {
  let members, teams, memberships;
  if (db.dialect === 'postgres') {
    const r = await db.prepare(`SELECT
      (SELECT COALESCE(json_agg(m),'[]'::json) FROM
        (SELECT id,name,session,generation,phone,admin,must_change_password FROM members ORDER BY name,id) m) AS members,
      (SELECT COALESCE(json_agg(t),'[]'::json) FROM (SELECT id,name FROM teams) t) AS teams,
      (SELECT COALESCE(json_agg(tm),'[]'::json) FROM (SELECT team_id,member_id,slot FROM team_members ORDER BY slot) tm) AS memberships`).get();
    ({members,teams,memberships}=r);
  } else {
    [members,teams,memberships]=await Promise.all([
      db.prepare('SELECT id,name,session,generation,phone,admin,must_change_password FROM members ORDER BY name,id').all(),
      db.prepare('SELECT id,name FROM teams').all(),
      db.prepare('SELECT team_id,member_id,slot FROM team_members ORDER BY slot').all(),
    ]);
  }
  const names=new Map(members.map(m=>[m.id,m.name])), teamMap=new Map(teams.map(t=>[t.id,t]));
  const byMember=new Map(),byTeam=new Map();
  for(const m of memberships){
    if(!byMember.has(m.member_id))byMember.set(m.member_id,[]);
    if(!byTeam.has(m.team_id))byTeam.set(m.team_id,[]);
    byMember.get(m.member_id).push({...teamMap.get(m.team_id),slot:m.slot});
    byTeam.get(m.team_id).push({id:m.member_id,name:names.get(m.member_id),slot:m.slot});
  }
  return {members:members.map(m=>memberView(m,byMember.get(m.id)||[])),teams:teams.map(t=>{
    const members=byTeam.get(t.id)||[];
    return {...t,members,slots:Object.fromEntries(slots.map(slot=>[slot,members.filter(m=>m.slot===slot||m.slot.startsWith(slot+':')).sort((a,b)=>a.slot.localeCompare(b.slot,'en',{numeric:true})).map(m=>m.id).join('\n')]))};
  }).sort(byName)};
}

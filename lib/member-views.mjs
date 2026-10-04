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

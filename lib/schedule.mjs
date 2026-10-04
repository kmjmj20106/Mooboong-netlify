import { defaultSettings, getSettings } from './db.mjs';
import { listTeams } from './member-views.mjs';

const bookingSql = `SELECT b.*,m.name AS member_name,t.name AS team_name,creator.name AS creator_name
  FROM bookings b JOIN members m ON m.id=b.member_id LEFT JOIN teams t ON t.id=b.team_id
  LEFT JOIN members creator ON creator.id=COALESCE(b.created_by,b.member_id)
  WHERE b.date>=? AND b.date<? ORDER BY b.date,b.start_min`;
const eventSql = `SELECT e.*,m.name AS creator_name FROM events e JOIN members m ON m.id=e.created_by
  WHERE e.date>=? AND e.date<? ORDER BY e.date,e.start_min`;

// One database round trip for the calendar instead of separate settings, usage,
// reservations, events, teams and reservation-target queries across regions.
export async function readSchedule(db, member, week, until, includeOptions = false) {
  let rows, events, settings, teams, bookingMembers;
  if (db.dialect === 'postgres') {
    const result = await db.prepare(`WITH requested AS (SELECT ?::text AS week, ?::text AS until),
      weekly_bookings AS (
        SELECT b.*,m.name AS member_name,t.name AS team_name,creator.name AS creator_name
        FROM bookings b JOIN members m ON m.id=b.member_id LEFT JOIN teams t ON t.id=b.team_id
        LEFT JOIN members creator ON creator.id=COALESCE(b.created_by,b.member_id)
        WHERE b.date>=(SELECT week FROM requested) AND b.date<(SELECT until FROM requested)
        ORDER BY b.date,b.start_min
      ), weekly_events AS (
        SELECT e.*,m.name AS creator_name FROM events e JOIN members m ON m.id=e.created_by
        WHERE e.date>=(SELECT week FROM requested) AND e.date<(SELECT until FROM requested)
        ORDER BY e.date,e.start_min
      ), calendar_teams AS (
        SELECT t.id,t.name,COALESCE(json_agg(json_build_object('id',m.id,'name',m.name,'slot',tm.slot))
          FILTER (WHERE m.id IS NOT NULL),'[]'::json) AS members
        FROM teams t LEFT JOIN team_members tm ON tm.team_id=t.id LEFT JOIN members m ON m.id=tm.member_id
        GROUP BY t.id,t.name
      ) SELECT
        (SELECT COALESCE(json_agg(w),'[]'::json) FROM weekly_bookings w) AS bookings,
        (SELECT COALESCE(json_agg(e),'[]'::json) FROM weekly_events e) AS events,
        (SELECT COALESCE(json_object_agg(key,value),'{}'::json) FROM settings) AS settings,
        (SELECT COALESCE(json_agg(t),'[]'::json) FROM calendar_teams t) AS teams,
        ${includeOptions && member.admin ? "(SELECT COALESCE(json_agg(m),'[]'::json) FROM (SELECT id,name,session FROM members ORDER BY name,id) m)" : "'[]'::json"} AS booking_members
    `).get(week, until);
    rows = result.bookings; events = result.events; teams = result.teams;
    settings = { ...defaultSettings };
    for (const [key, value] of Object.entries(result.settings)) {
      if (Object.hasOwn(defaultSettings, key)) settings[key] = JSON.parse(value);
    }
    bookingMembers = result.booking_members;
  } else {
    [rows, events, settings, teams, bookingMembers] = await Promise.all([
      db.prepare(bookingSql).all(week, until), db.prepare(eventSql).all(week, until),
      getSettings(db), listTeams(db),
      includeOptions && member.admin ? db.prepare('SELECT id,name,session FROM members ORDER BY name,id').all() : [],
    ]);
  }
  teams.sort((a,b) => a.name.localeCompare(b.name,'ko',{numeric:true}));
  let personalMinutes = 0;
  const teamMinutes = new Map();
  for (const row of rows) {
    const duration = row.end_min - row.start_min;
    if (row.type === 'personal' && row.member_id === member.id) personalMinutes += duration;
    if (row.type === 'team') teamMinutes.set(row.team_id, (teamMinutes.get(row.team_id) || 0) + duration);
  }
  const usage = {personalHours:personalMinutes / 60,teams:teams.filter(t=>t.members.some(m=>m.id===member.id))
    .map(t=>({teamId:t.id,teamName:t.name,hours:(teamMinutes.get(t.id)||0)/60}))};
  if(!member.admin){teams=teams.filter(t=>t.members.some(m=>m.id===member.id));settings={...settings,quotaOverrides:(settings.quotaOverrides||[]).filter(r=>r.type==='personal'?r.id===member.id:teams.some(t=>String(t.id)===r.id))};}
  return {rows,events,settings,usage,...(includeOptions ? {teams,bookingMembers} : {})};
}

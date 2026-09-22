import { buildWorkbook } from './workbook.mjs';
import { listMembers, listTeams } from './member-views.mjs';

export async function exportMembers(db, sort = 'name', order = 'asc') {
  const key = ['name', 'generation', 'session'].includes(sort) ? sort : 'name';
  const direction = order === 'desc' ? -1 : 1;
  // Read both sheets under the same mutation lock; never select password hashes.
  const data = await db.transaction(async () => ({ members: await listMembers(db), teams: await listTeams(db) }));
  data.members.sort((a, b) => direction * (String(a[key] || '').localeCompare(String(b[key] || ''), 'ko', { numeric: true }) || a.name.localeCompare(b.name, 'ko') || a.id.localeCompare(b.id, 'ko')));
  return buildWorkbook(data);
}

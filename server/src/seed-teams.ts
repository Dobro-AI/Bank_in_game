import { randomInt } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Db, openDb } from './db.js';
import * as games from './games.js';
import { hashSecret } from './security.js';

/**
 * Teams of game masters. Each team runs its own branch of every game: own players, role codes,
 * money and tacts. The first team is the admin's and keeps the branches that already exist.
 */
export const TEAMS: { label: string; staff: { login: string; name: string }[] }[] = [
  { label: 'Диана Добросельская', staff: [{ login: 'diana', name: 'Диана Добросельская' }] },
  { label: 'Павел Зайцев и Степан Лушпей', staff: [{ login: 'pavel_z', name: 'Павел Зайцев' }, { login: 'stepan', name: 'Степан Лушпей' }] },
  { label: 'Гульназ Шарифулина и Игорь Воробьев', staff: [{ login: 'gulnaz', name: 'Гульназ Шарифулина' }, { login: 'igor', name: 'Игорь Воробьев' }] },
  { label: 'Дарья Больбот', staff: [{ login: 'daria', name: 'Дарья Больбот' }] },
  { label: 'Павел Камынин', staff: [{ login: 'pavel_k', name: 'Павел Камынин' }] },
];

const WORDS = ['takt', 'schet', 'server', 'reys', 'gruzovik', 'kontent', 'bank', 'ploshchadka', 'dohod', 'moshchnost'];
const password = () => `${WORDS[randomInt(WORDS.length)]}-${WORDS[randomInt(WORDS.length)]}-${randomInt(10, 100)}`;

/** Creates missing accounts and team branches; safe to run again. Returns passwords of new accounts. */
export async function seedTeams(db: Db) {
  const created: { name: string; login: string; password: string }[] = [];
  const staffId = new Map<string, number>();
  for (const t of TEAMS) {
    for (const s of t.staff) {
      const [row] = await db.query('select id from staff where login = $1', [s.login]);
      if (row) { staffId.set(s.login, row.id); continue; }
      const pass = password();
      const [n] = await db.query("insert into staff (name, login, password_hash, kind) values ($1, $2, $3, 'host') returning id", [s.name, s.login, hashSecret(pass)]);
      staffId.set(s.login, n.id);
      created.push({ name: s.name, login: s.login, password: pass });
    }
  }

  const branches: { root: string; team: string; id: number; created: boolean }[] = [];
  for (const root of await db.query("select * from game where kind = 'root' order by id")) {
    const existing = await db.query("select * from game where parent_id = $1 and kind = 'branch' order by id", [root.id]);
    // The admin's team: the branch the admin already runs (the oldest one).
    const admin = TEAMS[0];
    const adminBranch = existing.find((b) => b.team === admin.label)
      ?? (await Promise.all(existing.map(async (b) => ({ b, mine: (await db.query('select 1 from game_staff where game_id = $1 and staff_id = $2', [b.id, staffId.get('diana')])).length > 0 }))))
        .find((x) => x.mine)?.b;
    if (!adminBranch) continue;
    await db.query('update game set team = $2 where id = $1', [adminBranch.id, admin.label]);
    branches.push({ root: root.title, team: admin.label, id: adminBranch.id, created: false });

    for (const t of TEAMS.slice(1)) {
      const ids = t.staff.map((s) => staffId.get(s.login)!);
      // Game masters of another team leave the admin's branch: they now have their own players.
      await db.query('delete from game_staff where game_id = $1 and staff_id = any($2::int[])', [adminBranch.id, ids]);
      let b = existing.find((x) => x.team === t.label);
      const fresh = !b;
      if (!b) {
        b = await games.createBranch(db, root.id, root.title, ids);
        if (adminBranch.status === 'active') await games.launchBranch(db, b!.id);
      }
      for (const id of ids) await db.query('insert into game_staff (game_id, staff_id) values ($1, $2) on conflict do nothing', [b!.id, id]);
      await db.query('update game set team = $2, visible = $3 where id = $1', [b!.id, t.label, adminBranch.visible]);
      branches.push({ root: root.title, team: t.label, id: b!.id, created: fresh });
    }
  }
  return { created, branches };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = await openDb({ url: process.env.DATABASE_URL, dataDir: process.env.PGLITE_DIR ?? './data' });
  const r = await seedTeams(db);
  for (const b of r.branches) console.log(`${b.created ? 'создано' : 'есть   '}  #${b.id}  ${b.root} — ${b.team}`);
  for (const c of r.created) console.log(`аккаунт: ${c.name} — логин ${c.login}, пароль ${c.password}`);
  process.exit(0);
}

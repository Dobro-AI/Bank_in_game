// Fills an empty local database with a demo game: npm run seed:demo
import { ensureSuper } from './bootstrap.js';
import { openDb } from './db.js';
import * as games from './games.js';
import { hashSecret } from './security.js';

const db = await openDb({ url: process.env.DATABASE_URL, dataDir: process.env.PGLITE_DIR ?? './data' });
await ensureSuper(db, process.env.SUPER_LOGIN ?? 'super', process.env.SUPER_PASSWORD ?? 'super123');
const [host] = await db.query(
  "insert into staff (name, login, password_hash, kind) values ('Анна Ведущая', 'host', $1, 'host') on conflict (login) do update set name = excluded.name returning id",
  [hashSecret('host123')],
);
const root = await games.createRootGame(db, 'Город N');
const roles: Record<string, any> = {};
for (const [title, balance] of [['Мэр', 1000], ['Банкир', 5000], ['Торговец', 800], ['Журналист', 300]] as const) {
  roles[title] = await games.createRow(db, 'role', root.id, { title, start_balance: balance });
}
await games.createRow(db, 'start_account', root.id, { title: 'Мэрия', owner_role_id: roles['Мэр'].id, start_balance: 10000, pin: '1111' });
await games.createRow(db, 'start_account', root.id, {
  title: 'Банк Севера', owner_role_id: roles['Банкир'].id, coowner_role_ids: [roles['Торговец'].id], start_balance: 20000, pin: '2222',
});
await games.createRow(db, 'price_item', root.id, { title: 'Лицензия на торговлю', price: 500 });
await games.createRow(db, 'price_item', root.id, { title: 'Штраф за нарушение', price: 200 });
const branch = await games.createBranch(db, root.id, 'Город N — смена 1', [host.id]);
await games.launchBranch(db, branch.id);
const codes = await db.query('select title, code from role where game_id = $1 order by title', [branch.id]);
console.log('Демо готово. Супер-ведущий: super / super123, ведущий: host / host123');
console.table(codes);
await db.close();

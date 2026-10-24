// Moves the bank's data between databases (e.g. the local PGlite folder → PostgreSQL on a server).
//   tsx src/copy-db.ts export ./data dump.json        — read a PGlite folder into JSON
//   DATABASE_URL=... node dist/copy-db.js import dump.json   — load JSON into an empty PostgreSQL
import { readFileSync, writeFileSync } from 'node:fs';
import { openDb } from './db.js';

// Parents before children. Login sessions and one-time link codes are not carried over.
const TABLES = [
  'staff', 'game', 'game_staff', 'role', 'asset_type', 'start_account', 'price_item', 'player',
  'account', 'account_member', 'tact', 'transfer', 'tact_snapshot', 'account_event',
  'assistant_thread', 'assistant_message', 'assistant_proposal', 'asset_ledger', 'tact_output',
  'tact_posting', 'app_setting', 'telegram_link', 'staff_telegram',
];
// Self-references must be inserted in id order so the parent row exists first.
const ORDER: Record<string, string> = { game: 'id', role: 'id', asset_type: 'id', start_account: 'id', price_item: 'id' };

const [mode, a, b] = process.argv.slice(2);

if (mode === 'export') {
  const db = await openDb({ dataDir: a });
  const dump: Record<string, unknown[]> = {};
  for (const t of TABLES) dump[t] = await db.query(`select * from ${t} ${ORDER[t] ? `order by ${ORDER[t]}` : ''}`);
  writeFileSync(b, JSON.stringify(dump));
  console.log(Object.entries(dump).map(([t, r]) => `${t}: ${r.length}`).join(', '));
  await db.close();
} else if (mode === 'import') {
  const dump = JSON.parse(readFileSync(a, 'utf8')) as Record<string, any[]>;
  const db = await openDb({ url: process.env.DATABASE_URL });
  const [{ n }] = await db.query('select count(*)::int as n from staff');
  if (n > 0 && !process.argv.includes('--force')) throw new Error('В базе уже есть данные; перенос делается в пустую базу');
  await db.transaction(async (tx) => {
    for (const t of TABLES) {
      for (const row of dump[t] ?? []) {
        const cols = Object.keys(row);
        // jsonb comes back as objects; int[] stays an array.
        const vals = cols.map((c) => (row[c] && typeof row[c] === 'object' && !Array.isArray(row[c]) ? JSON.stringify(row[c]) : row[c]));
        await tx.query(`insert into ${t} (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')})`, vals);
      }
      const [hasId] = await tx.query(
        "select 1 from information_schema.columns where table_name = $1 and column_name = 'id' and column_default like 'nextval%'", [t]);
      if (hasId) await tx.query(`select setval(pg_get_serial_sequence('${t}', 'id'), coalesce((select max(id) from ${t}), 0) + 1, false)`);
    }
  });
  console.log(TABLES.map((t) => `${t}: ${(dump[t] ?? []).length}`).join(', '));
  await db.close();
} else {
  console.log('Использование: copy-db export <pglite-dir> <file.json> | copy-db import <file.json>');
}

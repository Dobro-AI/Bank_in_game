// Creates the two ready games (root games with roles, start balances, assets, price lists, rules).
//   npm run seed:games                      — create the root games (skips ones that exist)
//   npm run seed:games -- --branch host     — also a launched branch per game for host login "host"
//   npm run seed:games -- --docs ../docs/games — write role lists and OPEX / CAPEX tables as Markdown
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from './db.js';
import * as games from './games.js';
import { GAMES, GameDef } from './seeds/games-data.js';

const args = process.argv.slice(2);
const arg = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

const fmt = (n: number) => new Intl.NumberFormat('ru-RU').format(n);

function opexOf(g: GameDef, assets: Record<string, number> = {}) {
  let opex = 0;
  let income = 0;
  for (const [key, qty] of Object.entries(assets)) {
    const a = g.assets.find((x) => x.key === key)!;
    opex += qty * (a.opex ?? 0);
    income += qty * (a.income ?? 0);
  }
  return { opex, income };
}

export function gameMarkdown(g: GameDef) {
  const assetTitle = (key: string) => g.assets.find((a) => a.key === key)?.title ?? key;
  const assetsText = (assets?: Record<string, number>) =>
    Object.entries(assets ?? {}).map(([k, q]) => `${assetTitle(k)}: ${fmt(q)}`).join(', ') || '—';
  const lines = [
    `# ${g.title}`,
    '',
    `Валюта — ${g.currency}\nДанные для банка: роли, стартовые счета, активы, OPEX и прайс Игротехника (CAPEX).`,
    '',
    '## Роли и стартовые счета',
    '',
    '| № | Компания (роль) | Должность | Стартовый счёт | Стартовые активы | OPEX за такт |',
    '|---|---|---|---:|---|---:|',
    ...g.roles.map((r, i) => {
      const { opex, income } = opexOf(g, r.assets);
      const net = opex ? `${fmt(opex)}${income ? ` (доход +${fmt(income)})` : ''}` : income ? `доход +${fmt(income)}` : '—';
      return `| ${i + 1} | ${r.company} | ${r.position} | ${fmt(r.balance)} ${g.currency} | ${assetsText(r.assets)} | ${net} |`;
    }),
    '',
    `Всего денег на старте: ${fmt(g.roles.reduce((s, r) => s + r.balance, 0))} ${g.currency}`,
    '',
    '## Активы и мощности',
    '',
    '| Актив | Мощность за ед. | Выручка за ед. мощности | Затраты за ед. мощности | OPEX за такт | Доход за такт | В новом такте |',
    '|---|---:|---:|---:|---:|---:|---|',
    ...g.assets.map((a) => `| ${a.title} | ${a.capacity ? `${a.capacity} ${a.capacityUnit}` : '—'} | ${a.revenue ?? '—'} | ${a.cost ?? '—'} | ${a.opex ?? '—'} | ${a.income ?? '—'} | ${a.agesTo === 'expire' ? 'исчезает' : a.agesTo ? assetTitle(a.agesTo) : 'остаётся'} |`),
    '',
    '## Прайс Игротехника (CAPEX)',
    '',
    'Заготовки, которые игрок выбирает при переводе Игротехнику. Количество задаётся при оплате, сумма = цена × количество.',
    '',
    '| Позиция | Цена | Что добавляется в мощности |',
    '|---|---:|---|',
    ...g.prices.map((p) => `| ${p.title} | ${fmt(p.price)} ${g.currency} | ${p.asset ? `${assetTitle(p.asset)} +${p.qty ?? 1} за шт.` : '—'} |`),
    '',
    '## Правила для банка и помощника',
    '',
    ...g.rules.split('\n').map((l) => `- ${l}`),
    '',
  ];
  return lines.join('\n');
}

export async function seedGame(db: Awaited<ReturnType<typeof openDb>>, g: GameDef) {
  const [exists] = await db.query("select id from game where kind = 'root' and title = $1", [g.title]);
  if (exists) return { id: exists.id as number, created: false };
  const root = await games.createRootGame(db, g.title);
  await games.updateRules(db, root.id, g.rules);
  const codes: Record<string, string> = {};
  for (const [i, a] of g.assets.entries()) {
    const row = await games.createRow(db, 'asset_type', root.id, {
      title: a.title, unit: a.unit ?? 'шт.', capacity_per_unit: a.capacity ?? 0, capacity_unit: a.capacityUnit ?? '',
      revenue_per_output: a.revenue ?? 0, cost_per_output: a.cost ?? 0, opex_per_unit: a.opex ?? 0, income_per_unit: a.income ?? 0, sort: i,
    });
    codes[a.key] = row.code;
  }
  for (const a of g.assets.filter((x) => x.agesTo)) {
    const [row] = await db.query('select id from asset_type where game_id = $1 and code = $2', [root.id, codes[a.key]]);
    await games.updateRow(db, 'asset_type', row.id, { ages_to: a.agesTo === 'expire' ? 'expire' : codes[a.agesTo!] });
  }
  for (const r of g.roles) {
    const role = await games.createRow(db, 'role', root.id, { title: r.company, description: r.position });
    const assets = Object.fromEntries(Object.entries(r.assets ?? {}).map(([k, q]) => [codes[k], q]));
    await games.createRow(db, 'start_account', root.id, { title: r.company, owner_role_id: role.id, start_balance: r.balance, assets });
  }
  for (const p of g.prices) {
    await games.createRow(db, 'price_item', root.id, { title: p.title, price: p.price, asset_code: p.asset ? codes[p.asset] : '', asset_qty: p.asset ? p.qty ?? 1 : 0 });
  }
  return { id: root.id as number, created: true };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('seed-games.ts')) {
  const docs = arg('--docs');
  if (docs) {
    mkdirSync(docs, { recursive: true });
    for (const [i, g] of GAMES.entries()) {
      writeFileSync(join(docs, ['razvlecheniya.md', 'evrologistika.md'][i]), gameMarkdown(g));
    }
    console.log(`Документы записаны в ${docs}`);
  } else {
    const db = await openDb({ url: process.env.DATABASE_URL, dataDir: process.env.PGLITE_DIR ?? './data' });
    const hostLogin = arg('--branch');
    const [host] = hostLogin ? await db.query('select id from staff where login = $1', [hostLogin]) : [];
    if (hostLogin && !host) throw new Error(`Нет ведущего с логином ${hostLogin}`);
    for (const g of GAMES) {
      const { id, created } = await seedGame(db, g);
      console.log(`${created ? 'Создана' : 'Уже есть'}: ${g.title}`);
      if (host) {
        const branch = await games.createBranch(db, id, g.title, [host.id]);
        await games.launchBranch(db, branch.id);
        console.table(await db.query('select title as "роль", code as "код" from role where game_id = $1 order by title', [branch.id]));
      }
    }
    await db.close();
  }
}

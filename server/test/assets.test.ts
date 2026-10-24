import { beforeEach, describe, expect, it } from 'vitest';
import * as assets from '../src/assets.js';
import { Db, openDb } from '../src/db.js';
import * as games from '../src/games.js';
import { closeTact } from '../src/reports.js';
import { buildSheets, parseSheetId } from '../src/sheets.js';
import { payFixedPrice } from '../src/transfers.js';

let db: Db;
let branchId: number;
let staffId: number;
const code: Record<string, string> = {};

async function company(title: string) {
  const [a] = await db.query('select * from account where game_id = $1 and title = $2', [branchId, title]);
  return a;
}
const row = async (title: string) => (await assets.capacityTable(db, branchId)).rows.find((r) => r.title === title)!;
const qty = (r: any, c: string) => r.assets.find((a: any) => a.code === c)?.end ?? 0;

beforeEach(async () => {
  db = await openDb();
  const root = await games.createRootGame(db, 'Развлечения');
  const role = await games.createRow(db, 'role', root.id, { title: 'Директор IVI' });
  for (const [key, data] of Object.entries({
    server: { title: 'Сервер', capacity_per_unit: 30, capacity_unit: 'ч', opex_per_unit: 10, revenue_per_output: 1 },
    truck1: { title: 'Грузовик 1 год', capacity_per_unit: 1, capacity_unit: 'рейс' },
    ai: { title: 'ИИ-генерация', capacity_per_unit: 15, capacity_unit: 'контент', ages_to: 'expire' },
  })) {
    code[key] = (await games.createRow(db, 'asset_type', root.id, data)).code;
  }
  code.truck2 = (await games.createRow(db, 'asset_type', root.id, { title: 'Грузовик 2 года', capacity_per_unit: 1, capacity_unit: 'рейс' })).code;
  await games.updateRow(db, 'asset_type', (await db.query('select id from asset_type where game_id = $1 and code = $2', [root.id, code.truck1]))[0].id, { ages_to: code.truck2 });
  await games.createRow(db, 'start_account', root.id, {
    title: 'IVI', owner_role_id: role.id, start_balance: 100, assets: { [code.server]: 2, [code.truck1]: 3, [code.ai]: 1 },
  });
  await games.createRow(db, 'price_item', root.id, { title: 'Сервер', price: 40, asset_code: code.server, asset_qty: 1 });
  [{ id: staffId }] = await db.query("insert into staff (name, login, password_hash, kind) values ('В', 'v', 'x', 'host') returning id");
  branchId = (await games.createBranch(db, root.id, 'Смена', [staffId])).id;
  await games.launchBranch(db, branchId);
});

describe('активы и мощности', () => {
  it('стартовые активы и покупка по прайсу попадают в учёт', async () => {
    expect(qty(await row('IVI'), code.server)).toBe(2);
    const [r] = await db.query('select * from role where game_id = $1', [branchId]);
    const p = await games.joinRole(db, { gameId: branchId, roleId: r.id, firstName: 'А', lastName: 'Б', code: r.code });
    const ivi = await company('IVI');
    const [item] = await db.query('select id from price_item where game_id = $1', [branchId]);
    await payFixedPrice(db, { playerId: p.id, roleId: r.id, gameId: branchId }, { fromAccountId: ivi.id, priceItemId: item.id, quantity: 2 });
    const after = await row('IVI');
    expect(qty(after, code.server)).toBe(4);
    expect(after.capacity['ч']).toBe(120);
  });

  it('выручка и OPEX считаются по мощностям и проводятся один раз', async () => {
    const ivi = await company('IVI');
    const { tact } = await assets.capacityTable(db, branchId);
    await assets.setOutput(db, branchId, { tactId: tact.id, accountId: ivi.id, code: code.server, amount: 50 });
    const r = await row('IVI');
    expect(r.revenue).toBe(50);
    expect(r.opex).toBe(20);

    await assets.postTact(db, branchId, staffId, 'revenue');
    await assets.postTact(db, branchId, staffId, 'opex');
    const again = await assets.postTact(db, branchId, staffId, 'opex');
    expect(again.count).toBe(0);
    expect((await company('IVI')).balance).toBe(100 + 50 - 20);
    expect(await row('IVI')).toMatchObject({ postedRevenue: 50, postedOpex: 20 });
  });

  it('при завершении такта грузовики стареют, а разовые технологии исчезают', async () => {
    await closeTact(db, branchId, (tx, closed, next) => assets.ageAssets(tx, branchId, closed, next));
    const r = await row('IVI');
    expect(qty(r, code.truck1)).toBe(0);
    expect(qty(r, code.truck2)).toBe(3);
    expect(qty(r, code.ai)).toBe(0);
    expect(qty(r, code.server)).toBe(2);
  });

  it('ведущий вписывает и исправляет приход и расход вручную', async () => {
    const ivi = await company('IVI');
    const added = await assets.addLedger(db, branchId, staffId, { accountId: ivi.id, code: code.server, delta: -1, comment: 'сломался' });
    expect(qty(await row('IVI'), code.server)).toBe(1);
    await assets.updateLedger(db, branchId, added.id, { delta: 3 });
    expect(qty(await row('IVI'), code.server)).toBe(5);
    await assets.deleteLedger(db, branchId, added.id);
    expect(qty(await row('IVI'), code.server)).toBe(2);
    await expect(assets.addLedger(db, branchId, staffId, { accountId: ivi.id, code: 'нет', delta: 1 })).rejects.toThrow('актива');
  });
});

describe('Google-таблица', () => {
  it('собирает листы переводов, сводки, мощностей, OPEX и журнала', async () => {
    const sheets = await buildSheets(db, branchId);
    expect(sheets.map((s) => s.title)).toEqual(['Деньги', 'Переводы', 'Сводка', 'Мощности', 'Выручка и OPEX', 'Журнал активов']);
    const capacity = sheets.find((s) => s.title === 'Мощности')!.rows;
    expect(capacity).toContainEqual(['IVI', 'Сервер', 0, 2, 2, 60, 'ч', 0]);
    expect(sheets[1].rows[1]).toContain('Стартовый баланс');
    // "Деньги": start capital in B, the balance in C sums every transfer written to the right.
    const money = sheets[0];
    const n = money.rows.findIndex((r) => r[0] === 'IVI') + 1;
    expect(money.rows[n - 1]).toEqual(['IVI', expect.any(Number), `=B${n}+SUM(D${n}:W${n})`]);
    expect(money.styles![1]).toBe('tact');
  });

  it('понимает ссылку на таблицу', () => {
    expect(parseSheetId('https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=0'))
      .toBe('1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789');
    expect(() => parseSheetId('просто текст')).toThrow();
  });
});

describe('готовые игры', () => {
  it('обе игры заводятся: роли, стартовые счета, активы, OPEX', async () => {
    const { GAMES } = await import('../src/seeds/games-data.js');
    const { seedGame } = await import('../src/seed-games.js');
    const fresh = await openDb();
    for (const g of GAMES) {
      const { id } = await seedGame(fresh, g);
      expect((await seedGame(fresh, g)).created).toBe(false);
      const branch = await games.createBranch(fresh, id, 'Смена', []);
      await games.launchBranch(fresh, branch.id);
      const total = await fresh.query("select sum(balance) as s from account where game_id = $1 and kind = 'legal'", [branch.id]);
      expect(Number(total[0].s)).toBe(g.roles.reduce((s, r) => s + r.balance, 0));
      const table = await assets.capacityTable(fresh, branch.id);
      const opex = table.rows.reduce((s, r) => s + r.opex, 0);
      expect(opex).toBeGreaterThan(0);
    }
    const [steam] = await fresh.query("select id from account where title = 'Steam' order by id desc limit 1");
    const branchOf = (await fresh.query('select game_id from account where id = $1', [steam.id]))[0].game_id;
    const steamRow = (await assets.capacityTable(fresh, branchOf)).rows.find((r) => r.accountId === steam.id)!;
    expect(steamRow).toMatchObject({ capacity: { 'ч': 90 }, opex: 30 });
  });
});

describe('расчётка такта', () => {
  it('вписанный заработок и расходы проводятся при завершении такта, правка — только разницей', async () => {
    const ivi = await company('IVI');
    const { tact } = await assets.capacityTable(db, branchId);
    await assets.setOutput(db, branchId, { tactId: tact.id, accountId: ivi.id, code: assets.EARNED, amount: 70 });
    expect(await row('IVI')).toMatchObject({ earned: 70, revenue: 70, opex: 20 });

    await assets.postTact(db, branchId, staffId, 'revenue');
    await assets.setOutput(db, branchId, { tactId: tact.id, accountId: ivi.id, code: assets.EARNED, amount: 50 });
    await assets.postTact(db, branchId, staffId, 'revenue');
    expect((await company('IVI')).balance).toBe(100 + 50);

    const r = await assets.finishTact(db, branchId, staffId);
    expect(r).toMatchObject({ opex: 20, revenue: 0 });
    expect((await company('IVI')).balance).toBe(100 + 50 - 20);
    expect(r.next.number).toBe(2);
  });
});

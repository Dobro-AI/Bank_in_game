import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import * as assets from '../src/assets.js';
import { ensureSuper } from '../src/bootstrap.js';
import { Db, openDb } from '../src/db.js';
import * as games from '../src/games.js';
import { summary } from '../src/reports.js';
import { TEAMS, seedTeams } from '../src/seed-teams.js';
import { applyEdit, buildSheets, stateOf } from '../src/sheets.js';
import { editTransfer, hostAdjust, payFixedPrice, playerTransfer, transfer } from '../src/transfers.js';

/**
 * Edge cases of a real game day: several teams play the same game at once, tacts end while players
 * keep transferring, game masters correct finished tacts, and edits come back from the Google sheet.
 */

let db: Db;
let rootId: number;
let adminBranch: number;
let serverCode: string;

const rows = (sql: string, p: unknown[] = []) => db.query(sql, p);
const balance = async (id: number) => Number((await rows('select balance from account where id = $1', [id]))[0].balance);
const legal = async (gameId: number, title: string) => (await rows("select * from account where game_id = $1 and title = $2", [gameId, title]))[0];
const roleOf = async (gameId: number, title: string) => (await rows('select * from role where game_id = $1 and title = $2', [gameId, title]))[0];
const join = async (gameId: number, title: string, name: string) => {
  const r = await roleOf(gameId, title);
  const p = await games.joinRole(db, { gameId, roleId: r.id, firstName: name, code: r.code });
  return { playerId: p.id, roleId: r.id, gameId };
};
const openTact = async (gameId: number) => (await rows('select * from tact where game_id = $1 and closed_at is null', [gameId]))[0];

beforeEach(async () => {
  db = await openDb();
  await ensureSuper(db, 'diana', 'secret123');
  const root = await games.createRootGame(db, 'Развлечения');
  rootId = root.id;
  serverCode = (await games.createRow(db, 'asset_type', root.id, { title: 'Сервер', capacity_per_unit: 30, capacity_unit: 'ч', opex_per_unit: 10 })).code;
  for (const [title, money] of [['Каро', 100], ['IVI', 50]] as const) {
    const role = await games.createRow(db, 'role', root.id, { title });
    await games.createRow(db, 'start_account', root.id, { title, owner_role_id: role.id, start_balance: money, assets: { [serverCode]: 2 } });
  }
  await games.createRow(db, 'price_item', root.id, { title: 'Сервер', price: 40, asset_code: serverCode, asset_qty: 1 });
  const [diana] = await rows("select id from staff where login = 'diana'");
  adminBranch = (await games.createBranch(db, root.id, 'Развлечения', [diana.id])).id;
  await games.launchBranch(db, adminBranch);
  await rows('update game set visible = true where id = $1', [adminBranch]);
});

describe('команды игротехников: параллельные игры', () => {
  it('у каждой команды своё ответвление, свои коды; повторный запуск ничего не дублирует', async () => {
    const first = await seedTeams(db);
    expect(first.created.map((c) => c.login).sort()).toEqual(['daria', 'gulnaz', 'igor', 'pavel_k', 'pavel_z', 'stepan']);
    expect(first.branches.map((b) => b.team)).toEqual(TEAMS.map((t) => t.label));
    const again = await seedTeams(db);
    expect(again.created).toEqual([]);
    expect(again.branches.every((b) => !b.created)).toBe(true);

    const branches = await rows("select id, team, visible, status from game where parent_id = $1 order by id", [rootId]);
    expect(branches).toHaveLength(TEAMS.length);
    expect(branches.every((b) => b.visible && b.status === 'active')).toBe(true);
    const codes = await rows("select r.game_id, r.code from role r join game g on g.id = r.game_id where g.parent_id = $1 and r.title = 'Каро'", [rootId]);
    expect(new Set(codes.map((c) => c.code)).size).toBeGreaterThan(1);

    // Players see one option per team, the admin's first.
    const app = buildApp(db);
    const open = (await app.inject({ method: 'GET', url: '/api/public/games' })).json();
    expect(open.map((g: any) => g.team)).toEqual(TEAMS.map((t) => t.label));
    await app.close();
  });

  it('игроки одной роли в разных командах: деньги и переводы не уходят в чужую игру', async () => {
    await seedTeams(db);
    const other = (await rows('select id from game where parent_id = $1 and team = $2', [rootId, TEAMS[3].label]))[0].id;
    // A code of one team never opens the same role of another.
    const otherRole = await roleOf(other, 'Каро');
    const mineRole = await roleOf(adminBranch, 'Каро');
    if (otherRole.code !== mineRole.code) {
      await expect(games.joinRole(db, { gameId: other, roleId: otherRole.id, firstName: 'Чужой', code: mineRole.code })).rejects.toThrow('Неверный код');
    }
    const a1 = await join(adminBranch, 'Каро', 'Анна');
    const a2 = await join(adminBranch, 'Каро', 'Борис');
    const b1 = await join(other, 'Каро', 'Вера');
    const karoA = await legal(adminBranch, 'Каро');
    const ivyA = await legal(adminBranch, 'IVI');
    const karoB = await legal(other, 'Каро');
    const ivyB = await legal(other, 'IVI');

    // To an account of another team's game: refused.
    await expect(playerTransfer(db, a1, { fromAccountId: karoA.id, toAccountId: ivyB.id, amount: 10 })).rejects.toThrow('не найден');
    await expect(playerTransfer(db, b1, { fromAccountId: karoA.id, toAccountId: ivyB.id, amount: 10 })).rejects.toThrow();

    // Both players of one role send at once, alongside the other team: nothing is lost or crosses over.
    await Promise.all([
      ...Array.from({ length: 5 }, () => playerTransfer(db, a1, { fromAccountId: karoA.id, toAccountId: ivyA.id, amount: 7 })),
      ...Array.from({ length: 5 }, () => playerTransfer(db, a2, { fromAccountId: karoA.id, toAccountId: ivyA.id, amount: 3 })),
      ...Array.from({ length: 5 }, () => playerTransfer(db, b1, { fromAccountId: karoB.id, toAccountId: ivyB.id, amount: 1 })),
    ]);
    expect(await balance(karoA.id)).toBe(100 - 50);
    expect(await balance(ivyA.id)).toBe(50 + 50);
    expect(await balance(karoB.id)).toBe(100 - 5);
    expect(await balance(ivyB.id)).toBe(50 + 5);
    const foreign = await rows(
      `select count(*)::int as n from transfer t join account a on a.id in (t.from_account_id, t.to_account_id)
       where t.game_id <> a.game_id`,
    );
    expect(foreign[0].n).toBe(0);
  });

  it('одновременные переводы больше остатка: в минус не уходит, лишнее отклоняется', async () => {
    const a1 = await join(adminBranch, 'Каро', 'Анна');
    const a2 = await join(adminBranch, 'Каро', 'Борис');
    const karo = await legal(adminBranch, 'Каро');
    const ivi = await legal(adminBranch, 'IVI');
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) =>
      playerTransfer(db, i % 2 ? a1 : a2, { fromAccountId: karo.id, toAccountId: ivi.id, amount: 30 })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect(await balance(karo.id)).toBe(10);
    const refused = await rows('select reason from transfer_attempt where game_id = $1', [adminBranch]);
    expect(refused).toHaveLength(3);
  });
});

describe('такты и правки игротехника', () => {
  it('перевод после окончания такта идёт в следующий такт, прошлый не меняется', async () => {
    const a = await join(adminBranch, 'Каро', 'Анна');
    const karo = await legal(adminBranch, 'Каро');
    const ivi = await legal(adminBranch, 'IVI');
    const t1 = await openTact(adminBranch);
    await assets.finishTact(db, adminBranch, null);
    const before = (await summary(db, adminBranch, t1.id)).rows.find((r) => r.accountId === karo.id);
    const { transfer: t } = await playerTransfer(db, a, { fromAccountId: karo.id, toAccountId: ivi.id, amount: 15 });
    const t2 = await openTact(adminBranch);
    expect(t.tact_id).toBe(t2.id);
    expect((await summary(db, adminBranch, t1.id)).rows.find((r) => r.accountId === karo.id)).toEqual(before);
  });

  it('игротехник правит закончившийся такт: доход, мощности, начисление — всё пересчитывается дальше', async () => {
    const karo = await legal(adminBranch, 'Каро');
    const [diana] = await rows("select id from staff where login = 'diana'");
    const t1 = await openTact(adminBranch);
    await assets.finishTact(db, adminBranch, null); // tact 1: expenses 2 × 10
    const t2 = await openTact(adminBranch);
    expect(await balance(karo.id)).toBe(80);

    // Income written into tact 1 afterwards: credited into tact 1, the snapshot and tact 2 follow.
    await assets.setOutput(db, adminBranch, { tactId: t1.id, accountId: karo.id, code: assets.EARNED, amount: 30 });
    expect(await balance(karo.id)).toBe(110);
    const end1 = (await summary(db, adminBranch, t1.id)).rows.find((r) => r.accountId === karo.id)!;
    expect(end1.balanceEnd).toBe(110);
    expect((await summary(db, adminBranch)).rows.find((r) => r.accountId === karo.id)!.balanceStart).toBe(110);

    // One more server in tact 1: its expense (10) is subtracted in tact 1 too.
    await assets.addLedger(db, adminBranch, diana.id, { accountId: karo.id, code: serverCode, delta: 1, tactId: t1.id });
    expect(await balance(karo.id)).toBe(100);
    expect((await summary(db, adminBranch, t1.id)).rows.find((r) => r.accountId === karo.id)!.balanceEnd).toBe(100);

    // A credit dated into tact 1.
    await hostAdjust(db, adminBranch, diana.id, { accountId: karo.id, direction: 'credit', amount: 5, tactId: t1.id });
    expect((await summary(db, adminBranch, t1.id)).rows.find((r) => r.accountId === karo.id)!.balanceEnd).toBe(105);
    const credit = await rows("select tact_id from transfer where game_id = $1 and kind = 'host_credit' and amount = 5", [adminBranch]);
    expect(credit[0].tact_id).toBe(t1.id);

    // The open tact is untouched by these corrections: nothing posted into it.
    const intoT2 = await rows('select count(*)::int as n from transfer where tact_id = $1', [t2.id]);
    expect(intoT2[0].n).toBe(0);
  });

  it('все виды операций проходят и балансы сходятся', async () => {
    const a = await join(adminBranch, 'Каро', 'Анна');
    const karo = await legal(adminBranch, 'Каро');
    const ivi = await legal(adminBranch, 'IVI');
    const [host] = await rows("select id from account where game_id = $1 and kind = 'host'", [adminBranch]);
    const [diana] = await rows("select id from staff where login = 'diana'");
    const [item] = await rows('select id from price_item where game_id = $1', [adminBranch]);
    await playerTransfer(db, a, { fromAccountId: karo.id, toAccountId: ivi.id, amount: 10 }); // player
    await playerTransfer(db, a, { fromAccountId: karo.id, toAccountId: host.id, amount: 5 }); // to_host
    await payFixedPrice(db, a, { fromAccountId: karo.id, priceItemId: item.id }); // fixed_price + server
    await hostAdjust(db, adminBranch, diana.id, { accountId: karo.id, direction: 'credit', amount: 20 });
    await hostAdjust(db, adminBranch, diana.id, { accountId: ivi.id, direction: 'debit', amount: 8 });
    await transfer(db, { gameId: adminBranch, kind: 'player', fromAccountId: ivi.id, toAccountId: karo.id, amount: 2, initiatorStaffId: diana.id });
    await assets.setOutput(db, adminBranch, { tactId: (await openTact(adminBranch)).id, accountId: ivi.id, code: assets.EARNED, amount: 12 });
    await assets.finishTact(db, adminBranch, diana.id); // income 12 to IVI, expenses: Каро 3 servers, IVI 2

    expect(await balance(karo.id)).toBe(100 - 10 - 5 - 40 + 20 + 2 - 30);
    expect(await balance(ivi.id)).toBe(50 + 10 - 8 - 2 + 12 - 20);
    const kinds = (await rows('select distinct kind from transfer where game_id = $1', [adminBranch])).map((k) => k.kind).sort();
    expect(kinds).toEqual(['fixed_price', 'host_credit', 'host_debit', 'initial', 'player', 'to_host']);
    // Money is never created or lost: players plus the game master always sum to zero.
    const [sum] = await rows('select sum(balance)::int as s from account where game_id = $1', [adminBranch]);
    expect(sum.s).toBe(0);
  });
});

describe('правки прямо в Google-таблице', () => {
  const cellOf = async (title: string, match: (key: string) => boolean) => {
    const grid = (await buildSheets(db, adminBranch)).find((g) => g.title === title)!;
    const found = Object.entries(stateOf(grid)).find(([, [key]]) => match(key));
    if (!found) throw new Error(`нет ячейки ${title}`);
    return { key: found[1][0], was: found[1][1] };
  };

  it('доход, сумма перевода, новое начисление, количество мощностей и комментарий доходят до банка', async () => {
    const a = await join(adminBranch, 'Каро', 'Анна');
    const karo = await legal(adminBranch, 'Каро');
    const ivi = await legal(adminBranch, 'IVI');
    const { transfer: t } = await playerTransfer(db, a, { fromAccountId: karo.id, toAccountId: ivi.id, amount: 10 });
    const tact = await openTact(adminBranch);

    // "Счета" C: income of the tact.
    const income = await cellOf('Счета', (k) => k.startsWith(`earned:${tact.id}:${karo.id}:`));
    await applyEdit(db, adminBranch, income.key, income.was, 70);
    expect((await assets.capacityTable(db, adminBranch)).rows.find((r) => r.accountId === karo.id)!.earned).toBe(70);

    // "Счета": the transfer's cell changed, then emptied.
    const moved = await cellOf('Счета', (k) => k === `move:${t.id}`);
    await applyEdit(db, adminBranch, moved.key, moved.was, -25);
    expect(await balance(karo.id)).toBe(75);
    await applyEdit(db, adminBranch, moved.key, -25, '');
    expect(await balance(karo.id)).toBe(100);
    expect(await rows('select 1 from transfer where id = $1', [t.id])).toHaveLength(0);

    // "Счета": a number typed into an empty cell = credit (+) / debit (−) by the game master.
    const empty = await cellOf('Счета', (k) => k === `new:${tact.id}:${ivi.id}`);
    await applyEdit(db, adminBranch, empty.key, '', 15);
    await applyEdit(db, adminBranch, empty.key, '', -4);
    expect(await balance(ivi.id)).toBe(50 + 15 - 4);

    // "Мощности": quantity.
    const qty = await cellOf('Мощности', (k) => k === `qty:${tact.id}:${ivi.id}:${serverCode}`);
    await applyEdit(db, adminBranch, qty.key, qty.was, 5);
    expect((await assets.capacityTable(db, adminBranch)).rows.find((r) => r.accountId === ivi.id)!.opex).toBe(50);

    // "Переводы": comment and amount of a transfer.
    const { transfer: t2 } = await playerTransfer(db, a, { fromAccountId: karo.id, toAccountId: ivi.id, amount: 3 });
    const note = await cellOf('Переводы', (k) => k === `comment:${t2.id}`);
    await applyEdit(db, adminBranch, note.key, note.was, 'аренда сервера');
    const sum = await cellOf('Переводы', (k) => k === `amount:${t2.id}`);
    await applyEdit(db, adminBranch, sum.key, sum.was, 6);
    expect((await rows('select amount, comment from transfer where id = $1', [t2.id]))[0]).toEqual({ amount: 6, comment: 'аренда сервера' });

    // Text where a number belongs is ignored (the next write restores the cell).
    await applyEdit(db, adminBranch, income.key, 70, 'много');
    expect((await assets.capacityTable(db, adminBranch)).rows.find((r) => r.accountId === karo.id)!.earned).toBe(70);
  });

  it('правка в закончившемся такте через таблицу пересчитывает остатки', async () => {
    const karo = await legal(adminBranch, 'Каро');
    const t1 = await openTact(adminBranch);
    await assets.finishTact(db, adminBranch, null);
    const income = await cellOf('Счета', (k) => k.startsWith(`earned:${t1.id}:${karo.id}:`));
    await applyEdit(db, adminBranch, income.key, income.was, 40);
    expect(await balance(karo.id)).toBe(100 - 20 + 40);
    expect((await summary(db, adminBranch, t1.id)).rows.find((r) => r.accountId === karo.id)!.balanceEnd).toBe(120);
    // Editing again posts only the difference.
    await applyEdit(db, adminBranch, income.key, 40, 25);
    expect(await balance(karo.id)).toBe(105);
  });

  it('перевод игрока правится в таблице и после окончания такта', async () => {
    const a = await join(adminBranch, 'Каро', 'Анна');
    const karo = await legal(adminBranch, 'Каро');
    const ivi = await legal(adminBranch, 'IVI');
    const { transfer: t } = await playerTransfer(db, a, { fromAccountId: karo.id, toAccountId: ivi.id, amount: 10 });
    const t1 = await openTact(adminBranch);
    await assets.finishTact(db, adminBranch, null);
    await editTransfer(db, adminBranch, t.id, { amount: 30 });
    expect((await summary(db, adminBranch, t1.id)).rows.find((r) => r.accountId === karo.id)!.balanceEnd).toBe(100 - 30 - 20);
    expect((await summary(db, adminBranch)).rows.find((r) => r.accountId === karo.id)!.balanceStart).toBe(50);
  });
});

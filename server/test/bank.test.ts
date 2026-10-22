import { beforeEach, describe, expect, it } from 'vitest';
import { Db, openDb } from '../src/db.js';
import * as games from '../src/games.js';
import { closeTact, summary } from '../src/reports.js';
import { hostAdjust, payFixedPrice, playerTransfer } from '../src/transfers.js';

let db: Db;
let rootId: number;
let branchId: number;

async function balanceOf(id: number) {
  const [a] = await db.query('select balance from account where id = $1', [id]);
  return a.balance as number;
}
async function roleIn(gameId: number, title: string) {
  const [r] = await db.query('select * from role where game_id = $1 and title = $2', [gameId, title]);
  return r;
}
async function join(title: string, first = 'Иван', last = title) {
  const r = await roleIn(branchId, title);
  const p = await games.joinRole(db, { gameId: branchId, roleId: r.id, firstName: first, lastName: last, code: r.code });
  return { playerId: p.id, roleId: r.id, gameId: branchId };
}
async function accountOf(roleId: number, kind: string) {
  const [a] = await db.query(
    'select a.* from account a join account_member m on m.account_id = a.id where m.role_id = $1 and a.kind = $2',
    [roleId, kind],
  );
  return a;
}

beforeEach(async () => {
  db = await openDb();
  rootId = (await games.createRootGame(db, 'Город')).id;
  const mayor = await games.createRow(db, 'role', rootId, { title: 'Мэр', start_balance: 100 });
  const banker = await games.createRow(db, 'role', rootId, { title: 'Банкир', start_balance: 50 });
  await games.createRow(db, 'role', rootId, { title: 'Журналист', start_balance: 0 });
  await games.createRow(db, 'start_account', rootId, {
    title: 'Мэрия', owner_role_id: mayor.id, coowner_role_ids: [banker.id], start_balance: 1000, pin: '1234',
  });
  await games.createRow(db, 'price_item', rootId, { title: 'Штраф', price: 300 });
  branchId = (await games.createBranch(db, rootId, 'Смена 1', [])).id;
  await games.launchBranch(db, branchId);
});

describe('ответвления и наследование', () => {
  it('копирует настройки и пересчитывает ссылки на роли', async () => {
    const [sa] = await db.query('select * from start_account where game_id = $1', [branchId]);
    const mayor = await roleIn(branchId, 'Мэр');
    expect(sa.owner_role_id).toBe(mayor.id);
    const [legal] = await db.query("select * from account where game_id = $1 and kind = 'legal'", [branchId]);
    expect(legal.balance).toBe(1000);
  });

  it('изменения корня доходят до ответвлений, но не перезаписывают локальные правки', async () => {
    const rootMayor = await roleIn(rootId, 'Мэр');
    const rootBanker = await roleIn(rootId, 'Банкир');
    const b2 = await games.createBranch(db, rootId, 'Смена 2', []);
    await games.updateRow(db, 'role', (await roleIn(b2.id, 'Банкир')).id, { start_balance: 999 });

    await games.updateRow(db, 'role', rootMayor.id, { start_balance: 200 });
    await games.updateRow(db, 'role', rootBanker.id, { start_balance: 70 });
    await games.createRow(db, 'role', rootId, { title: 'Шериф' });

    expect((await roleIn(branchId, 'Мэр')).start_balance).toBe(200);
    expect((await roleIn(b2.id, 'Мэр')).start_balance).toBe(200);
    expect((await roleIn(branchId, 'Банкир')).start_balance).toBe(70);
    expect((await roleIn(b2.id, 'Банкир')).start_balance).toBe(999);
    expect(await roleIn(b2.id, 'Шериф')).toBeTruthy();
  });

  it('новое стартовое юрлицо в идущей игре открывается сразу', async () => {
    await games.createRow(db, 'start_account', rootId, { title: 'Порт', start_balance: 40 });
    const [a] = await db.query("select * from account where game_id = $1 and title = 'Порт'", [branchId]);
    expect(a.balance).toBe(40);
  });
});

describe('вход игрока', () => {
  it('неверный код отклоняется, верный создаёт счёт физлица со стартовым балансом', async () => {
    const r = await roleIn(branchId, 'Мэр');
    await expect(games.joinRole(db, { gameId: branchId, roleId: r.id, firstName: 'А', lastName: 'Б', code: 'xxxx' }))
      .rejects.toThrow('Неверный код');
    const p = await join('Мэр');
    expect((await accountOf(p.roleId, 'individual')).balance).toBe(100);
    const again = await games.joinRole(db, { gameId: branchId, roleId: r.id, code: r.code });
    expect(again.id).toBe(p.playerId);
  });
});

describe('переводы', () => {
  it('запрещает перевод больше баланса, ноль и отрицательную сумму', async () => {
    const mayor = await join('Мэр');
    const banker = await join('Банкир');
    const from = (await accountOf(mayor.roleId, 'individual')).id;
    const to = (await accountOf(banker.roleId, 'individual')).id;
    for (const amount of [0, -5, 1.5, 101]) {
      await expect(playerTransfer(db, mayor, { fromAccountId: from, toAccountId: to, amount })).rejects.toThrow();
    }
    await playerTransfer(db, mayor, { fromAccountId: from, toAccountId: to, amount: 100 });
    expect(await balanceOf(from)).toBe(0);
    expect(await balanceOf(to)).toBe(150);
  });

  it('двойное нажатие с тем же ключом списывает один раз', async () => {
    const mayor = await join('Мэр');
    const banker = await join('Банкир');
    const from = (await accountOf(mayor.roleId, 'individual')).id;
    const to = (await accountOf(banker.roleId, 'individual')).id;
    const body = { fromAccountId: from, toAccountId: to, amount: 30, idempotencyKey: 'k1' };
    const results = await Promise.all([playerTransfer(db, mayor, body), playerTransfer(db, mayor, body)]);
    expect(results[0].transfer.id).toBe(results[1].transfer.id);
    expect(await balanceOf(from)).toBe(70);
  });

  it('параллельные переводы не уводят в минус', async () => {
    const mayor = await join('Мэр');
    const banker = await join('Банкир');
    const from = (await accountOf(mayor.roleId, 'individual')).id;
    const to = (await accountOf(banker.roleId, 'individual')).id;
    const res = await Promise.allSettled(
      Array.from({ length: 5 }, () => playerTransfer(db, mayor, { fromAccountId: from, toAccountId: to, amount: 40 })),
    );
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(await balanceOf(from)).toBe(20);
  });

  it('совладелец переводит только после ввода PIN; чужой счёт недоступен', async () => {
    const banker = await join('Банкир');
    const journalist = await join('Журналист');
    const city = await accountOf(banker.roleId, 'legal');
    const to = (await accountOf(journalist.roleId, 'individual')).id;
    const send = (p: any) => playerTransfer(db, p, { fromAccountId: city.id, toAccountId: to, amount: 10 });
    await expect(send(banker)).rejects.toThrow('PIN');
    await expect(send(journalist)).rejects.toThrow('Нет доступа');
    await expect(games.confirmPin(db, banker.roleId, branchId, city.id, '0000')).rejects.toThrow('Неверный PIN');
    await games.confirmPin(db, banker.roleId, branchId, city.id, '1234');
    await send(banker);
    expect(await balanceOf(to)).toBe(10);
  });

  it('прайс и списание ведущего могут увести в минус, обычный перевод — нет', async () => {
    const j = await join('Журналист');
    const acc = (await accountOf(j.roleId, 'individual')).id;
    const [price] = await db.query('select id from price_item where game_id = $1', [branchId]);
    await payFixedPrice(db, j, { fromAccountId: acc, priceItemId: price.id });
    expect(await balanceOf(acc)).toBe(-300);
    const [staff] = await db.query("insert into staff (name, login, password_hash, kind) values ('В', 'v', 'x', 'host') returning id");
    await hostAdjust(db, branchId, staff.id, { accountId: acc, direction: 'debit', amount: 50 });
    expect(await balanceOf(acc)).toBe(-350);
    await hostAdjust(db, branchId, staff.id, { accountId: acc, direction: 'credit', amount: 500 });
    expect(await balanceOf(acc)).toBe(150);
  });
});

describe('прайс', () => {
  it('оплата нескольких штук: сумма = цена × количество', async () => {
    const mayor = await join('Мэр');
    const acc = (await accountOf(mayor.roleId, 'individual')).id;
    const [price] = await db.query('select id from price_item where game_id = $1', [branchId]);
    const { transfer: t } = await payFixedPrice(db, mayor, { fromAccountId: acc, priceItemId: price.id, quantity: 3 });
    expect(t.amount).toBe(900);
    expect(t.comment).toBe('Штраф × 3');
    await expect(payFixedPrice(db, mayor, { fromAccountId: acc, priceItemId: price.id, quantity: 0 })).rejects.toThrow('Количество');
  });
});

describe('юрлица', () => {
  it('создание, передача владельцу и потеря доступа', async () => {
    const mayor = await join('Мэр');
    const banker = await join('Банкир');
    const acc = await games.createLegal(db, mayor.roleId, branchId, { title: 'ООО Ромашка', pin: '5555' });
    expect(acc.balance).toBe(0);
    await games.transferOwnership(db, mayor.roleId, branchId, acc.id, banker.roleId);
    const members = await db.query('select role_id, member from account_member where account_id = $1', [acc.id]);
    expect(members).toEqual([{ role_id: banker.roleId, member: 'owner' }]);
  });
});

describe('такты', () => {
  it('завершение такта фиксирует слепок и открывает следующий', async () => {
    const mayor = await join('Мэр');
    const banker = await join('Банкир');
    const from = (await accountOf(mayor.roleId, 'individual')).id;
    const to = (await accountOf(banker.roleId, 'individual')).id;
    await playerTransfer(db, mayor, { fromAccountId: from, toAccountId: to, amount: 25 });
    const { next } = await closeTact(db, branchId);
    expect(next.number).toBe(2);

    await playerTransfer(db, mayor, { fromAccountId: from, toAccountId: to, amount: 5 });
    const live = await summary(db, branchId);
    const row = live.rows.find((r: any) => r.accountId === from);
    expect(row).toMatchObject({ balanceStart: 75, received: 0, sent: 5, balanceEnd: 70 });
  });
});

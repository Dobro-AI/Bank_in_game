import { beforeEach, describe, expect, it } from 'vitest';
import { Db, openDb } from '../src/db.js';
import * as games from '../src/games.js';
import { closeTact, summary } from '../src/reports.js';
import { deleteTransfer, editTransfer, hostAdjust, payFixedPrice, playerTransfer } from '../src/transfers.js';

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
    // The same person again (new phone) gets their player back; the role is never blocked.
    const again = await games.joinRole(db, { gameId: branchId, roleId: r.id, firstName: 'иван', lastName: 'мэр', code: r.code });
    expect(again.id).toBe(p.playerId);
  });

  it('в одну роль входят несколько человек, счета роли у них общие', async () => {
    const a = await join('Мэр', 'Аня', 'Иванова');
    const r = await roleIn(branchId, 'Мэр');
    const b = await games.joinRole(db, { gameId: branchId, roleId: r.id, firstName: 'Борис', lastName: '', code: r.code });
    expect(b.id).not.toBe(a.playerId);
    const bCtx = { playerId: b.id, roleId: r.id, gameId: branchId };
    const acc = await accountOf(r.id, 'individual');
    expect(acc.balance).toBe(100);
    const [mayoralty] = await db.query("select id from account where game_id = $1 and title = 'Мэрия'", [branchId]);
    const { transfer: t } = await playerTransfer(db, bCtx, { fromAccountId: mayoralty.id, toAccountId: acc.id, amount: 10 });
    expect(t.initiator_player_id).toBe(b.id);
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

describe('коды ролей', () => {
  it('ведущий задаёт свой код или новый случайный; коды в игре не повторяются', async () => {
    const mayor = await roleIn(branchId, 'Мэр');
    const banker = await roleIn(branchId, 'Банкир');
    expect(await games.setRoleCode(db, mayor.id, '1234')).toBe('1234');
    await expect(games.setRoleCode(db, banker.id, '1234')).rejects.toThrow('уже у другой роли');
    await expect(games.setRoleCode(db, banker.id, '12a4')).rejects.toThrow('4 цифры');
    const fresh = await games.setRoleCode(db, banker.id);
    expect(fresh).toMatch(/^\d{4}$/);
    expect(fresh).not.toBe('1234');
  });
});

describe('правка переводов ведущим', () => {
  it('сумма, получатель и удаление двигают балансы и пересчитывают слепки закрытых тактов', async () => {
    const mayor = await join('Мэр');
    const banker = await join('Банкир');
    const journalist = await join('Журналист');
    const from = await accountOf(mayor.roleId, 'individual');
    const to = await accountOf(banker.roleId, 'individual');
    const other = await accountOf(journalist.roleId, 'individual');
    const { transfer: t } = await playerTransfer(db, mayor, { fromAccountId: from.id, toAccountId: to.id, amount: 30 });
    const { closed } = await closeTact(db, branchId);

    await editTransfer(db, branchId, t.id, { amount: 40, toAccountId: other.id, comment: 'исправлено' });
    expect(await balanceOf(from.id)).toBe(60);
    expect(await balanceOf(to.id)).toBe(50);
    expect(await balanceOf(other.id)).toBe(40);
    const snap = (await summary(db, branchId, closed.id)).rows;
    expect(snap.find((r) => r.accountId === other.id)).toMatchObject({ received: 40, balanceEnd: 40 });
    expect(snap.find((r) => r.accountId === to.id)).toMatchObject({ received: 0, balanceEnd: 50 });
    // The open tact starts where the corrected snapshot ends.
    expect((await summary(db, branchId)).rows.find((r) => r.accountId === other.id).balanceStart).toBe(40);

    await deleteTransfer(db, branchId, t.id);
    expect(await balanceOf(from.id)).toBe(100);
    expect(await balanceOf(other.id)).toBe(0);
    expect((await summary(db, branchId, closed.id)).rows.find((r) => r.accountId === from.id).balanceEnd).toBe(100);
  });
});

describe('Google-таблица: «Счета» и «Переводы»', () => {
  it('переводы пишутся вправо в строку компании, следующий такт начинается с остатка прошлого', async () => {
    const { buildSheets, values } = await import('../src/sheets.js');
    const mayor = await join('Мэр');
    const banker = await join('Банкир');
    const from = await accountOf(mayor.roleId, 'individual');
    const to = await accountOf(banker.roleId, 'individual');
    await playerTransfer(db, mayor, { fromAccountId: from.id, toAccountId: to.id, amount: 30, comment: 'аренда' });
    await closeTact(db, branchId);
    const sheet = (await buildSheets(db, branchId))[0];
    const rows = values(sheet);
    const rowOf = (title: string, k = 0) => rows.map((r, i) => [r, i + 1] as const).filter(([r]) => r[0] === title)[k];
    const [t1, n1] = rowOf(from.title);
    expect(t1[1]).toBe(100);
    expect(t1[4]).toMatch(new RegExp(`^=B${n1}\\+C${n1}-D${n1}\\+SUM\\(F${n1}:`));
    expect(t1[5]).toBe(-30);
    expect(sheet.cells[n1 - 1][5].note).toBe(`кому: ${to.title} — аренда`);
    const [t2, n2] = rowOf(from.title, 1);
    expect(t2[1]).toBe(`=E${n1}`);
    // All three tacts are on the sheet from the start; the third is still empty.
    expect(rows.filter((r) => /^\d такт/.test(String(r[0]))).map((r) => r[0])).toEqual(['1 такт', '2 такт — не начат', '3 такт']);
    expect(rowOf(from.title, 2)[0][1]).toBe(`=E${n2}`);
  });

  it('отказанные переводы попадают в «Переводы» со статусом и причиной', async () => {
    const { buildSheets, values } = await import('../src/sheets.js');
    const mayor = await join('Мэр');
    const banker = await join('Банкир');
    const from = await accountOf(mayor.roleId, 'individual');
    const to = await accountOf(banker.roleId, 'individual');
    await expect(playerTransfer(db, mayor, { fromAccountId: from.id, toAccountId: to.id, amount: 500, comment: 'много' }))
      .rejects.toThrow('Недостаточно средств');
    await new Promise((r) => setTimeout(r, 5)); // the log is ordered by time
    await playerTransfer(db, mayor, { fromAccountId: from.id, toAccountId: to.id, amount: 5 });
    const log = values((await buildSheets(db, branchId)).find((x) => x.title === 'Переводы')!);
    expect(log[0].slice(0, 2)).toEqual(['Статус', 'Причина']);
    const mine = log.filter((r) => r[5] === from.title);
    expect(mine.map((r) => [r[0], r[1], r[8]])).toEqual([['Отклонено', 'Недостаточно средств на счёте', 500], ['Принято', '', 5]]);
    expect(mine[0][4]).toContain('(Мэр)');
  });
});

describe('такты: начать, таймер, закончить', () => {
  it('следующий такт ждёт «Начать такт», таймер ставится в минутах, после третьего идёт дополнительный', async () => {
    const { buildApp } = await import('../src/app.js');
    const { ensureSuper } = await import('../src/bootstrap.js');
    const { buildSheets, values } = await import('../src/sheets.js');
    await ensureSuper(db, 'boss', 'secret123');
    await db.query("insert into game_staff (game_id, staff_id) select $1, id from staff where login = 'boss'", [branchId]);
    const app = buildApp(db);
    const login = await app.inject({ method: 'POST', url: '/api/staff/login', payload: { login: 'boss', password: 'secret123' } });
    const cookie = login.headers['set-cookie'] as string;
    const call = (method: 'POST' | 'PUT', url: string, payload: unknown = {}) =>
      app.inject({ method, url: `/api/admin/games/${branchId}${url}`, payload: payload as any, headers: { cookie } });
    const open = async () => (await db.query('select * from tact where game_id = $1 and closed_at is null', [branchId]))[0];

    const t = (await call('POST', '/tact/start', { minutes: 15 })).json();
    expect(new Date(t.ends_at).getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
    const plus = (await call('POST', '/tact/add-minute')).json();
    expect(new Date(plus.ends_at).getTime() - new Date(t.ends_at).getTime()).toBe(60_000);
    expect((await call('PUT', '/tact/timer', { minutes: 0 })).json().ends_at).toBeNull();
    expect((await call('PUT', '/tact/timer', { minutes: 500 })).statusCode).toBe(400);

    for (let i = 0; i < 3; i++) await call('POST', '/close-tact');
    const fourth = await open();
    expect(fourth).toMatchObject({ number: 4, begun_at: null });
    await call('POST', '/tact/start');
    expect((await open()).begun_at).not.toBeNull();
    const headers = values((await buildSheets(db, branchId))[0]).map((r) => String(r[0])).filter((x) => /^\d такт/.test(x));
    expect(headers).toEqual(['1 такт', '2 такт', '3 такт', '4 такт — дополнительный, идёт']);
    await app.close();
  });
});

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import * as games from '../src/games.js';
import { linkTelegram, playerOfTelegram, recipientsOf, validateInitData } from '../src/telegram.js';
import { playerTransfer } from '../src/transfers.js';

const TOKEN = '123:test-token';

function signed(fields: Record<string, string>, token = TOKEN) {
  const check = Object.entries(fields).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

describe('Telegram Mini App', () => {
  const user = JSON.stringify({ id: 42, first_name: 'Аня' });

  it('принимает подписанные данные и отклоняет подделку и старые', () => {
    const now = String(Math.floor(Date.now() / 1000));
    expect(validateInitData(signed({ auth_date: now, user }), TOKEN)?.id).toBe(42);
    expect(validateInitData(signed({ auth_date: now, user }, '999:other'), TOKEN)).toBeNull();
    expect(validateInitData(signed({ auth_date: now, user }).replace('42', '43'), TOKEN)).toBeNull();
    expect(validateInitData(signed({ auth_date: String(Number(now) - 3 * 86400), user }), TOKEN)).toBeNull();
  });
});

describe('Telegram-бот: привязка и уведомления', () => {
  it('привязанный игрок находится по Telegram, получатель перевода получает уведомление', async () => {
    const db = await openDb();
    const root = await games.createRootGame(db, 'Игра');
    for (const t of ['А', 'Б']) await games.createRow(db, 'role', root.id, { title: t, start_balance: 100 });
    const branch = await games.createBranch(db, root.id, 'Смена', []);
    await games.launchBranch(db, branch.id);
    const roles = await db.query('select * from role where game_id = $1 order by title', [branch.id]);
    const players = [];
    for (const r of roles) players.push(await games.joinRole(db, { gameId: branch.id, roleId: r.id, firstName: 'И', lastName: r.title, code: r.code }));
    await linkTelegram(db, 1001, players[0].id);
    await linkTelegram(db, 1002, players[1].id);

    const a = await playerOfTelegram(db, 1001);
    expect(a).toMatchObject({ playerId: players[0].id, gameTitle: 'Смена' });
    expect(await playerOfTelegram(db, 5555)).toBeNull();

    const acc = async (roleId: number) =>
      (await db.query("select a.id from account a join account_member m on m.account_id = a.id where m.role_id = $1 and a.kind = 'individual'", [roleId]))[0].id;
    const { transfer } = await playerTransfer(db, a, { fromAccountId: await acc(roles[0].id), toAccountId: await acc(roles[1].id), amount: 30 });
    const to = await recipientsOf(db, transfer);
    expect(to.map((r: any) => Number(r.telegram_id))).toEqual([1002]);
  });
});

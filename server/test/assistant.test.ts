import { beforeEach, describe, expect, it } from 'vitest';
import * as assistant from '../src/assistant.js';
import { Db, openDb } from '../src/db.js';
import * as games from '../src/games.js';

let db: Db;
let gameId: number;
let hostA: number;
let hostB: number;

/** Fake Claude: replays scripted responses and records each request's messages. */
function fakeClient(responses: any[]) {
  const calls: any[] = [];
  return {
    calls,
    beta: {
      messages: {
        create: async (params: any) => {
          calls.push(structuredClone(params.messages));
          return responses.shift();
        },
      },
    },
  };
}

const toolUse = (id: string, name: string, input: unknown) => ({
  stop_reason: 'tool_use',
  content: [{ type: 'text', text: 'Сейчас проверю.' }, { type: 'tool_use', id, name, input }],
});
const answer = (text: string) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });

async function account(title: string) {
  const [a] = await db.query('select * from account where game_id = $1 and title = $2', [gameId, title]);
  return a;
}

beforeEach(async () => {
  db = await openDb();
  const root = await games.createRootGame(db, 'Город');
  await games.createRow(db, 'start_account', root.id, { title: 'Мэрия', start_balance: 500 });
  await games.createRow(db, 'start_account', root.id, { title: 'Порт', start_balance: 100 });
  await games.createRow(db, 'price_item', root.id, { title: 'Лицензия', price: 300 });
  const staff = await db.query(
    "insert into staff (name, login, password_hash, kind) values ('А', 'a', 'x', 'host'), ('Б', 'b', 'x', 'host') returning id",
  );
  [hostA, hostB] = staff.map((s) => s.id);
  gameId = (await games.createBranch(db, root.id, 'Смена', [hostA, hostB])).id;
  await games.launchBranch(db, gameId);
});

describe('помощник ведущего', () => {
  it('по фото готовит операцию, деньги двигаются только после подтверждения и один раз', async () => {
    const city = await account('Мэрия');
    const port = await account('Порт');
    const client = fakeClient([
      toolUse('t1', 'propose_operation', {
        kind: 'transfer', from_account_id: city.id, to_account_id: port.id, account_id: null, price_item_id: null,
        amount: 120, comment: 'Аренда причала', source_note: 'Мэрия → Порт 120',
      }),
      answer('Подготовил перевод 120 из Мэрии в Порт, подтвердите.'),
    ]);

    const view = await assistant.chat(db, client, gameId, hostA, {
      text: 'что тут?', image: { mediaType: 'image/jpeg', data: 'AAAA' },
    });
    expect(view.messages.map((m: any) => m.role)).toEqual(['user', 'assistant']);
    expect(view.proposals).toMatchObject([{ kind: 'transfer', amount: 120, from: 'Мэрия', to: 'Порт', status: 'pending' }]);
    expect((await account('Мэрия')).balance).toBe(500);

    // The second request replays the tool call and its result unchanged.
    expect(client.calls[1].at(-1).content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't1' });

    await assistant.confirmProposal(db, view.proposals[0].id, hostA);
    await expect(assistant.confirmProposal(db, view.proposals[0].id, hostA)).rejects.toThrow('уже обработана');
    expect((await account('Мэрия')).balance).toBe(380);
    expect((await account('Порт')).balance).toBe(220);
  });

  it('у каждого ведущего свой чат', async () => {
    await assistant.chat(db, fakeClient([answer('Привет, А')]), gameId, hostA, { text: 'привет' });
    const a = await assistant.currentThread(db, gameId, hostA);
    const b = await assistant.currentThread(db, gameId, hostB);
    expect(a.id).not.toBe(b.id);
    expect((await assistant.threadView(db, b.id)).messages).toHaveLength(0);
  });

  it('инструменты отдают данные игры, ошибки валидации возвращаются модели', async () => {
    const client = fakeClient([
      {
        stop_reason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'a', name: 'game_stats', input: {} },
          { type: 'tool_use', id: 'b', name: 'propose_operation', input: {
            kind: 'transfer', from_account_id: 999999, to_account_id: null, account_id: null, price_item_id: null,
            amount: 1, comment: '', source_note: '' } },
        ],
      },
      answer('Готово'),
    ]);
    await assistant.chat(db, client, gameId, hostA, { text: 'статистика' });
    const results = client.calls[1].at(-1).content;
    expect(results).toHaveLength(2);
    expect(JSON.parse(results[0].content).money_supply_players).toBe(600);
    expect(JSON.parse(results[1].content).error).toMatch('Счёт не найден');
  });
});

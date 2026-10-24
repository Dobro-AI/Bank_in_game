import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import * as assistant from '../src/assistant.js';
import { CliRunner, pickBackend } from '../src/assistant-cli.js';
import { Db, openDb } from '../src/db.js';
import * as games from '../src/games.js';

let db: Db;
let gameId: number;
let hostA: number;
let hostB: number;
let truck: string;

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
  truck = (await games.createRow(db, 'asset_type', root.id, { title: 'Грузовик', opex_per_unit: 10, capacity_per_unit: 2, capacity_unit: 'рейс' })).code;
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
    expect(view.proposals).toMatchObject([{ kind: 'transfer', title: 'Перевод', status: 'pending', lines: [
      { label: 'Откуда', value: 'Мэрия' }, { label: 'Куда', value: 'Порт' }, { label: 'Сумма', value: 120, money: true }, { label: 'Назначение' },
    ] }]);
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

describe('помощник через Claude Code (подписка)', () => {
  it('CLI получает инструменты банка по MCP, продолжает ту же сессию, токен живёт только на время ответа', async () => {
    const app = buildApp(db);
    const city = await account('Мэрия');
    const port = await account('Порт');
    const mcp = (token: string, method: string, params: unknown) => app.inject({
      method: 'POST', url: '/api/mcp',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
      payload: { jsonrpc: '2.0', id: 1, method, params },
    });
    const turns: any[] = [];
    let lastToken = '';
    const run: CliRunner = async (turn) => {
      turns.push(turn);
      lastToken = turn.token;
      const tools = (await mcp(turn.token, 'tools/list', {})).json().result.tools;
      expect(tools.map((t: any) => t.name)).toContain('propose_operation');
      if (turns.length === 1) {
        const res = await mcp(turn.token, 'tools/call', { name: 'propose_operation', arguments: {
          kind: 'transfer', from_account_id: city.id, to_account_id: port.id, account_id: null, price_item_id: null,
          amount: 120, comment: 'Аренда', source_note: '' } });
        expect(JSON.parse(res.json().result.content[0].text).proposal_id).toBeGreaterThan(0);
      }
      return { sessionId: 'sess-1', text: 'Операция ждёт подтверждения', isError: false };
    };
    const ask = pickBackend(db, { cli: run })!;

    const view = await ask(gameId, hostA, { text: 'Мэрия → Порт 120' });
    expect(view.messages.map((m: any) => m.text)).toEqual(['Мэрия → Порт 120', 'Операция ждёт подтверждения']);
    expect(view.proposals).toMatchObject([{ status: 'pending', title: 'Перевод' }]);
    expect((await account('Мэрия')).balance).toBe(500);
    expect(turns[0].resume).toBeNull();

    await ask(gameId, hostA, { text: 'А сколько это было?' });
    expect(turns[1].resume).toBe('sess-1');
    expect((await mcp(lastToken, 'tools/list', {})).statusCode).toBe(401);
    await app.close();
  });

  it('если CLI потерял сессию, начинает новую с пересказом чата', async () => {
    const turns: any[] = [];
    const run: CliRunner = async (turn) => {
      turns.push(turn);
      if (turn.resume) return { sessionId: '', text: 'No conversation found', isError: true };
      return { sessionId: `s${turns.length}`, text: 'Ок', isError: false };
    };
    const ask = pickBackend(db, { cli: run })!;
    await ask(gameId, hostA, { text: 'первый' });
    await ask(gameId, hostA, { text: 'второй' });
    expect(turns.map((t) => t.resume)).toEqual([null, 's1', null]);
    expect(turns[2].content[0].text).toContain('Ведущий: первый');
    const [t] = await db.query('select cli_session from assistant_thread where staff_id = $1', [hostA]);
    expect(t.cli_session).toBe('s3');
  });
});

describe('помощник меняет «Счета», «Переводы» и «Мощности»', () => {
  const blank = { from_account_id: null, to_account_id: null, account_id: null, price_item_id: null, transfer_id: null, asset_code: null, amount: null, comment: '', source_note: '' };
  async function propose(input: object) {
    const [t] = await db.query('select id from assistant_thread where staff_id = $1', [hostA]);
    const thread = t ?? await assistant.currentThread(db, gameId, hostA);
    const out: any = await assistant.runTool(db, { gameId, threadId: thread.id }, 'propose_operation', { ...blank, ...input });
    if (out.error) throw new Error(out.error);
    return out.proposal_id as number;
  }
  const confirm = (id: number) => assistant.confirmProposal(db, id, hostA);
  const balance = async (title: string) => Number((await account(title)).balance);

  it('ничего не меняется до подтверждения; доход, остаток, активы и обслуженное — после', async () => {
    const city = await account('Мэрия');
    const income = await propose({ kind: 'set_income', account_id: city.id, amount: 70 });
    const fix = await propose({ kind: 'set_balance', account_id: city.id, amount: 1000 });
    const trucks = await propose({ kind: 'asset_change', account_id: city.id, asset_code: truck, amount: 3, comment: 'Купили' });
    const trips = await propose({ kind: 'set_output', account_id: city.id, asset_code: truck, amount: 5 });
    expect(await balance('Мэрия')).toBe(500);

    await confirm(income);
    expect(await balance('Мэрия')).toBe(570);
    await confirm(fix);
    expect(await balance('Мэрия')).toBe(1000);
    await confirm(trucks);
    await confirm(trips);
    const cap: any = await assistant.runTool(db, { gameId, threadId: 0 }, 'get_capacities', { tact_number: null });
    const row = cap.companies.find((c: any) => c.account_id === city.id);
    expect(row).toMatchObject({ earned: 70, opex: 30, assets: [{ code: truck, quantity: 3, capacity: 6, served: 5 }] });
    await expect(confirm(income)).rejects.toThrow('уже обработана');
  });

  it('исправляет и удаляет переводы; плохие предложения возвращают ошибку модели', async () => {
    const city = await account('Мэрия');
    const port = await account('Порт');
    await assistant.confirmProposal(db, await propose({ kind: 'transfer', from_account_id: city.id, to_account_id: port.id, amount: 100, comment: 'Аренда' }), hostA);
    const [t] = await db.query("select id from transfer where game_id = $1 and kind = 'player'", [gameId]);
    await confirm(await propose({ kind: 'edit_transfer', transfer_id: t.id, amount: 40 }));
    expect(await balance('Порт')).toBe(140);
    const del = await propose({ kind: 'delete_transfer', transfer_id: t.id, comment: 'Ошибка' });
    const view = await assistant.threadView(db, (await assistant.currentThread(db, gameId, hostA)).id);
    expect(view.proposals.find((p: any) => p.id === del)!.lines[0].value).toContain('Мэрия → Порт, 40 (Аренда)');
    await confirm(del);
    expect(await balance('Порт')).toBe(100);
    expect(await balance('Мэрия')).toBe(500);

    await expect(propose({ kind: 'delete_transfer', transfer_id: 999999 })).rejects.toThrow('Перевод не найден');
    await expect(propose({ kind: 'asset_change', account_id: city.id, asset_code: 'нет', amount: 1 })).rejects.toThrow('Такого актива нет');
    await expect(propose({ kind: 'set_income', account_id: city.id, amount: -5 })).rejects.toThrow('amount ≥ 0');
  });

  it('читает листы таблицы так, как их пишет банк', async () => {
    const out: any = await assistant.runTool(db, { gameId, threadId: 0 }, 'read_sheet', { sheet: 'Счета', from_row: null, to_row: null });
    const city = out.rows.find((r: any) => r.cells.A === 'Мэрия');
    expect(city.cells.B).toBe(500);
    expect(city.cells.E.formula).toMatch(/^=B\d+\+C\d+-D\d+\+SUM/);
    expect(out.google_values).toBe(false);
    const log: any = await assistant.runTool(db, { gameId, threadId: 0 }, 'read_sheet', { sheet: 'Переводы', from_row: 1, to_row: 1 });
    expect(log.rows[0].cells.A).toBe('Статус');
  });
});

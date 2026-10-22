import Anthropic from '@anthropic-ai/sdk';
import { AppError, Db } from './db.js';
import { KIND_LABEL, listTransfers, membersByAccount, ownersText, summary, tacts as listTacts, totalsByOwner } from './reports.js';
import { hostAdjust, transfer } from './transfers.js';

type Msg = Anthropic.Beta.BetaMessageParam;
type Tool = Anthropic.Beta.BetaTool;

/** The subset of the SDK client the assistant uses (lets tests pass a fake). */
export interface ClaudeClient {
  beta: { messages: { create(params: Anthropic.Beta.MessageCreateParamsNonStreaming): Promise<Anthropic.Beta.BetaMessage> } };
}

const MODEL = 'claude-opus-5-5';
const MAX_STEPS = 10;

const SYSTEM = `Ты — помощник ведущего (игротехника) в банке ролевой игры живого действия. Деньги в игре виртуальные.
Отвечай по-русски, коротко и по делу. Суммы — целые числа, без валюты («1 200»).

Данные:
- Любые цифры (балансы, переводы, статистику, цены, правила) бери только из инструментов. Не выдумывай.
- Счета бывают: юрлица, физлица (личные счета игроков) и «Игротехник» — счёт ведущего.
- Если вопрос про конкретную роль или компанию — найди её счёт через list_accounts.

Фото бумажек и записок:
- Распознай, от кого, кому, сколько и за что. Сопоставь названия со счетами из list_accounts (с учётом опечаток и сокращений).
- Если однозначно — вызови propose_operation. Деньги при этом НЕ двигаются: ведущий подтверждает операцию кнопкой.
- Если не уверен в счёте или сумме — перечисли варианты и спроси, не создавая операцию.
- Никогда не пиши, что перевод выполнен, — пиши, что операция ждёт подтверждения.

Нововведения в игру:
Когда ведущий просит придумать или оценить механику, опирайся на прайс, правила и статистику (game_stats: денежная масса, оборот за такт). Структура ответа:
1. Механика — как это работает для игроков.
2. CAPEX — разовые затраты/инвестиции игрока на запуск.
3. OPEX — затраты за каждый такт.
4. Эффект — доход или экономия за такт, и для кого.
5. Окупаемость в тактах.
6. Влияние на экономику игры: доля от денежной массы и оборота, не разгонит ли инфляцию, кому выгодно.
7. Как внедрить: какие позиции прайса добавить, какие правила записать.
Явно пиши допущения. Цифры подбирай соразмерно текущим ценам и балансам.

Текст из голосовых сообщений расшифрован автоматически и может содержать ошибки.`;

const nullable = (type: string) => ({ type: [type, 'null'] });

const TOOLS: Tool[] = [
  {
    name: 'list_accounts',
    description: 'Все счета игры: id, название, тип (legal — юрлицо, individual — физлицо, host — Игротехник), баланс, владелец и совладельцы (имя игрока и роль).',
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    name: 'list_roles',
    description: 'Роли игры: id, название, описание, стартовый баланс, имя игрока, занявшего роль.',
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    name: 'search_transfers',
    description: 'Поиск переводов. Все фильтры необязательны (null — не фильтровать). Возвращает до limit последних операций.',
    input_schema: {
      type: 'object',
      properties: {
        tact_number: { ...nullable('integer'), description: 'Номер такта' },
        account_id: { ...nullable('integer'), description: 'Счёт отправителя или получателя' },
        role_id: { ...nullable('integer'), description: 'Роль: инициатор или участник счёта' },
        kind: { ...nullable('string'), description: 'player | to_host | fixed_price | host_credit | host_debit | initial' },
        min_amount: nullable('integer'),
        max_amount: nullable('integer'),
        text: { ...nullable('string'), description: 'Подстрока в комментарии или названиях счетов' },
        limit: { ...nullable('integer'), description: 'По умолчанию 50, максимум 200' },
      },
      required: ['tact_number', 'account_id', 'role_id', 'kind', 'min_amount', 'max_amount', 'text', 'limit'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'get_tact_summary',
    description: 'Сводка по счетам за такт: на начало, получено, отправлено, на конец; плюс итог по каждому игроку. tact_number=null — текущий такт.',
    input_schema: {
      type: 'object',
      properties: { tact_number: nullable('integer') },
      required: ['tact_number'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'game_stats',
    description: 'Статистика экономики: денежная масса у игроков, по тактам — число операций, оборот, средний перевод, продажи по прайсу, начисления и списания ведущего.',
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    name: 'get_rules_and_prices',
    description: 'Правила игры (текст от организаторов) и прайс фиксированных платежей игротехнику.',
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    name: 'propose_operation',
    description:
      'Подготовить операцию для подтверждения ведущим (деньги сразу не двигаются). ' +
      'kind=transfer: перевод между счетами (from_account_id, to_account_id, amount). ' +
      'kind=host_credit: начисление от игротехника на account_id. kind=host_debit: списание с account_id игротехнику. ' +
      'kind=fixed_price: оплата позиции прайса price_item_id со счёта account_id. Ненужные поля — null.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['transfer', 'host_credit', 'host_debit', 'fixed_price'] },
        from_account_id: nullable('integer'),
        to_account_id: nullable('integer'),
        account_id: nullable('integer'),
        price_item_id: nullable('integer'),
        amount: nullable('integer'),
        comment: { type: 'string', description: 'Назначение платежа' },
        source_note: { type: 'string', description: 'Что именно было написано на бумажке / в сообщении' },
      },
      required: ['kind', 'from_account_id', 'to_account_id', 'account_id', 'price_item_id', 'amount', 'comment', 'source_note'],
      additionalProperties: false,
    },
    strict: true,
  },
];

// ---------- Tool implementations (read-only, except proposals) ----------

async function accountsWithOwners(db: Db, gameId: number) {
  const members = await membersByAccount(db, gameId);
  const rows = await db.query('select id, kind, title, balance from account where game_id = $1 order by kind, title', [gameId]);
  return rows.map((a) => ({ ...a, ...ownersText(members.get(a.id)) }));
}

async function gameStats(db: Db, gameId: number) {
  const [supply] = await db.query(
    "select coalesce(sum(balance), 0) as total, count(*) as accounts from account where game_id = $1 and kind <> 'host'",
    [gameId],
  );
  const byTact = await db.query(
    `select tc.number as tact, count(t.id) as operations,
       coalesce(sum(t.amount) filter (where t.kind in ('player', 'to_host', 'fixed_price')), 0) as player_turnover,
       coalesce(round(avg(t.amount) filter (where t.kind = 'player')), 0) as avg_player_transfer,
       coalesce(sum(t.amount) filter (where t.kind = 'fixed_price'), 0) as fixed_price_sales,
       coalesce(sum(t.amount) filter (where t.kind in ('host_credit', 'initial')), 0) as host_issued,
       coalesce(sum(t.amount) filter (where t.kind in ('host_debit', 'to_host', 'fixed_price')), 0) as host_collected
     from tact tc left join transfer t on t.tact_id = tc.id
     where tc.game_id = $1 group by tc.number order by tc.number`,
    [gameId],
  );
  const priceSales = await db.query(
    `select p.title, p.price, count(t.id) as times_paid from price_item p
     left join transfer t on t.price_item_id = p.id where p.game_id = $1 group by p.id order by p.title`,
    [gameId],
  );
  const num = (r: any) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v]));
  return {
    money_supply_players: Number(supply.total),
    player_accounts: Number(supply.accounts),
    by_tact: byTact.map(num),
    price_items_sales: priceSales.map(num),
  };
}

async function runTool(db: Db, ctx: { gameId: number; threadId: number }, name: string, input: any): Promise<unknown> {
  const { gameId } = ctx;
  switch (name) {
    case 'list_accounts':
      return accountsWithOwners(db, gameId);
    case 'list_roles':
      return db.query(
        `select r.id, r.title, r.description, r.start_balance, p.first_name || ' ' || p.last_name as player
         from role r left join player p on p.role_id = r.id where r.game_id = $1 order by r.title`,
        [gameId],
      );
    case 'search_transfers': {
      const all = await listTacts(db, gameId);
      const tact = input.tact_number ? all.find((t) => t.number === input.tact_number) : undefined;
      if (input.tact_number && !tact) return { error: `Такта ${input.tact_number} нет` };
      let rows = await listTransfers(db, gameId, { tactId: tact?.id, accountId: input.account_id ?? undefined, roleId: input.role_id ?? undefined });
      const text = (input.text ?? '').toLowerCase();
      rows = rows.filter((t) =>
        (!input.kind || t.kind === input.kind) &&
        (input.min_amount == null || t.amount >= input.min_amount) &&
        (input.max_amount == null || t.amount <= input.max_amount) &&
        (!text || `${t.comment} ${t.from_title} ${t.to_title}`.toLowerCase().includes(text)));
      const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
      return {
        total_found: rows.length,
        transfers: rows.slice(0, limit).map((t) => ({ ...t, kind_label: KIND_LABEL[t.kind] })),
      };
    }
    case 'get_tact_summary': {
      const all = await listTacts(db, gameId);
      const tact = input.tact_number ? all.find((t) => t.number === input.tact_number) : undefined;
      if (input.tact_number && !tact) return { error: `Такта ${input.tact_number} нет` };
      const s = await summary(db, gameId, tact?.id);
      return {
        tact: s.tact && { number: s.tact.number, closed: !!s.tact.closed_at },
        accounts: s.rows.map(({ roleIds, ...r }) => r),
        totals_by_player: totalsByOwner(s.rows, await membersByAccount(db, gameId)),
      };
    }
    case 'game_stats':
      return gameStats(db, gameId);
    case 'get_rules_and_prices': {
      const [g] = await db.query('select rules from game where id = $1', [gameId]);
      const prices = await db.query('select id, title, price, active from price_item where game_id = $1 order by title', [gameId]);
      return { rules: g?.rules || '(правила не заполнены)', prices };
    }
    case 'propose_operation':
      return createProposal(db, ctx, input);
    default:
      return { error: `Неизвестный инструмент ${name}` };
  }
}

async function createProposal(db: Db, ctx: { gameId: number; threadId: number }, input: any) {
  const accountIds = [input.from_account_id, input.to_account_id, input.account_id].filter((x) => x != null);
  const found = accountIds.length
    ? await db.query('select id, title, kind from account where game_id = $1 and id = any($2::int[])', [ctx.gameId, accountIds])
    : [];
  if (found.length !== new Set(accountIds).size) return { error: 'Счёт не найден в этой игре — уточни через list_accounts' };
  const need = (cond: boolean, msg: string) => { if (!cond) throw new AppError(msg); };
  try {
    if (input.kind === 'transfer') need(input.from_account_id && input.to_account_id && input.amount > 0, 'Для перевода нужны from_account_id, to_account_id и amount > 0');
    if (input.kind === 'host_credit' || input.kind === 'host_debit') need(input.account_id && input.amount > 0, 'Нужны account_id и amount > 0');
    if (input.kind === 'fixed_price') {
      need(input.account_id && input.price_item_id, 'Нужны account_id и price_item_id');
      const [item] = await db.query('select price from price_item where id = $1 and game_id = $2 and active', [input.price_item_id, ctx.gameId]);
      need(!!item, 'Позиция прайса не найдена');
      input.amount = item.price;
    }
  } catch (e: any) {
    return { error: e.message };
  }
  const [p] = await db.query(
    'insert into assistant_proposal (thread_id, game_id, kind, payload) values ($1, $2, $3, $4) returning id',
    [ctx.threadId, ctx.gameId, input.kind, JSON.stringify(input)],
  );
  return { proposal_id: p.id, status: 'Ожидает подтверждения ведущего в чате' };
}

// ---------- Chat ----------

export async function currentThread(db: Db, gameId: number, staffId: number) {
  const [t] = await db.query(
    'select * from assistant_thread where game_id = $1 and staff_id = $2 order by id desc limit 1',
    [gameId, staffId],
  );
  if (t) return t;
  const [created] = await db.query('insert into assistant_thread (game_id, staff_id) values ($1, $2) returning *', [gameId, staffId]);
  return created;
}

export async function newThread(db: Db, gameId: number, staffId: number) {
  const [t] = await db.query('insert into assistant_thread (game_id, staff_id) values ($1, $2) returning *', [gameId, staffId]);
  return t;
}

export async function threadView(db: Db, threadId: number) {
  const messages = await db.query(
    'select id, role, text, has_image as "hasImage", created_at from assistant_message where thread_id = $1 and visible order by id',
    [threadId],
  );
  const proposals = await db.query('select * from assistant_proposal where thread_id = $1 order by id', [threadId]);
  return { threadId, messages, proposals: await describeProposals(db, proposals) };
}

async function describeProposals(db: Db, proposals: any[]) {
  if (!proposals.length) return [];
  const accounts = new Map((await db.query('select id, title from account where game_id = $1', [proposals[0].game_id])).map((a) => [a.id, a.title]));
  const items = new Map((await db.query('select id, title from price_item where game_id = $1', [proposals[0].game_id])).map((p) => [p.id, p.title]));
  return proposals.map((p) => {
    const i = p.payload;
    const from = p.kind === 'transfer' ? i.from_account_id : p.kind === 'host_credit' ? null : i.account_id;
    const to = p.kind === 'transfer' ? i.to_account_id : p.kind === 'host_credit' ? i.account_id : null;
    return {
      id: p.id, kind: p.kind, status: p.status, created_at: p.created_at, amount: i.amount, comment: i.comment, sourceNote: i.source_note,
      from: from ? accounts.get(from) : 'Игротехник', to: to ? accounts.get(to) : 'Игротехник',
      priceItem: i.price_item_id ? items.get(i.price_item_id) : null,
    };
  });
}

async function saveMessage(db: Db, threadId: number, m: Msg, text: string, visible: boolean, hasImage = false) {
  await db.query(
    'insert into assistant_message (thread_id, role, api, text, visible, has_image) values ($1, $2, $3, $4, $5, $6)',
    [threadId, m.role, JSON.stringify(m), text, visible, hasImage],
  );
}

export interface ChatInput {
  text?: string;
  image?: { mediaType: string; data: string };
}

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/**
 * One user turn: append the message, run the tool loop to completion, persist every API message
 * unchanged (the transcript is append-only so thinking blocks stay valid on replay).
 */
export async function chat(db: Db, client: ClaudeClient, gameId: number, staffId: number, input: ChatInput) {
  const text = (input.text ?? '').trim().slice(0, 8000);
  if (!text && !input.image) throw new AppError('Пустое сообщение');
  if (input.image && !IMAGE_TYPES.includes(input.image.mediaType)) throw new AppError('Поддерживаются JPEG, PNG, WebP, GIF');
  const thread = await currentThread(db, gameId, staffId);
  const ctx = { gameId, threadId: thread.id };

  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (input.image) {
    content.push({ type: 'image', source: { type: 'base64', media_type: input.image.mediaType as any, data: input.image.data } });
  }
  content.push({ type: 'text', text: text || 'Разбери, что на фото, и подготовь операцию.' });
  const userMsg: Msg = { role: 'user', content };
  await saveMessage(db, thread.id, userMsg, text, true, !!input.image);

  const history: Msg[] = (await db.query('select api from assistant_message where thread_id = $1 order by id', [thread.id]))
    .map((r) => r.api);

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium' },
      cache_control: { type: 'ephemeral' },
      system: SYSTEM,
      tools: TOOLS,
      messages: history,
    } as Anthropic.Beta.MessageCreateParamsNonStreaming);

    const assistantMsg: Msg = { role: 'assistant', content: res.content as any };
    history.push(assistantMsg);
    const reply = res.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map((b) => b.text).join('\n').trim();

    if (res.stop_reason === 'refusal') {
      await saveMessage(db, thread.id, assistantMsg, reply || 'Помощник не смог ответить на этот запрос. Переформулируйте, пожалуйста.', true);
      break;
    }
    const toolUses = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
    await saveMessage(db, thread.id, assistantMsg, reply, !!reply && toolUses.length === 0);
    if (res.stop_reason === 'pause_turn') continue;
    if (res.stop_reason !== 'tool_use' || toolUses.length === 0) break;

    // Run all calls, then answer them in one user message (keeps parallel tool use working).
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const t of toolUses) {
      try {
        const out = await runTool(db, ctx, t.name, t.input);
        results.push({ type: 'tool_result', tool_use_id: t.id, content: JSON.stringify(out) });
      } catch (e: any) {
        results.push({ type: 'tool_result', tool_use_id: t.id, content: e.message ?? 'Ошибка', is_error: true });
      }
    }
    const resultsMsg: Msg = { role: 'user', content: results };
    history.push(resultsMsg);
    await saveMessage(db, thread.id, resultsMsg, '', false);
  }
  return threadView(db, thread.id);
}

/** Executes a proposal on the host's confirmation, using the same money rules as manual operations. */
export async function confirmProposal(db: Db, proposalId: number, staffId: number) {
  const [p] = await db.query('select * from assistant_proposal where id = $1', [proposalId]);
  if (!p) throw new AppError('Операция не найдена', 404);
  if (p.status !== 'pending') throw new AppError('Операция уже обработана');
  const i = p.payload;
  const key = `proposal:${p.id}`;
  let res;
  if (p.kind === 'transfer') {
    const [to] = await db.query('select kind from account where id = $1', [i.to_account_id]);
    res = await transfer(db, {
      gameId: p.game_id, kind: to?.kind === 'host' ? 'to_host' : 'player', fromAccountId: i.from_account_id,
      toAccountId: i.to_account_id, amount: i.amount, comment: i.comment, initiatorStaffId: staffId, idempotencyKey: key,
    });
  } else if (p.kind === 'fixed_price') {
    const [host] = await db.query("select id from account where game_id = $1 and kind = 'host'", [p.game_id]);
    res = await transfer(db, {
      gameId: p.game_id, kind: 'fixed_price', fromAccountId: i.account_id, toAccountId: host.id, amount: i.amount,
      priceItemId: i.price_item_id, comment: i.comment, initiatorStaffId: staffId, idempotencyKey: key, allowNegative: true,
    });
  } else {
    res = await hostAdjust(db, p.game_id, staffId, {
      accountId: i.account_id, direction: p.kind === 'host_credit' ? 'credit' : 'debit', amount: i.amount, comment: i.comment, idempotencyKey: key,
    });
  }
  await db.query("update assistant_proposal set status = 'done', transfer_id = $2 where id = $1", [p.id, res.transfer.id]);
  return p.game_id as number;
}

export async function rejectProposal(db: Db, proposalId: number) {
  await db.query("update assistant_proposal set status = 'rejected' where id = $1 and status = 'pending'", [proposalId]);
}

import Anthropic from '@anthropic-ai/sdk';
import { AppError, Db } from './db.js';
import { KIND_LABEL, listTransfers, membersByAccount, ownersText, summary, tacts as listTacts, totalsByOwner } from './reports.js';
import * as assets from './assets.js';
import * as sheets from './sheets.js';
import { deleteTransfer, editTransfer, hostAdjust, recordPurchase, transfer } from './transfers.js';

type Msg = Anthropic.Beta.BetaMessageParam;
type Tool = Anthropic.Beta.BetaTool;

/** The subset of the SDK client the assistant uses (lets tests pass a fake). */
export interface ClaudeClient {
  beta: { messages: { create(params: Anthropic.Beta.MessageCreateParamsNonStreaming): Promise<Anthropic.Beta.BetaMessage> } };
}

export const MODEL = 'claude-opus-5-5';
const MAX_STEPS = 10;

export const SYSTEM = `Ты — помощник ведущего (игротехника) в банке ролевой игры живого действия. Деньги в игре виртуальные.
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

Google-таблица (листы «Счета», «Переводы», «Мощности»):
- Таблицу собирает банк из своих данных и перезаписывает при каждом изменении. Читай её через read_sheet (строки и столбцы как в A1, формулы и примечания к ячейкам). Активы и коды для изменений — через get_capacities.
- Менять ячейки напрямую нельзя: банк их затрёт. Любое изменение — через propose_operation, после подтверждения ведущим таблица обновится сама примерно за секунду.
- «Счета»: B — на начало такта, C — доходы (set_income: доход за текущий такт, заменяет прежний и сразу идёт на счёт), D — расходы из «Мощностей», E — остаток (set_balance: исправить остаток до нужной суммы), правее — переводы.
- «Переводы»: новый перевод — transfer; исправить сумму, комментарий или счета — edit_transfer; убрать ошибочный — delete_transfer (transfer_id из search_transfers).
- «Мощности»: количество актива у компании меняет asset_change (amount = на сколько штук больше или меньше, со знаком), обслужено за такт (рейсы, часы) — set_output.
- Если просят что-то, чего нет среди операций (переименовать лист, покрасить ячейку), — объясни, что таблица ведётся банком, и предложи, как сделать через банк.

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

const KINDS = ['transfer', 'host_credit', 'host_debit', 'fixed_price', 'set_income', 'set_balance', 'edit_transfer', 'delete_transfer', 'asset_change', 'set_output'];

export const TOOLS: Tool[] = [
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
    name: 'read_sheet',
    description: 'Строки листа Google-таблицы игры («Счета», «Переводы» или «Мощности»): значения ячеек по столбцам A, B…, формулы с посчитанными значениями, примечания. from_row/to_row — номера строк (null — с 1-й, до 150 строк). Плюс ссылка на лист.',
    input_schema: {
      type: 'object',
      properties: {
        sheet: { type: 'string', enum: ['Счета', 'Переводы', 'Мощности'] },
        from_row: nullable('integer'),
        to_row: nullable('integer'),
      },
      required: ['sheet', 'from_row', 'to_row'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'get_capacities',
    description: 'Мощности за такт (null — текущий): типы активов (code, название, расход и мощность на 1 шт.) и по каждой компании — активы с количеством, мощностью и обслуженным, доход (earned), выручка, расходы.',
    input_schema: {
      type: 'object',
      properties: { tact_number: nullable('integer') },
      required: ['tact_number'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'propose_operation',
    description:
      'Подготовить изменение для подтверждения ведущим (сразу ничего не меняется). ' +
      'kind=transfer: перевод между счетами (from_account_id, to_account_id, amount). ' +
      'kind=host_credit: начисление от игротехника на account_id. kind=host_debit: списание с account_id игротехнику. ' +
      'kind=fixed_price: оплата позиции прайса price_item_id со счёта account_id. ' +
      'kind=set_income: доход account_id за текущий такт = amount (столбец «Доходы» в «Счетах»). ' +
      'kind=set_balance: остаток account_id станет amount (разница начисляется или списывается игротехником). ' +
      'kind=edit_transfer: исправить перевод transfer_id — новые amount, from_account_id, to_account_id (null — не менять), comment (пусто — не менять). ' +
      'kind=delete_transfer: удалить перевод transfer_id. ' +
      'kind=asset_change: у компании account_id актива asset_code станет больше на amount (меньше — отрицательное), comment — причина. ' +
      'kind=set_output: обслужено за текущий такт по активу asset_code компании account_id = amount. Ненужные поля — null.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: KINDS },
        from_account_id: nullable('integer'),
        to_account_id: nullable('integer'),
        account_id: nullable('integer'),
        price_item_id: nullable('integer'),
        transfer_id: nullable('integer'),
        asset_code: nullable('string'),
        amount: nullable('integer'),
        comment: { type: 'string', description: 'Назначение платежа' },
        source_note: { type: 'string', description: 'Что именно было написано на бумажке / в сообщении' },
      },
      required: ['kind', 'from_account_id', 'to_account_id', 'account_id', 'price_item_id', 'transfer_id', 'asset_code', 'amount', 'comment', 'source_note'],
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

export async function runTool(db: Db, ctx: { gameId: number; threadId: number }, name: string, input: any): Promise<unknown> {
  const { gameId } = ctx;
  switch (name) {
    case 'list_accounts':
      return accountsWithOwners(db, gameId);
    case 'list_roles':
      return db.query(
        `select r.id, r.title, r.description, r.start_balance, (select string_agg(trim(p.first_name || ' ' || p.last_name), ', ' order by p.id) from player p where p.role_id = r.id) as players
         from role r where r.game_id = $1 order by r.title`,
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
    case 'read_sheet':
      return sheets.readSheet(db, gameId, input.sheet, input.from_row ?? 1, Math.min(input.to_row ?? Infinity, (input.from_row ?? 1) + 149));
    case 'get_capacities': {
      const all = await listTacts(db, gameId);
      const tact = input.tact_number ? all.find((t) => t.number === input.tact_number) : undefined;
      if (input.tact_number && !tact) return { error: `Такта ${input.tact_number} нет` };
      const cap = await assets.capacityTable(db, gameId, tact?.id);
      return {
        tact: cap.tact && { number: cap.tact.number, closed: !!cap.tact.closed_at },
        asset_types: cap.types.map((t: any) => ({
          code: t.code, title: t.title, unit: t.unit, opex_per_unit: t.opex_per_unit, capacity_per_unit: t.capacity_per_unit, cost_per_output: t.cost_per_output,
        })),
        companies: cap.rows.map((r: any) => ({
          account_id: r.accountId, title: r.title, owner: r.owner, earned: r.earned, revenue: r.revenue, opex: r.opex,
          assets: r.assets.filter((x: any) => x.end || x.output).map((x: any) => ({ code: x.code, title: x.title, quantity: x.end, capacity: x.capacity, served: x.output })),
        })),
      };
    }
    case 'propose_operation':
      return createProposal(db, ctx, input);
    default:
      return { error: `Неизвестный инструмент ${name}` };
  }
}

async function createProposal(db: Db, ctx: { gameId: number; threadId: number }, input: any) {
  if (!KINDS.includes(input.kind)) return { error: `Неизвестный вид операции ${input.kind}` };
  const need = (cond: unknown, msg: string) => { if (!cond) throw new AppError(msg); };
  const int = (v: unknown) => Number.isSafeInteger(v);
  try {
    const accountIds = [input.from_account_id, input.to_account_id, input.account_id].filter((x) => x != null);
    const found = accountIds.length
      ? await db.query('select id from account where game_id = $1 and id = any($2::int[])', [ctx.gameId, accountIds])
      : [];
    need(found.length === new Set(accountIds).size, 'Счёт не найден в этой игре — уточни через list_accounts');
    switch (input.kind) {
      case 'transfer':
        need(input.from_account_id && input.to_account_id && input.amount > 0, 'Для перевода нужны from_account_id, to_account_id и amount > 0');
        break;
      case 'host_credit':
      case 'host_debit':
        need(input.account_id && input.amount > 0, 'Нужны account_id и amount > 0');
        break;
      case 'fixed_price': {
        need(input.account_id && input.price_item_id, 'Нужны account_id и price_item_id');
        const [item] = await db.query('select price from price_item where id = $1 and game_id = $2 and active', [input.price_item_id, ctx.gameId]);
        need(item, 'Позиция прайса не найдена');
        input.amount = item.price;
        break;
      }
      case 'set_income':
      case 'set_output':
        need(input.account_id && int(input.amount) && input.amount >= 0, 'Нужны account_id и amount ≥ 0');
        need((await db.query('select 1 from tact where game_id = $1 and closed_at is null', [ctx.gameId])).length, 'Нет идущего такта');
        if (input.kind === 'set_output') await needAsset(db, ctx.gameId, input.asset_code);
        break;
      case 'set_balance':
        need(input.account_id && int(input.amount), 'Нужны account_id и amount — каким должен стать остаток');
        break;
      case 'asset_change':
        need(input.account_id && int(input.amount) && input.amount !== 0, 'Нужны account_id и amount — изменение в штуках, не ноль');
        await needAsset(db, ctx.gameId, input.asset_code);
        break;
      case 'edit_transfer':
      case 'delete_transfer': {
        const [t] = await db.query(
          `select t.id, t.amount, t.comment, tc.number as tact, fa.title as from_title, ta.title as to_title
           from transfer t join tact tc on tc.id = t.tact_id join account fa on fa.id = t.from_account_id join account ta on ta.id = t.to_account_id
           where t.id = $1 and t.game_id = $2`,
          [input.transfer_id, ctx.gameId],
        );
        need(t, 'Перевод не найден — уточни transfer_id через search_transfers');
        if (input.kind === 'edit_transfer') {
          need(input.amount != null || input.from_account_id || input.to_account_id || input.comment, 'Укажи, что изменить: amount, from_account_id, to_account_id или comment');
          need(input.amount == null || input.amount > 0, 'Сумма должна быть больше нуля');
        }
        input.before = { ...t, amount: Number(t.amount) };
        break;
      }
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

async function needAsset(db: Db, gameId: number, code: unknown) {
  const [t] = await db.query('select 1 from asset_type where game_id = $1 and code = $2', [gameId, code]);
  if (!t) throw new AppError('Такого актива нет — коды в get_capacities');
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

export async function threadView(db: Db, threadId: number) {
  const messages = await db.query(
    'select id, role, text, has_image as "hasImage", created_at from assistant_message where thread_id = $1 and visible order by id',
    [threadId],
  );
  const proposals = await db.query('select * from assistant_proposal where thread_id = $1 order by id', [threadId]);
  return { threadId, messages, proposals: await describeProposals(db, proposals) };
}

const KIND_TITLE: Record<string, string> = {
  transfer: 'Перевод', host_credit: 'Начисление', host_debit: 'Списание', fixed_price: 'Оплата по прайсу',
  set_income: 'Доход за такт', set_balance: 'Исправить остаток', edit_transfer: 'Исправить перевод',
  delete_transfer: 'Удалить перевод', asset_change: 'Изменить активы', set_output: 'Обслужено за такт',
};

/** A proposal as the chat and the host bot show it: a title and label–value lines (`money` marks sums). */
export interface ProposalLine { label: string; value: string | number; money?: boolean }

async function describeProposals(db: Db, proposals: any[]) {
  if (!proposals.length) return [];
  const gameId = proposals[0].game_id;
  const accounts = new Map((await db.query('select id, title from account where game_id = $1', [gameId])).map((a) => [a.id, a.title]));
  const items = new Map((await db.query('select id, title from price_item where game_id = $1', [gameId])).map((p) => [p.id, p.title]));
  const types = new Map((await db.query('select code, title, unit from asset_type where game_id = $1', [gameId])).map((t) => [t.code, t]));
  const acc = (id: number | null) => (id ? accounts.get(id) ?? `счёт ${id}` : 'Игротехник');
  return proposals.map((p) => {
    const i = p.payload;
    const lines: ProposalLine[] = [];
    const add = (label: string, value: string | number | null | undefined, money = false) => {
      if (value !== null && value !== undefined && value !== '') lines.push({ label, value, ...(money ? { money } : {}) });
    };
    const before = i.before && `${i.before.from_title} → ${i.before.to_title}, ${i.before.amount}${i.before.comment ? ` (${i.before.comment})` : ''}, такт ${i.before.tact}`;
    switch (p.kind) {
      case 'transfer': case 'host_credit': case 'host_debit': case 'fixed_price':
        add('Откуда', acc(p.kind === 'transfer' ? i.from_account_id : p.kind === 'host_credit' ? null : i.account_id));
        add('Куда', acc(p.kind === 'transfer' ? i.to_account_id : p.kind === 'host_credit' ? i.account_id : null));
        add('Сумма', i.amount, true);
        add('Назначение', i.comment);
        break;
      case 'set_income':
        add('Счёт', acc(i.account_id));
        add('Доход за такт', i.amount, true);
        break;
      case 'set_balance':
        add('Счёт', acc(i.account_id));
        add('Остаток станет', i.amount, true);
        break;
      case 'edit_transfer':
        add('Перевод', before);
        if (i.from_account_id) add('Откуда станет', acc(i.from_account_id));
        if (i.to_account_id) add('Куда станет', acc(i.to_account_id));
        if (i.amount != null) add('Сумма станет', i.amount, true);
        add('Комментарий станет', i.comment);
        break;
      case 'delete_transfer':
        add('Перевод', before);
        add('Причина', i.comment);
        break;
      case 'asset_change': case 'set_output': {
        const t = types.get(i.asset_code);
        add('Компания', acc(i.account_id));
        add('Актив', t?.title ?? i.asset_code);
        if (p.kind === 'asset_change') add('Изменение', `${i.amount > 0 ? '+' : ''}${i.amount} ${t?.unit ?? 'шт.'}`);
        else add('Обслужено', i.amount);
        add('Комментарий', i.comment);
        break;
      }
    }
    return {
      id: p.id, kind: p.kind, status: p.status, created_at: p.created_at, sourceNote: i.source_note,
      title: `${KIND_TITLE[p.kind] ?? p.kind}${i.price_item_id ? `: ${items.get(i.price_item_id) ?? ''}` : ''}`, lines,
    };
  });
}

export async function saveMessage(db: Db, threadId: number, m: Msg, text: string, visible: boolean, hasImage = false) {
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
/** Validates a turn and stores it as the next user message of the staff member's current thread. */
export async function startTurn(db: Db, gameId: number, staffId: number, input: ChatInput) {
  const text = (input.text ?? '').trim().slice(0, 8000);
  if (!text && !input.image) throw new AppError('Пустое сообщение');
  if (input.image && !IMAGE_TYPES.includes(input.image.mediaType)) throw new AppError('Поддерживаются JPEG, PNG, WebP, GIF');
  const thread = await currentThread(db, gameId, staffId);

  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (input.image) {
    content.push({ type: 'image', source: { type: 'base64', media_type: input.image.mediaType as any, data: input.image.data } });
  }
  content.push({ type: 'text', text: text || 'Разбери, что на фото, и подготовь операцию.' });
  const userMsg: Msg = { role: 'user', content };
  await saveMessage(db, thread.id, userMsg, text, true, !!input.image);
  return { thread, userMsg };
}

export async function chat(db: Db, client: ClaudeClient, gameId: number, staffId: number, input: ChatInput) {
  const { thread } = await startTurn(db, gameId, staffId, input);
  const ctx = { gameId, threadId: thread.id };

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
/** Executes a proposal on the host's confirmation, using the same rules as the host's own edits. */
export async function confirmProposal(db: Db, proposalId: number, staffId: number) {
  const [p] = await db.query('select * from assistant_proposal where id = $1', [proposalId]);
  if (!p) throw new AppError('Операция не найдена', 404);
  if (p.status !== 'pending') throw new AppError('Операция уже обработана');
  const i = p.payload;
  const gameId: number = p.game_id;
  const key = `proposal:${p.id}`;
  const openTact = async () => {
    const [t] = await db.query('select id from tact where game_id = $1 and closed_at is null', [gameId]);
    if (!t) throw new AppError('Нет идущего такта');
    return t.id as number;
  };
  let res: { transfer?: { id: number } } | undefined;
  switch (p.kind) {
    case 'transfer': {
      const [to] = await db.query('select kind from account where id = $1', [i.to_account_id]);
      res = await transfer(db, {
        gameId, kind: to?.kind === 'host' ? 'to_host' : 'player', fromAccountId: i.from_account_id,
        toAccountId: i.to_account_id, amount: i.amount, comment: i.comment, initiatorStaffId: staffId, idempotencyKey: key,
      });
      break;
    }
    case 'fixed_price': {
      const [host] = await db.query("select id from account where game_id = $1 and kind = 'host'", [gameId]);
      res = await transfer(db, {
        gameId, kind: 'fixed_price', fromAccountId: i.account_id, toAccountId: host.id, amount: i.amount,
        priceItemId: i.price_item_id, comment: i.comment, initiatorStaffId: staffId, idempotencyKey: key, allowNegative: true,
      }, undefined, (tx, row) => recordPurchase(tx, row, i.price_item_id, 1));
      break;
    }
    case 'host_credit':
    case 'host_debit':
      res = await hostAdjust(db, gameId, staffId, {
        accountId: i.account_id, direction: p.kind === 'host_credit' ? 'credit' : 'debit', amount: i.amount, comment: i.comment, idempotencyKey: key,
      });
      break;
    case 'set_balance': {
      const [a] = await db.query('select balance from account where id = $1 and game_id = $2', [i.account_id, gameId]);
      const diff = i.amount - Number(a.balance);
      if (diff) {
        res = await hostAdjust(db, gameId, staffId, {
          accountId: i.account_id, direction: diff > 0 ? 'credit' : 'debit', amount: Math.abs(diff),
          comment: i.comment || 'Исправлен остаток', idempotencyKey: key,
        });
      }
      break;
    }
    case 'set_income':
      // Like typing into "Доходы": the income of the tact is replaced and reaches the balance at once.
      await assets.setOutput(db, gameId, { tactId: await openTact(), accountId: i.account_id, code: assets.EARNED, amount: i.amount });
      await assets.postTact(db, gameId, staffId, 'revenue');
      break;
    case 'set_output':
      await assets.setOutput(db, gameId, { tactId: await openTact(), accountId: i.account_id, code: i.asset_code, amount: i.amount });
      break;
    case 'asset_change':
      await assets.addLedger(db, gameId, staffId, { accountId: i.account_id, code: i.asset_code, delta: i.amount, comment: i.comment || 'Помощник' });
      break;
    case 'edit_transfer':
      await editTransfer(db, gameId, i.transfer_id, {
        amount: i.amount ?? undefined, comment: i.comment || undefined,
        fromAccountId: i.from_account_id ?? undefined, toAccountId: i.to_account_id ?? undefined,
      });
      break;
    case 'delete_transfer':
      await deleteTransfer(db, gameId, i.transfer_id);
      break;
    default:
      throw new AppError('Неизвестная операция');
  }
  await db.query("update assistant_proposal set status = 'done', transfer_id = $2 where id = $1", [p.id, res?.transfer?.id ?? null]);
  // The Google sheet follows the bank; the host bot has no other trigger for it.
  sheets.scheduleSync(db, gameId);
  return gameId;
}

export async function rejectProposal(db: Db, proposalId: number) {
  await db.query("update assistant_proposal set status = 'rejected' where id = $1 and status = 'pending'", [proposalId]);
}

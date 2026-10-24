import { randomUUID } from 'node:crypto';
import { AppError, Db, Tx } from './db.js';
import { PLANNED_TACTS, closeTact, membersByAccount, ownersText, rebuildSnapshots, tacts as listTacts } from './reports.js';
import { hostAccountId, transferEvents, transferTx } from './transfers.js';

/**
 * Assets and capacities: servers, venues, trucks, staff... Holdings are the sum of ledger rows.
 * Per tact the host enters served output (hours, trips); revenue and OPEX are computed from
 * holdings and output and posted to accounts with one button each.
 */

/** tact_output row holding money the host typed in as "earned this tact" (not tied to an asset). */
export const EARNED = '__earned';

export async function assetTypes(db: Tx, gameId: number) {
  return db.query('select * from asset_type where game_id = $1 order by sort, title', [gameId]);
}

async function tactOf(db: Tx, gameId: number, tactId?: number) {
  const all = await listTacts(db, gameId);
  const tact = tactId ? all.find((t) => t.id === tactId) : all.find((t) => !t.closed_at);
  if (!tact) throw new AppError('Игра ещё не запущена');
  return tact;
}

/** Holdings per account and asset code, counting ledger rows of tacts up to `maxTactNumber`. */
async function holdings(db: Tx, gameId: number, maxTactNumber: number) {
  const rows = await db.query(
    `select l.account_id, l.asset_code, sum(l.delta) as qty
     from asset_ledger l left join tact t on t.id = l.tact_id
     where l.game_id = $1 and (t.number is null or t.number <= $2)
     group by l.account_id, l.asset_code`,
    [gameId, maxTactNumber],
  );
  const map = new Map<number, Map<string, number>>();
  for (const r of rows) {
    if (!map.has(r.account_id)) map.set(r.account_id, new Map());
    map.get(r.account_id)!.set(r.asset_code, Number(r.qty));
  }
  return map;
}

/** The capacity / revenue / OPEX table for one tact (default: the open one). */
export async function capacityTable(db: Tx, gameId: number, tactId?: number) {
  const tact = await tactOf(db, gameId, tactId);
  const types = await assetTypes(db, gameId);
  const typeBy = new Map(types.map((t) => [t.code, t]));
  const before = await holdings(db, gameId, tact.number - 1);
  const after = await holdings(db, gameId, tact.number);
  const outputs = await db.query('select account_id, asset_code, amount from tact_output where tact_id = $1', [tact.id]);
  const posted = await db.query('select account_id, kind, amount from tact_posting where tact_id = $1', [tact.id]);
  const accounts = await db.query("select id, kind, title, balance from account where game_id = $1 and kind <> 'host' order by kind, title", [gameId]);
  const members = await membersByAccount(db, gameId);

  // Every company is listed: the host may type earnings even for one without assets.
  const rows = accounts
    .map((a) => {
      const start = before.get(a.id) ?? new Map<string, number>();
      const end = after.get(a.id) ?? new Map<string, number>();
      const out = new Map<string, number>(outputs.filter((o) => o.account_id === a.id).map((o) => [o.asset_code, o.amount]));
      const assets = types
        .filter((t) => start.has(t.code) || end.has(t.code) || out.has(t.code))
        .map((t) => ({
          code: t.code, title: t.title, unit: t.unit,
          start: start.get(t.code) ?? 0, end: end.get(t.code) ?? 0, change: (end.get(t.code) ?? 0) - (start.get(t.code) ?? 0),
          capacity: (end.get(t.code) ?? 0) * t.capacity_per_unit, capacityUnit: t.capacity_unit,
          output: out.get(t.code) ?? 0,
        }));
      const capacity: Record<string, number> = {};
      const served: Record<string, number> = {};
      const revenueParts: string[] = [];
      const opexParts: string[] = [];
      const earned = out.get(EARNED) ?? 0;
      let revenue = earned;
      let opex = 0;
      if (earned) revenueParts.push(`Заработано: ${earned}`);
      for (const x of assets) {
        const t = typeBy.get(x.code)!;
        if (x.capacityUnit) {
          capacity[x.capacityUnit] = (capacity[x.capacityUnit] ?? 0) + x.capacity;
          served[x.capacityUnit] = (served[x.capacityUnit] ?? 0) + x.output;
        }
        if (x.output && t.revenue_per_output) {
          revenue += x.output * t.revenue_per_output;
          revenueParts.push(`${t.title}: ${x.output} ${t.capacity_unit} × ${t.revenue_per_output}`);
        }
        if (x.end && t.income_per_unit) {
          revenue += x.end * t.income_per_unit;
          revenueParts.push(`${t.title}: ${x.end} × ${t.income_per_unit}`);
        }
        if (x.end && t.opex_per_unit) {
          opex += x.end * t.opex_per_unit;
          opexParts.push(`${t.title}: ${x.end} × ${t.opex_per_unit}`);
        }
        if (x.output && t.cost_per_output) {
          opex += x.output * t.cost_per_output;
          opexParts.push(`${t.title}: ${x.output} ${t.capacity_unit} × ${t.cost_per_output}`);
        }
      }
      const post = (kind: string) => posted.find((p) => p.account_id === a.id && p.kind === kind);
      return {
        accountId: a.id, title: a.title, kind: a.kind, balance: a.balance, owner: ownersText(members.get(a.id)).owner,
        assets, capacity, served, earned, revenue, opex, result: revenue - opex,
        revenueText: revenueParts.join('; '), opexText: opexParts.join('; '),
        postedRevenue: post('revenue')?.amount ?? null, postedOpex: post('opex')?.amount ?? null,
      };
    });

  const totals = { revenue: 0, opex: 0, capacity: {} as Record<string, number>, served: {} as Record<string, number> };
  for (const r of rows) {
    totals.revenue += r.revenue;
    totals.opex += r.opex;
    for (const [u, v] of Object.entries(r.capacity)) totals.capacity[u] = (totals.capacity[u] ?? 0) + v;
    for (const [u, v] of Object.entries(r.served)) totals.served[u] = (totals.served[u] ?? 0) + v;
  }
  return { tact, types, rows, totals };
}

export async function setOutput(db: Db, gameId: number, body: { tactId: number; accountId: number; code: string; amount: unknown }) {
  const amount = Number(body.amount ?? 0);
  if (!Number.isSafeInteger(amount) || amount < 0) throw new AppError('Нужно целое число ≥ 0');
  const [ok] = body.code === EARNED
    ? await db.query('select 1 from tact t, account a where t.id = $1 and t.game_id = $3 and a.id = $2 and a.game_id = $3', [body.tactId, body.accountId, gameId])
    : await db.query(
      `select 1 from tact t, account a, asset_type at
       where t.id = $1 and t.game_id = $4 and a.id = $2 and a.game_id = $4 and at.game_id = $4 and at.code = $3`,
      [body.tactId, body.accountId, body.code, gameId],
    );
  if (!ok) throw new AppError('Не найдено', 404);
  if (amount === 0) {
    await db.query('delete from tact_output where tact_id = $1 and account_id = $2 and asset_code = $3', [body.tactId, body.accountId, body.code]);
  } else {
    await db.query(
      `insert into tact_output (tact_id, account_id, asset_code, amount) values ($1, $2, $3, $4)
       on conflict (tact_id, account_id, asset_code) do update set amount = excluded.amount`,
      [body.tactId, body.accountId, body.code, amount],
    );
  }
  // A finished tact was corrected: its income and expenses are posted again by difference.
  const [t] = await db.query('select number, closed_at from tact where id = $1', [body.tactId]);
  if (t?.closed_at) await settleFinished(db, gameId, t.number, null);
}

/**
 * Posts revenue (credit) or OPEX (debit) of the open tact. Posting again after the host changed the
 * numbers moves only the difference, so a company is never charged twice. OPEX may push an account
 * below zero, as any host debit does.
 */
export async function postTact(db: Db, gameId: number, staffId: number | null, kind: 'revenue' | 'opex', tactId?: number) {
  if (kind !== 'revenue' && kind !== 'opex') throw new AppError('Неизвестная операция');
  const made: any[] = [];
  const res = await db.transaction(async (tx) => {
    // The open tact, or a finished one the game master corrected afterwards.
    const [open] = tactId
      ? await tx.query('select * from tact where id = $1 and game_id = $2 for update', [tactId, gameId])
      : await tx.query('select * from tact where game_id = $1 and closed_at is null for update', [gameId]);
    if (!open) throw new AppError('Нет открытого такта');
    const { rows } = await capacityTable(tx, gameId, open.id);
    const hostId = await hostAccountId(tx, gameId);
    let count = 0;
    let total = 0;
    for (const r of rows) {
      const amount = kind === 'revenue' ? r.revenue : r.opex;
      const done = (kind === 'revenue' ? r.postedRevenue : r.postedOpex) ?? 0;
      const diff = amount - done;
      if (diff === 0) continue;
      // Revenue goes host → company, OPEX company → host; a negative difference goes the other way.
      const toCompany = (kind === 'revenue') === diff > 0;
      const label = kind === 'revenue' ? `Доход за такт ${open.number}` : `Затраты за такт ${open.number}`;
      const details = kind === 'revenue' ? r.revenueText : r.opexText;
      const t = await transferTx(tx, {
        gameId, kind: toCompany ? 'host_credit' : 'host_debit',
        fromAccountId: toCompany ? hostId : r.accountId,
        toAccountId: toCompany ? r.accountId : hostId,
        amount: Math.abs(diff), comment: `${label}${done ? ' (исправление)' : ''}: ${details || 'нет'}`,
        initiatorStaffId: staffId, allowNegative: true, tactId: open.id,
        // The prefix tells corrections which posting this is; the tact row lock already rules out doubles.
        idempotencyKey: `post:${kind}:${open.id}:${r.accountId}:${amount}:${randomUUID()}`,
      });
      await tx.query(
        `insert into tact_posting (tact_id, account_id, kind, amount, transfer_id) values ($1, $2, $3, $4, $5)
         on conflict (tact_id, account_id, kind) do update set amount = excluded.amount, transfer_id = excluded.transfer_id`,
        [open.id, r.accountId, kind, amount, t.id],
      );
      made.push(t);
      count++;
      total += diff;
    }
    // A finished tact changed: its snapshot and every later one are recounted.
    if (open.closed_at && count) await rebuildSnapshots(tx, gameId, open.id);
    return { count, total, tact: open.number };
  });
  for (const t of made) transferEvents.emit('transfer', t);
  return res;
}

/**
 * After a game master changed a finished tact (income, assets, served hours), its income and expenses
 * are posted again by difference into that tact and every later finished one, and snapshots recounted.
 */
export async function settleFinished(db: Db, gameId: number, fromNumber: number, staffId: number | null) {
  const closed = (await listTacts(db, gameId)).filter((t) => t.closed_at && t.number >= fromNumber);
  for (const t of closed) {
    await postTact(db, gameId, staffId, 'revenue', t.id);
    await postTact(db, gameId, staffId, 'opex', t.id);
  }
}

/** Number of the tact a ledger row belongs to (rows without a tact count from the start). */
async function tactNumberOf(db: Db, tactId: number | null) {
  if (!tactId) return 1;
  const [t] = await db.query('select number from tact where id = $1', [tactId]);
  return t?.number ?? 1;
}

/**
 * Ends the tact the way the organisers' sheet does: earnings are credited and expenses are
 * subtracted from every company, then balances are frozen and the next tact starts (assets age).
 */
export async function finishTact(db: Db, gameId: number, staffId: number | null) {
  const revenue = await postTact(db, gameId, staffId, 'revenue');
  const opex = await postTact(db, gameId, staffId, 'opex');
  const r = await closeTact(db, gameId, (tx, closed, next) => ageAssets(tx, gameId, closed, next));
  return { ...r, revenue: revenue.total, opex: opex.total };
}

// ---------- Ledger: the host's manual edits ----------

export async function ledger(db: Db, gameId: number, accountId?: number) {
  return db.query(
    `select l.*, a.title as account_title, at.title as asset_title, at.unit, t.number as tact, s.name as staff_name
     from asset_ledger l
     join account a on a.id = l.account_id
     left join asset_type at on at.game_id = l.game_id and at.code = l.asset_code
     left join tact t on t.id = l.tact_id
     left join staff s on s.id = l.staff_id
     where l.game_id = $1 ${accountId ? 'and l.account_id = $2' : ''}
     order by l.id desc`,
    accountId ? [gameId, accountId] : [gameId],
  );
}

async function checkRefs(db: Tx, gameId: number, accountId: number, code: string) {
  const [a] = await db.query("select 1 from account where id = $1 and game_id = $2 and kind <> 'host'", [accountId, gameId]);
  if (!a) throw new AppError('Счёт не найден', 404);
  const [t] = await db.query('select 1 from asset_type where game_id = $1 and code = $2', [gameId, code]);
  if (!t) throw new AppError('Такого актива нет в игре');
}

const delta = (v: unknown) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n === 0) throw new AppError('Изменение — целое число, не ноль');
  return n;
};

/** Something came or went outside the bank (bought from a player, broke down...): host writes it in. */
/** Assets came or went; `tactId` puts the row into a finished tact (a game master's correction). */
export async function addLedger(db: Db, gameId: number, staffId: number | null, body: { accountId: number; code: string; delta: unknown; comment?: string; tactId?: number }) {
  await checkRefs(db, gameId, Number(body.accountId), String(body.code));
  const [tact] = body.tactId
    ? await db.query('select id, number from tact where id = $1 and game_id = $2', [Number(body.tactId), gameId])
    : await db.query('select id, number from tact where game_id = $1 and closed_at is null', [gameId]);
  if (body.tactId && !tact) throw new AppError('Такт не найден', 404);
  const [row] = await db.query(
    `insert into asset_ledger (game_id, account_id, asset_code, delta, tact_id, reason, comment, staff_id)
     values ($1, $2, $3, $4, $5, 'manual', $6, $7) returning *`,
    [gameId, Number(body.accountId), String(body.code), delta(body.delta), tact?.id ?? null, String(body.comment ?? '').slice(0, 300), staffId],
  );
  await settleFinished(db, gameId, tact?.number ?? 1, staffId);
  return row;
}

export async function updateLedger(db: Db, gameId: number, id: number, body: { delta?: unknown; comment?: string }) {
  const [row] = await db.query('select * from asset_ledger where id = $1 and game_id = $2', [id, gameId]);
  if (!row) throw new AppError('Запись не найдена', 404);
  await db.query('update asset_ledger set delta = $2, comment = $3 where id = $1', [
    id, body.delta === undefined ? row.delta : delta(body.delta), body.comment === undefined ? row.comment : String(body.comment).slice(0, 300),
  ]);
  await settleFinished(db, gameId, await tactNumberOf(db, row.tact_id), null);
}

export async function deleteLedger(db: Db, gameId: number, id: number) {
  const [row] = await db.query('delete from asset_ledger where id = $1 and game_id = $2 returning tact_id', [id, gameId]);
  if (row) await settleFinished(db, gameId, await tactNumberOf(db, row.tact_id), null);
}

/**
 * At the start of a new tact: assets that age move to the next type (truck 1 year → 2 years),
 * assets marked 'expire' (a one-tact technology) disappear.
 */
export async function ageAssets(tx: Tx, gameId: number, closed: { number: number }, next: { id: number }) {
  const types = (await assetTypes(tx, gameId)).filter((t) => t.ages_to);
  if (!types.length) return;
  const held = await holdings(tx, gameId, closed.number);
  for (const [accountId, byCode] of held) {
    for (const t of types) {
      const qty = byCode.get(t.code) ?? 0;
      if (qty <= 0) continue;
      const comment = t.ages_to === 'expire' ? `${t.title}: срок действия закончился` : `${t.title}: переход в следующий такт`;
      await tx.query(
        "insert into asset_ledger (game_id, account_id, asset_code, delta, tact_id, reason, comment) values ($1, $2, $3, $4, $5, 'aging', $6)",
        [gameId, accountId, t.code, -qty, next.id, comment],
      );
      if (t.ages_to !== 'expire') {
        await tx.query(
          "insert into asset_ledger (game_id, account_id, asset_code, delta, tact_id, reason, comment) values ($1, $2, $3, $4, $5, 'aging', $6)",
          [gameId, accountId, t.ages_to, qty, next.id, comment],
        );
      }
    }
  }
}

/**
 * "Итоги тактов": per company and tact — income, expenses and the balance after the tact (column E of
 * "Счета"). A finished tact is its snapshot; the current one is live, as it will be when the tact ends.
 */
export async function tactResults(db: Db, gameId: number) {
  const all = await listTacts(db, gameId);
  const accounts = await db.query("select id, kind, title from account where game_id = $1 and kind <> 'host'", [gameId]);
  const legal = accounts.filter((a) => a.kind === 'legal');
  const companies = legal.length ? legal : accounts;
  const members = await membersByAccount(db, gameId);
  type Cell = { income: number; expenses: number; total: number } | null;
  const values = new Map<number, Cell[]>(companies.map((a) => [a.id, []]));
  for (const t of all) {
    const cap = new Map((await capacityTable(db, gameId, t.id)).rows.map((r) => [r.accountId, r]));
    const ends = new Map<number, number>();
    if (t.closed_at) {
      for (const s of await db.query('select account_id, balance_end from tact_snapshot where tact_id = $1', [t.id])) ends.set(s.account_id, Number(s.balance_end));
    } else {
      for (const r of cap.values()) ends.set(r.accountId, r.balance + (r.revenue - (r.postedRevenue ?? 0)) - (r.opex - (r.postedOpex ?? 0)));
    }
    for (const a of companies) {
      const r = cap.get(a.id);
      values.get(a.id)!.push(ends.has(a.id) ? { income: r?.revenue ?? 0, expenses: r?.opex ?? 0, total: ends.get(a.id)! } : null);
    }
  }
  const planned = Math.max(PLANNED_TACTS, all.length);
  return {
    tacts: Array.from({ length: planned }, (_, i) => {
      const t = all[i];
      return { number: i + 1, status: !t ? 'future' : t.closed_at ? 'closed' : t.begun_at ? 'running' : 'waiting', extra: i + 1 > PLANNED_TACTS };
    }),
    rows: companies
      .map((a) => ({ accountId: a.id, title: a.title, owner: ownersText(members.get(a.id)).owner, values: [...values.get(a.id)!, ...Array(planned - all.length).fill(null)] }))
      .sort((x, y) => x.title.localeCompare(y.title, 'ru')),
  };
}

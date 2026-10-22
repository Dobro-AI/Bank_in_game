import { AppError, Db, Tx } from './db.js';
import { membersByAccount, ownersText, tacts as listTacts } from './reports.js';
import { hostAccountId, transferTx } from './transfers.js';

/**
 * Assets and capacities: servers, venues, trucks, staff... Holdings are the sum of ledger rows.
 * Per tact the host enters served output (hours, trips); revenue and OPEX are computed from
 * holdings and output and posted to accounts with one button each.
 */

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

  const rows = accounts
    .filter((a) => after.has(a.id) || before.has(a.id) || outputs.some((o) => o.account_id === a.id))
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
      let revenue = 0;
      let opex = 0;
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
        assets, capacity, served, revenue, opex, result: revenue - opex,
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
  const [ok] = await db.query(
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
}

/**
 * Posts revenue (credit) or OPEX (debit) of the open tact for every company that has not been
 * posted yet. OPEX may push an account below zero, as any host debit does.
 */
export async function postTact(db: Db, gameId: number, staffId: number, kind: 'revenue' | 'opex') {
  if (kind !== 'revenue' && kind !== 'opex') throw new AppError('Неизвестная операция');
  return db.transaction(async (tx) => {
    const [open] = await tx.query('select * from tact where game_id = $1 and closed_at is null for update', [gameId]);
    if (!open) throw new AppError('Нет открытого такта');
    const { rows } = await capacityTable(tx, gameId, open.id);
    const hostId = await hostAccountId(tx, gameId);
    let count = 0;
    let total = 0;
    for (const r of rows) {
      const amount = kind === 'revenue' ? r.revenue : r.opex;
      const done = kind === 'revenue' ? r.postedRevenue : r.postedOpex;
      if (amount <= 0 || done !== null) continue;
      const label = kind === 'revenue' ? `Выручка за такт ${open.number}` : `OPEX за такт ${open.number}`;
      const details = kind === 'revenue' ? r.revenueText : r.opexText;
      const t = await transferTx(tx, {
        gameId, kind: kind === 'revenue' ? 'host_credit' : 'host_debit',
        fromAccountId: kind === 'revenue' ? hostId : r.accountId,
        toAccountId: kind === 'revenue' ? r.accountId : hostId,
        amount, comment: `${label}: ${details}`, initiatorStaffId: staffId, allowNegative: true,
        idempotencyKey: `post:${kind}:${open.id}:${r.accountId}`,
      });
      await tx.query(
        'insert into tact_posting (tact_id, account_id, kind, amount, transfer_id) values ($1, $2, $3, $4, $5)',
        [open.id, r.accountId, kind, amount, t.id],
      );
      count++;
      total += amount;
    }
    return { count, total, tact: open.number };
  });
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
export async function addLedger(db: Db, gameId: number, staffId: number, body: { accountId: number; code: string; delta: unknown; comment?: string }) {
  await checkRefs(db, gameId, Number(body.accountId), String(body.code));
  const [open] = await db.query('select id from tact where game_id = $1 and closed_at is null', [gameId]);
  const [row] = await db.query(
    `insert into asset_ledger (game_id, account_id, asset_code, delta, tact_id, reason, comment, staff_id)
     values ($1, $2, $3, $4, $5, 'manual', $6, $7) returning *`,
    [gameId, Number(body.accountId), String(body.code), delta(body.delta), open?.id ?? null, String(body.comment ?? '').slice(0, 300), staffId],
  );
  return row;
}

export async function updateLedger(db: Db, gameId: number, id: number, body: { delta?: unknown; comment?: string }) {
  const [row] = await db.query('select * from asset_ledger where id = $1 and game_id = $2', [id, gameId]);
  if (!row) throw new AppError('Запись не найдена', 404);
  await db.query('update asset_ledger set delta = $2, comment = $3 where id = $1', [
    id, body.delta === undefined ? row.delta : delta(body.delta), body.comment === undefined ? row.comment : String(body.comment).slice(0, 300),
  ]);
}

export async function deleteLedger(db: Db, gameId: number, id: number) {
  await db.query('delete from asset_ledger where id = $1 and game_id = $2', [id, gameId]);
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

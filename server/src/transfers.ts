import { EventEmitter } from 'node:events';
import { AppError, Db, Tx, isUniqueViolation } from './db.js';
import { rebuildSnapshots } from './reports.js';

/** Committed transfers ('transfer', row): the Telegram bot listens to notify recipients. */
export const transferEvents = new EventEmitter().setMaxListeners(0);

export type TransferKind = 'player' | 'to_host' | 'fixed_price' | 'host_credit' | 'host_debit' | 'initial';

export interface TransferInput {
  gameId: number;
  kind: TransferKind;
  fromAccountId: number;
  toAccountId: number;
  amount: number;
  comment?: string;
  priceItemId?: number | null;
  initiatorPlayerId?: number | null;
  initiatorStaffId?: number | null;
  idempotencyKey?: string | null;
  /** Fixed-price costs and host debits may push a player account below zero. */
  allowNegative?: boolean;
}

export function parseAmount(v: unknown): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0) {
    throw new AppError('Сумма должна быть целым числом больше нуля');
  }
  return n;
}

/**
 * The only place where balances change. Must run inside a transaction:
 * the open tact is share-locked (so closing a tact waits for in-flight transfers)
 * and both accounts are row-locked in id order (no deadlocks, no overdraft races).
 */
export async function transferTx(tx: Tx, t: TransferInput) {
  const amount = parseAmount(t.amount);
  if (t.fromAccountId === t.toAccountId) throw new AppError('Нельзя перевести на тот же счёт');
  const comment = (t.comment ?? '').trim().slice(0, 500);

  const [tact] = await tx.query(
    'select id from tact where game_id = $1 and closed_at is null for share',
    [t.gameId],
  );
  if (!tact) throw new AppError('Игра ещё не запущена');

  const accounts = await tx.query(
    'select id, kind, balance from account where id = any($1::int[]) and game_id = $2 order by id for update',
    [[t.fromAccountId, t.toAccountId], t.gameId],
  );
  const from = accounts.find((a) => a.id === t.fromAccountId);
  const to = accounts.find((a) => a.id === t.toAccountId);
  if (!from || !to) throw new AppError('Счёт не найден в этой игре', 404);
  if (from.kind !== 'host' && !t.allowNegative && from.balance < amount) {
    throw new AppError('Недостаточно средств на счёте');
  }

  const [row] = await tx.query(
    `insert into transfer (game_id, tact_id, kind, from_account_id, to_account_id, amount, price_item_id,
       comment, initiator_player_id, initiator_staff_id, idempotency_key)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
    [t.gameId, tact.id, t.kind, from.id, to.id, amount, t.priceItemId ?? null, comment,
      t.initiatorPlayerId ?? null, t.initiatorStaffId ?? null, t.idempotencyKey || null],
  );
  await tx.query('update account set balance = balance - $1 where id = $2', [amount, from.id]);
  await tx.query('update account set balance = balance + $1 where id = $2', [amount, to.id]);
  return row;
}

/**
 * Runs a transfer in its own transaction. A repeated idempotency key (double tap, retry
 * after a dropped connection) returns the original transfer instead of charging again.
 */
export async function transfer(
  db: Db,
  t: TransferInput,
  check?: (tx: Tx) => Promise<void>,
  after?: (tx: Tx, row: any) => Promise<void>,
) {
  const key = t.idempotencyKey || null;
  if (key) {
    const [existing] = await db.query('select * from transfer where idempotency_key = $1', [key]);
    if (existing) return { transfer: existing, duplicate: true };
  }
  try {
    const row = await db.transaction(async (tx) => {
      if (check) await check(tx);
      const row = await transferTx(tx, t);
      if (after) await after(tx, row);
      return row;
    });
    transferEvents.emit('transfer', row);
    return { transfer: row, duplicate: false };
  } catch (e) {
    if (key && isUniqueViolation(e)) {
      const [existing] = await db.query('select * from transfer where idempotency_key = $1', [key]);
      if (existing) return { transfer: existing, duplicate: true };
    }
    throw e;
  }
}

/** Client keys are namespaced per initiator so one user can never replay another's key. */
const scopedKey = (scope: string, key?: string) => (key ? `${scope}:${String(key).slice(0, 100)}` : null);

/** A price item bought from the game master may add assets (servers, venues...) to the buyer. */
export async function recordPurchase(tx: Tx, row: { id: number; game_id: number; from_account_id: number; tact_id: number }, priceItemId: number, quantity: number) {
  const [item] = await tx.query('select title, asset_code, asset_qty from price_item where id = $1', [priceItemId]);
  if (!item?.asset_code || !item.asset_qty) return;
  await tx.query(
    `insert into asset_ledger (game_id, account_id, asset_code, delta, tact_id, reason, transfer_id, comment)
     values ($1, $2, $3, $4, $5, 'purchase', $6, $7)`,
    [row.game_id, row.from_account_id, item.asset_code, item.asset_qty * quantity, row.tact_id, row.id,
      quantity > 1 ? `${item.title} × ${quantity}` : item.title],
  );
}

export async function hostAccountId(tx: Tx, gameId: number): Promise<number> {
  const [a] = await tx.query("select id from account where game_id = $1 and kind = 'host'", [gameId]);
  if (!a) throw new AppError('Игра ещё не запущена');
  return a.id;
}

/** Accounts a player may send from: owner, or co-owner who has entered the account PIN once. */
export async function assertCanSpend(tx: Tx, roleId: number, accountId: number) {
  const [m] = await tx.query(
    'select member, pin_ok from account_member where role_id = $1 and account_id = $2',
    [roleId, accountId],
  );
  if (!m) throw new AppError('Нет доступа к этому счёту', 403);
  if (m.member === 'coowner' && !m.pin_ok) {
    throw new AppError('Введите PIN счёта, чтобы переводить с него', 403);
  }
}

export interface PlayerCtx {
  playerId: number;
  roleId: number;
  gameId: number;
}

export async function playerTransfer(
  db: Db,
  p: PlayerCtx,
  body: { fromAccountId: number; toAccountId: number; amount: unknown; comment?: string; idempotencyKey?: string },
) {
  const amount = parseAmount(body.amount);
  const [to] = await db.query('select kind from account where id = $1 and game_id = $2', [body.toAccountId, p.gameId]);
  if (!to) throw new AppError('Получатель не найден', 404);
  return transfer(
    db,
    {
      gameId: p.gameId,
      kind: to.kind === 'host' ? 'to_host' : 'player',
      fromAccountId: body.fromAccountId,
      toAccountId: body.toAccountId,
      amount,
      comment: body.comment,
      initiatorPlayerId: p.playerId,
      idempotencyKey: scopedKey(`p${p.playerId}`, body.idempotencyKey),
    },
    (tx) => assertCanSpend(tx, p.roleId, body.fromAccountId),
  );
}

export async function payFixedPrice(
  db: Db,
  p: PlayerCtx,
  body: { fromAccountId: number; priceItemId: number; quantity?: unknown; comment?: string; idempotencyKey?: string },
) {
  const quantity = body.quantity == null ? 1 : Number(body.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) throw new AppError('Количество — от 1 до 1000');
  const [item] = await db.query(
    'select id, title, price from price_item where id = $1 and game_id = $2 and active',
    [body.priceItemId, p.gameId],
  );
  if (!item) throw new AppError('Позиция прайса не найдена', 404);
  const hostId = await hostAccountId(db, p.gameId);
  const what = quantity > 1 ? `${item.title} × ${quantity}` : item.title;
  const comment = [what, (body.comment ?? '').trim()].filter(Boolean).join(' — ');
  return transfer(
    db,
    {
      gameId: p.gameId,
      kind: 'fixed_price',
      fromAccountId: body.fromAccountId,
      toAccountId: hostId,
      amount: item.price * quantity,
      priceItemId: item.id,
      comment,
      initiatorPlayerId: p.playerId,
      idempotencyKey: scopedKey(`p${p.playerId}`, body.idempotencyKey),
      allowNegative: true,
    },
    (tx) => assertCanSpend(tx, p.roleId, body.fromAccountId),
    (tx, row) => recordPurchase(tx, row, item.id, quantity),
  );
}

export async function hostAdjust(
  db: Db,
  gameId: number,
  staffId: number,
  body: { accountId: number; direction: 'credit' | 'debit'; amount: unknown; comment?: string; idempotencyKey?: string },
) {
  const amount = parseAmount(body.amount);
  const hostId = await hostAccountId(db, gameId);
  if (body.accountId === hostId) throw new AppError('Выберите счёт игрока');
  const credit = body.direction === 'credit';
  if (!credit && body.direction !== 'debit') throw new AppError('Неизвестный тип операции');
  return transfer(db, {
    gameId,
    kind: credit ? 'host_credit' : 'host_debit',
    fromAccountId: credit ? hostId : body.accountId,
    toAccountId: credit ? body.accountId : hostId,
    amount,
    comment: body.comment,
    initiatorStaffId: staffId,
    idempotencyKey: scopedKey(`s${staffId}`, body.idempotencyKey),
    allowNegative: true,
  });
}

/** Revenue/OPEX postings carry `post:<kind>:<tact>:<account>:…` keys; their signed share of tact_posting. */
async function postingShare(tx: Tx, t: any, amount: number) {
  const m = /^post:(revenue|opex):(\d+):(\d+):/.exec(t.idempotency_key ?? '');
  if (!m) return;
  const [, kind, tactId, accountId] = m;
  // Revenue counts when money goes to the company, OPEX when it leaves the company.
  const toCompany = t.to_account_id === Number(accountId);
  const sign = (kind === 'revenue') === toCompany ? 1 : -1;
  await tx.query('update tact_posting set amount = amount + $1 where tact_id = $2 and account_id = $3 and kind = $4',
    [sign * amount, Number(tactId), Number(accountId), kind]);
}

/**
 * The host corrects a transfer of any tact: balances move by the difference and snapshots of
 * closed tacts are recounted. Start capital and revenue/OPEX postings keep their accounts.
 */
export async function editTransfer(
  db: Db,
  gameId: number,
  transferId: number,
  body: { amount?: unknown; comment?: string; fromAccountId?: number; toAccountId?: number },
) {
  await db.transaction(async (tx) => {
    const [t] = await tx.query('select * from transfer where id = $1 and game_id = $2 for update', [transferId, gameId]);
    if (!t) throw new AppError('Перевод не найден', 404);
    const amount = body.amount === undefined ? Number(t.amount) : parseAmount(body.amount);
    const fixed = t.kind === 'initial' || String(t.idempotency_key ?? '').startsWith('post:');
    const fromId = fixed || !body.fromAccountId ? t.from_account_id : Number(body.fromAccountId);
    const toId = fixed || !body.toAccountId ? t.to_account_id : Number(body.toAccountId);
    if (fromId === toId) throw new AppError('Отправитель и получатель совпадают');
    const ids = [...new Set([t.from_account_id, t.to_account_id, fromId, toId])];
    const accounts = await tx.query('select id, kind from account where id = any($1::int[]) and game_id = $2 order by id for update', [ids, gameId]);
    if (accounts.length !== ids.length) throw new AppError('Счёт не найден в этой игре', 404);
    const kindOf = (id: number) => accounts.find((a) => a.id === id).kind;
    let kind = t.kind;
    if (!fixed && (fromId !== t.from_account_id || toId !== t.to_account_id)) {
      if (kindOf(fromId) === 'host') kind = 'host_credit';
      else if (kindOf(toId) === 'host') kind = ['fixed_price', 'to_host', 'host_debit'].includes(t.kind) ? t.kind : 'to_host';
      else kind = 'player';
    }
    await tx.query('update account set balance = balance + $1 where id = $2', [t.amount, t.from_account_id]);
    await tx.query('update account set balance = balance - $1 where id = $2', [t.amount, t.to_account_id]);
    await tx.query('update account set balance = balance - $1 where id = $2', [amount, fromId]);
    await tx.query('update account set balance = balance + $1 where id = $2', [amount, toId]);
    await postingShare(tx, t, amount - Number(t.amount));
    const comment = body.comment === undefined ? t.comment : String(body.comment).trim().slice(0, 500);
    await tx.query('update transfer set amount = $1, from_account_id = $2, to_account_id = $3, kind = $4, comment = $5 where id = $6',
      [amount, fromId, toId, kind, comment, t.id]);
    await rebuildSnapshots(tx, gameId, t.tact_id);
  });
}

/** Removes a transfer as if it never happened; assets bought with it go too. */
export async function deleteTransfer(db: Db, gameId: number, transferId: number) {
  await db.transaction(async (tx) => {
    const [t] = await tx.query('select * from transfer where id = $1 and game_id = $2 for update', [transferId, gameId]);
    if (!t) throw new AppError('Перевод не найден', 404);
    await tx.query('select id from account where id = any($1::int[]) order by id for update', [[t.from_account_id, t.to_account_id]]);
    await tx.query('update account set balance = balance + $1 where id = $2', [t.amount, t.from_account_id]);
    await tx.query('update account set balance = balance - $1 where id = $2', [t.amount, t.to_account_id]);
    await postingShare(tx, t, -Number(t.amount));
    await tx.query("delete from asset_ledger where transfer_id = $1 and reason = 'purchase'", [t.id]);
    await tx.query('update assistant_proposal set transfer_id = null where transfer_id = $1', [t.id]);
    await tx.query('delete from transfer where id = $1', [t.id]);
    await rebuildSnapshots(tx, gameId, t.tact_id);
  });
}

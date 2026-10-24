import ExcelJS from 'exceljs';
import { AppError, Db, Tx } from './db.js';

export interface Filters {
  tactId?: number;
  roleId?: number;
  accountId?: number;
}

export const KIND_LABEL: Record<string, string> = {
  player: 'Перевод',
  to_host: 'Игротехнику',
  fixed_price: 'По прайсу',
  host_credit: 'Начисление',
  host_debit: 'Списание',
  initial: 'Стартовый баланс',
};

export async function tacts(db: Tx, gameId: number) {
  return db.query('select * from tact where game_id = $1 order by number', [gameId]);
}

/** Owner and co-owner names per account, keyed by account id. */
export async function membersByAccount(db: Tx, gameId: number) {
  const rows = await db.query(
    `select m.account_id, m.role_id, m.member, m.pin_ok, r.title as role_title, (select string_agg(trim(p.first_name || ' ' || p.last_name), ', ' order by p.id) from player p where p.role_id = r.id) as players
     from account_member m
     join account a on a.id = m.account_id
     join role r on r.id = m.role_id
     where a.game_id = $1
     order by m.member desc, r.title`,
    [gameId],
  );
  const map = new Map<number, any[]>();
  for (const r of rows) {
    const name = r.players ?? '';
    const item = { roleId: r.role_id, roleTitle: r.role_title, playerName: name, member: r.member, pinOk: r.pin_ok };
    map.set(r.account_id, [...(map.get(r.account_id) ?? []), item]);
  }
  return map;
}

const label = (m: any) => (m.playerName ? `${m.playerName} (${m.roleTitle})` : m.roleTitle);

export function ownersText(members: any[] = []) {
  const owner = members.filter((m) => m.member === 'owner').map(label);
  const co = members.filter((m) => m.member === 'coowner').map(label);
  return { owner: owner.join(', '), coowners: co.join(', ') };
}

export async function listTransfers(db: Db, gameId: number, f: Filters) {
  const params: unknown[] = [gameId];
  const where = ['t.game_id = $1'];
  if (f.tactId) {
    params.push(f.tactId);
    where.push(`t.tact_id = $${params.length}`);
  }
  if (f.accountId) {
    params.push(f.accountId);
    where.push(`(t.from_account_id = $${params.length} or t.to_account_id = $${params.length})`);
  }
  if (f.roleId) {
    params.push(f.roleId);
    const n = params.length;
    where.push(`(ip.role_id = $${n} or exists (select 1 from account_member m
      where m.role_id = $${n} and m.account_id in (t.from_account_id, t.to_account_id)))`);
  }
  return db.query(
    `select t.id, t.created_at, tc.number as tact, t.kind, t.amount, t.comment,
            coalesce(t.idempotency_key like 'post:%', false) as posting,
            t.from_account_id, fa.title as from_title, t.to_account_id, ta.title as to_title,
            coalesce(ip.first_name || ' ' || ip.last_name || ' (' || ir.title || ')', s.name, '') as initiator
     from transfer t
     join tact tc on tc.id = t.tact_id
     join account fa on fa.id = t.from_account_id
     join account ta on ta.id = t.to_account_id
     left join player ip on ip.id = t.initiator_player_id
     left join role ir on ir.id = ip.role_id
     left join staff s on s.id = t.initiator_staff_id
     where ${where.join(' and ')}
     order by t.id desc`,
    params,
  );
}

/**
 * Per-account summary for a tact. A closed tact is read from its snapshot; the open tact
 * is computed live: start = previous snapshot end, end = start + received − sent.
 */
export async function summary(db: Tx, gameId: number, tactId?: number) {
  const all = await tacts(db, gameId);
  const tact = tactId ? all.find((t) => t.id === tactId) : all.find((t) => !t.closed_at);
  if (!tact) return { tact: null, rows: [] };
  const members = await membersByAccount(db, gameId);
  const accounts = await db.query('select id, kind, title, balance from account where game_id = $1', [gameId]);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  let rows: any[];
  if (tact.closed_at) {
    const snap = await db.query('select * from tact_snapshot where tact_id = $1', [tact.id]);
    rows = snap.map((s) => ({ accountId: s.account_id, balanceStart: s.balance_start, received: s.received,
      sent: s.sent, balanceEnd: s.balance_end, ownersSnapshot: s.owners }));
  } else {
    rows = await computeTact(db, gameId, tact, all);
  }
  const kindOrder: Record<string, number> = { legal: 0, individual: 1, host: 2 };
  rows = rows
    .map((r) => {
      const a = byId.get(r.accountId);
      const o = ownersText(members.get(r.accountId));
      return { ...r, title: a?.title ?? '', kind: a?.kind ?? '', owner: o.owner, coowners: o.coowners,
        roleIds: (members.get(r.accountId) ?? []).map((m) => m.roleId) };
    })
    .sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || a.title.localeCompare(b.title, 'ru'));
  return { tact, rows };
}

/** A tact from its transfers: start = previous snapshot end, end = start + received − sent. */
async function computeTact(db: Tx, gameId: number, tact: any, all: any[]) {
  const prev = all.filter((t) => t.number < tact.number).at(-1);
  const startRows = prev ? await db.query('select account_id, balance_end from tact_snapshot where tact_id = $1', [prev.id]) : [];
  const start = new Map(startRows.map((r) => [r.account_id, Number(r.balance_end)]));
  const moves = await db.query(
    `select a.id,
       coalesce((select sum(amount) from transfer where tact_id = $2 and to_account_id = a.id and kind <> 'initial'), 0) as received,
       coalesce((select sum(amount) from transfer where tact_id = $2 and from_account_id = a.id and kind <> 'initial'), 0) as sent,
       coalesce((select sum(case when to_account_id = a.id then amount else -amount end) from transfer
                 where tact_id = $2 and kind = 'initial' and a.id in (to_account_id, from_account_id)), 0) as initial
     from account a where a.game_id = $1`,
    [gameId, tact.id],
  );
  // Start-up capital counts as money at the start of the tact, not as an incoming transfer.
  return moves.map((m) => {
    const s = (start.get(m.id) ?? 0) + Number(m.initial);
    return { accountId: m.id, balanceStart: s, received: Number(m.received), sent: Number(m.sent),
      balanceEnd: s + Number(m.received) - Number(m.sent) };
  });
}

/** After a transfer of a closed tact was corrected, that tact's snapshot and every later one are recounted. */
export async function rebuildSnapshots(tx: Tx, gameId: number, fromTactId: number) {
  const all = await tacts(tx, gameId);
  const from = all.find((t) => t.id === fromTactId);
  if (!from) return;
  for (const t of all.filter((x) => x.closed_at && x.number >= from.number)) {
    for (const r of await computeTact(tx, gameId, t, all)) {
      await tx.query(
        `insert into tact_snapshot (tact_id, account_id, balance_start, received, sent, balance_end) values ($1,$2,$3,$4,$5,$6)
         on conflict (tact_id, account_id) do update set balance_start = excluded.balance_start,
           received = excluded.received, sent = excluded.sent, balance_end = excluded.balance_end`,
        [t.id, r.accountId, r.balanceStart, r.received, r.sent, r.balanceEnd],
      );
    }
  }
}

/** Totals per player (sum of accounts they own) for the "сколько денег у каждого" view. */
export function totalsByOwner(rows: any[], members: Map<number, any[]>) {
  const totals = new Map<string, number>();
  for (const r of rows) {
    if (r.kind === 'host') continue;
    for (const m of (members.get(r.accountId) ?? []).filter((m) => m.member === 'owner')) {
      const k = label(m);
      totals.set(k, (totals.get(k) ?? 0) + r.balanceEnd);
    }
  }
  return [...totals].map(([owner, total]) => ({ owner, total })).sort((a, b) => b.total - a.total);
}

export async function closeTact(
  db: Db,
  gameId: number,
  onNextTact?: (tx: Tx, closed: any, next: any) => Promise<void>,
) {
  return db.transaction(async (tx) => {
    const [open] = await tx.query('select * from tact where game_id = $1 and closed_at is null for update', [gameId]);
    if (!open) throw new AppError('Нет открытого такта');
    const { rows } = await summary(tx, gameId, open.id);
    for (const r of rows) {
      await tx.query(
        `insert into tact_snapshot (tact_id, account_id, balance_start, received, sent, balance_end, owners)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [open.id, r.accountId, r.balanceStart, r.received, r.sent, r.balanceEnd,
          [r.owner, r.coowners].filter(Boolean).join('; ')],
      );
    }
    await tx.query('update tact set closed_at = now() where id = $1', [open.id]);
    const [next] = await tx.query('insert into tact (game_id, number) values ($1, $2) returning *', [gameId, open.number + 1]);
    if (onNextTact) await onNextTact(tx, open, next);
    return { closed: open, next };
  });
}

export async function exportXlsx(db: Db, gameId: number, f: Filters, extra: { title: string; rows: unknown[][] }[] = []) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Переводы');
  ws.columns = [
    { header: 'Дата и время', key: 'created_at', width: 20 },
    { header: 'Такт', key: 'tact', width: 6 },
    { header: 'Тип', key: 'kind', width: 16 },
    { header: 'Инициатор', key: 'initiator', width: 30 },
    { header: 'Отправитель', key: 'from_title', width: 28 },
    { header: 'Получатель', key: 'to_title', width: 28 },
    { header: 'Сумма', key: 'amount', width: 12 },
    { header: 'Комментарий', key: 'comment', width: 40 },
  ];
  for (const t of await listTransfers(db, gameId, f)) {
    ws.addRow({ ...t, created_at: new Date(t.created_at), kind: KIND_LABEL[t.kind] ?? t.kind });
  }
  ws.getColumn('created_at').numFmt = 'dd.mm.yyyy hh:mm:ss';

  const { tact, rows } = await summary(db, gameId, f.tactId);
  const ss = wb.addWorksheet(`Сводка такт ${tact?.number ?? ''}`.trim());
  ss.columns = [
    { header: 'Счёт', key: 'title', width: 28 },
    { header: 'Владелец', key: 'owner', width: 30 },
    { header: 'Совладельцы', key: 'coowners', width: 40 },
    { header: 'На начало такта', key: 'balanceStart', width: 16 },
    { header: 'Получено', key: 'received', width: 12 },
    { header: 'Отправлено', key: 'sent', width: 12 },
    { header: 'На конец такта', key: 'balanceEnd', width: 16 },
  ];
  for (const r of filterSummary(rows, f)) ss.addRow(r);
  for (const s of [ws, ss]) s.getRow(1).font = { bold: true };
  for (const sheet of extra) {
    const x = wb.addWorksheet(sheet.title);
    for (const r of sheet.rows) x.addRow(r as any[]);
    x.columns.forEach((c) => { c.width = 22; });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function filterSummary(rows: any[], f: Filters) {
  return rows.filter((r) => (!f.accountId || r.accountId === f.accountId) && (!f.roleId || r.roleIds.includes(f.roleId)));
}

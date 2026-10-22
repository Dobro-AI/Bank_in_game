import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import * as assets from './assets.js';
import { AppError, Db } from './db.js';
import { KIND_LABEL, listTransfers, membersByAccount, summary, totalsByOwner } from './reports.js';

/**
 * One-way mirror of a game into a Google spreadsheet: after every change the bank rewrites the
 * sheets (debounced). The bank stays the source of truth; edits made in the sheet are overwritten.
 * Access is through a Google service account; the host shares the spreadsheet with its e-mail.
 */

interface Credentials { client_email: string; private_key: string }

function credentials(): Credentials | null {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
    ?? (process.env.GOOGLE_SERVICE_ACCOUNT_FILE ? readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_FILE, 'utf8') : '');
  if (!raw) return null;
  const c = JSON.parse(raw);
  return c.client_email && c.private_key ? c : null;
}

export function serviceEmail() {
  return credentials()?.client_email ?? null;
}

let client: JWT | null = null;
function google() {
  const c = credentials();
  if (!c) throw new AppError('Google не настроен: задайте GOOGLE_SERVICE_ACCOUNT_JSON на сервере', 503);
  client ??= new JWT({ email: c.client_email, key: c.private_key, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  return client;
}

/** Accepts a spreadsheet link or a bare id. */
export function parseSheetId(v: unknown) {
  const s = String(v ?? '').trim();
  const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  const id = m ? m[1] : s;
  if (id && !/^[a-zA-Z0-9_-]{20,}$/.test(id)) throw new AppError('Не похоже на ссылку на Google-таблицу');
  return id;
}

type Cell = string | number;
const dt = (d: string | Date) =>
  new Date(d).toLocaleString('ru-RU', { timeZone: process.env.TZ_DISPLAY ?? 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** The sheets as rows. Exported for tests: no Google calls here. */
export async function buildSheets(db: Db, gameId: number): Promise<{ title: string; rows: Cell[][] }[]> {
  const transfers = await listTransfers(db, gameId, {});
  const sum = await summary(db, gameId);
  const members = await membersByAccount(db, gameId);
  let capacity: Awaited<ReturnType<typeof assets.capacityTable>> | null = null;
  try {
    capacity = await assets.capacityTable(db, gameId);
  } catch {
    capacity = null; // game not launched yet
  }
  const ledger = await assets.ledger(db, gameId);
  const tactNo = sum.tact?.number ?? '';

  return [
    {
      title: 'Переводы',
      rows: [
        ['Дата и время', 'Такт', 'Тип', 'Инициатор', 'Отправитель', 'Получатель', 'Сумма', 'Комментарий'],
        ...transfers.map((t): Cell[] => [dt(t.created_at), t.tact, KIND_LABEL[t.kind] ?? t.kind, t.initiator, t.from_title, t.to_title, t.amount, t.comment]),
      ],
    },
    {
      title: 'Сводка',
      rows: [
        [`Такт ${tactNo}`, '', '', '', '', '', ''],
        ['Счёт', 'Владелец', 'Совладельцы', 'На начало такта', 'Получено', 'Отправлено', 'На конец такта'],
        ...sum.rows.map((r): Cell[] => [r.title, r.owner, r.coowners, r.balanceStart, r.received, r.sent, r.balanceEnd]),
        [],
        ['Игрок', 'Всего на счетах'],
        ...totalsByOwner(sum.rows, members).map((t): Cell[] => [t.owner, t.total]),
      ],
    },
    {
      title: 'Мощности',
      rows: [
        [`Такт ${capacity?.tact.number ?? ''}`, '', '', '', '', '', '', ''],
        ['Компания', 'Актив', 'На начало такта', 'Изменение', 'На конец такта', 'Мощность', 'Ед. мощности', 'Обслужено'],
        ...(capacity?.rows ?? []).flatMap((r) => r.assets.map((a): Cell[] => [r.title, a.title, a.start, a.change, a.end, a.capacity, a.capacityUnit, a.output])),
      ],
    },
    {
      title: 'Выручка и OPEX',
      rows: [
        [`Такт ${capacity?.tact.number ?? ''}`, '', '', '', '', '', '', ''],
        ['Компания', 'Выручка', 'Расчёт выручки', 'OPEX', 'Расчёт OPEX', 'Итог', 'Выручка проведена', 'OPEX проведён'],
        ...(capacity?.rows ?? []).map((r): Cell[] => [
          r.title, r.revenue, r.revenueText, r.opex, r.opexText, r.result, r.postedRevenue ?? '', r.postedOpex ?? '',
        ]),
      ],
    },
    {
      title: 'Журнал активов',
      rows: [
        ['Дата и время', 'Такт', 'Компания', 'Актив', 'Изменение', 'Причина', 'Комментарий', 'Кто внёс'],
        ...ledger.map((l): Cell[] => [dt(l.created_at), l.tact ?? '', l.account_title, l.asset_title ?? l.asset_code, l.delta,
          ({ start: 'Старт', purchase: 'Покупка', manual: 'Вручную', aging: 'Новый такт' } as Record<string, string>)[l.reason] ?? l.reason,
          l.comment, l.staff_name ?? '']),
      ],
    },
  ];
}

const API = 'https://sheets.googleapis.com/v4/spreadsheets';

export async function syncNow(db: Db, gameId: number) {
  const [g] = await db.query('select sheet_id from game where id = $1', [gameId]);
  if (!g?.sheet_id) throw new AppError('Google-таблица не подключена');
  try {
    const api = google();
    const sheets = await buildSheets(db, gameId);
    const meta = await api.request<{ sheets: { properties: { title: string } }[] }>({ url: `${API}/${g.sheet_id}?fields=sheets.properties.title` });
    const existing = new Set(meta.data.sheets.map((s) => s.properties.title));
    const missing = sheets.filter((s) => !existing.has(s.title));
    if (missing.length) {
      await api.request({
        url: `${API}/${g.sheet_id}:batchUpdate`, method: 'POST',
        data: { requests: missing.map((s) => ({ addSheet: { properties: { title: s.title } } })) },
      });
    }
    const range = (title: string) => `'${title}'`;
    await api.request({ url: `${API}/${g.sheet_id}/values:batchClear`, method: 'POST', data: { ranges: sheets.map((s) => range(s.title)) } });
    await api.request({
      url: `${API}/${g.sheet_id}/values:batchUpdate`, method: 'POST',
      data: { valueInputOption: 'RAW', data: sheets.map((s) => ({ range: `${range(s.title)}!A1`, values: s.rows })) },
    });
    await db.query("update game set sheet_synced_at = now(), sheet_error = '' where id = $1", [gameId]);
  } catch (e: any) {
    const message = e instanceof AppError ? e.message
      : e?.response?.status === 403 || e?.response?.status === 404 ? `Нет доступа к таблице: откройте её для ${serviceEmail()} с правом редактирования`
      : 'Не удалось записать в Google-таблицу';
    if (!(e instanceof AppError)) console.error('sheets sync', e?.response?.data ?? e);
    await db.query('update game set sheet_error = $2 where id = $1', [gameId, message]);
    throw new AppError(message, 502);
  }
}

const timers = new Map<number, NodeJS.Timeout>();

/** Debounced background sync after a change; a burst of transfers becomes one write. */
export function scheduleSync(db: Db, gameId: number, delayMs = 3000) {
  if (!credentials()) return;
  clearTimeout(timers.get(gameId));
  timers.set(gameId, setTimeout(async () => {
    timers.delete(gameId);
    const [g] = await db.query('select sheet_id from game where id = $1', [gameId]).catch(() => [null]);
    if (g?.sheet_id) await syncNow(db, gameId).catch(() => {});
  }, delayMs));
}

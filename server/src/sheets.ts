import { existsSync, readFileSync } from 'node:fs';
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
  const file = process.env.GOOGLE_SERVICE_ACCOUNT_FILE;
  // A configured but not yet created key file means "not set up", not a crash.
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? (file && existsSync(file) ? readFileSync(file, 'utf8') : '');
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
  client ??= new JWT({ email: c.client_email, key: c.private_key, scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'] });
  return client;
}

/** Accepts a Drive folder link or a bare id. */
export function parseFolderId(v: unknown) {
  const s = String(v ?? '').trim();
  const m = s.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  const id = m ? m[1] : s;
  if (id && !/^[a-zA-Z0-9_-]{10,}$/.test(id)) throw new AppError('Не похоже на ссылку на папку Google Диска');
  return id;
}

// ---------- Folders: base folder / <root game> / <branch spreadsheet> ----------

const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const FOLDER = 'application/vnd.google-apps.folder';

export async function getSetting(db: Db, key: string) {
  const [r] = await db.query('select value from app_setting where key = $1', [key]);
  return (r?.value as string) ?? '';
}

export async function setSetting(db: Db, key: string, value: string) {
  await db.query('insert into app_setting (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value', [key, value]);
}

const q = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

async function ensureFolder(name: string, parent: string) {
  const api = google();
  const found = await api.request<{ files: { id: string }[] }>({
    url: DRIVE,
    params: {
      q: `name = '${q(name)}' and mimeType = '${FOLDER}' and '${parent}' in parents and trashed = false`,
      fields: 'files(id)', supportsAllDrives: true, includeItemsFromAllDrives: true,
    },
  });
  if (found.data.files[0]) return found.data.files[0].id;
  const created = await api.request<{ id: string }>({
    url: DRIVE, method: 'POST', params: { supportsAllDrives: true }, data: { name, mimeType: FOLDER, parents: [parent] },
  });
  return created.data.id;
}

const folderUrl = (id: string) => `https://drive.google.com/drive/folders/${id}`;

async function gameNames(db: Db, gameId: number) {
  const [g] = await db.query(
    `select b.title, b.sheet_id, r.title as root_title,
            coalesce((select string_agg(s.name, ', ') from game_staff gs join staff s on s.id = gs.staff_id where gs.game_id = b.id), '') as hosts
     from game b left join game r on r.id = b.parent_id where b.id = $1`,
    [gameId],
  );
  if (!g) throw new AppError('Игра не найдена', 404);
  return { ...g, folderName: (g.root_title ?? g.title) as string, sheetName: (g.hosts ? `${g.title} — ${g.hosts}` : g.title) as string };
}

/**
 * Files the connected spreadsheet under base folder / <root game> and gives it the standard name.
 * The host keeps owning the file (it uses their Drive storage); the bank only moves it.
 */
export async function placeInFolder(db: Db, gameId: number) {
  const base = await getSetting(db, 'drive_folder_id');
  const g = await gameNames(db, gameId);
  if (!base || !g.sheet_id) return;
  const folder = await ensureFolder(g.folderName, base);
  await db.query('update game set drive_folder_id = $2 where id = $1', [gameId, folder]);
  const api = google();
  const file = await api.request<{ parents?: string[] }>({ url: `${DRIVE}/${g.sheet_id}`, params: { fields: 'parents', supportsAllDrives: true } });
  // Parents are visible only inside folders shared with the bank; a sheet elsewhere (e.g. the host's
  // My Drive root) cannot be moved by an editor, so it is only renamed and stays where it is.
  const parents = file.data.parents ?? [];
  const move = parents.length > 0 && !parents.includes(folder);
  await api.request({
    url: `${DRIVE}/${g.sheet_id}`, method: 'PATCH',
    params: { supportsAllDrives: true, ...(move ? { addParents: folder, removeParents: parents.join(',') } : {}) },
    data: { name: g.sheetName },
  });
}

/**
 * Creates the branch's spreadsheet in base folder / <root game title>, connects it and fills it.
 * A service account has no Drive storage of its own, so Google may refuse to create the file in a
 * personal folder; the subfolder still gets created and the host is told to make the sheet there.
 */
export async function createInFolder(db: Db, gameId: number) {
  const base = await getSetting(db, 'drive_folder_id');
  if (!base) throw new AppError('Папка Google Диска для таблиц не задана (раздел «Google-таблица», делает Супер-ведущий)');
  const g = await gameNames(db, gameId);
  if (g.sheet_id) throw new AppError('Таблица уже подключена');
  let folder: string;
  try {
    folder = await ensureFolder(g.folderName, base);
  } catch (e: any) {
    const reason = e?.response?.data?.error?.details?.find((d: any) => d.reason)?.reason;
    throw new AppError(reason === 'SERVICE_DISABLED'
      ? 'В проекте Google Cloud выключен Google Drive API — включите его для проекта технического аккаунта'
      : e?.response?.status === 404 || e?.response?.status === 403
        ? `Нет доступа к папке: откройте её для ${serviceEmail()} с правом редактирования`
        : 'Не удалось создать подпапку на Google Диске', 502);
  }
  await db.query('update game set drive_folder_id = $2 where id = $1', [gameId, folder]);
  const name = g.sheetName;
  try {
    const sheet = await google().request<{ id: string }>({
      url: DRIVE, method: 'POST', params: { supportsAllDrives: true },
      data: { name, mimeType: 'application/vnd.google-apps.spreadsheet', parents: [folder] },
    });
    await db.query("update game set sheet_id = $2, sheet_error = '' where id = $1", [gameId, sheet.data.id]);
  } catch (e: any) {
    console.error('drive create sheet', e?.response?.data?.error?.message ?? e);
    throw new AppError(
      `Подпапка «${g.folderName}» готова, но Google не даёт техническому аккаунту создавать таблицы в личном Диске. ` +
      `Создайте таблицу в подпапке сами: ${folderUrl(folder)} (доступ для банка откроется автоматически) и вставьте ссылку ниже.`, 502);
  }
  await syncNow(db, gameId).catch(() => {});
  return { folderUrl: folderUrl(folder) };
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

import { existsSync, readFileSync } from 'node:fs';
import { JWT, OAuth2Client } from 'google-auth-library';
import * as assets from './assets.js';
import { AppError, Db } from './db.js';
import { userClient } from './google-user.js';
import { KIND_LABEL, listTransfers, membersByAccount, summary, tacts, totalsByOwner } from './reports.js';

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

async function ensureFolder(api: OAuth2Client, name: string, parent: string) {
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
  return { ...g, folderName: (g.root_title ?? g.title) as string, sheetName: g.title as string };
}

/**
 * Files the connected spreadsheet under base folder / <root game> and gives it the standard name.
 * The host keeps owning the file (it uses their Drive storage); the bank only moves it.
 */
export async function placeInFolder(db: Db, gameId: number) {
  const base = await getSetting(db, 'drive_folder_id');
  const g = await gameNames(db, gameId);
  if (!base || !g.sheet_id) return;
  const api = (await userClient(db)) ?? google();
  const folder = await ensureFolder(api, g.folderName, base);
  await db.query('update game set drive_folder_id = $2 where id = $1', [gameId, folder]);
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
  if (!base) throw new AppError('Папка Google Диска для таблиц не задана (раздел «Google-таблица», делает админ)');
  const g = await gameNames(db, gameId);
  if (g.sheet_id) throw new AppError('Таблица уже подключена');
  // Files are made as the connected Google user when there is one (their storage), else as the bank.
  const user = await userClient(db);
  const api = user ?? google();
  let folder: string;
  try {
    folder = await ensureFolder(api, g.folderName, base);
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
    const sheet = await api.request<{ id: string }>({
      url: DRIVE, method: 'POST', params: { supportsAllDrives: true },
      data: { name, mimeType: 'application/vnd.google-apps.spreadsheet', parents: [folder] },
    });
    await db.query("update game set sheet_id = $2, sheet_error = '' where id = $1", [gameId, sheet.data.id]);
  } catch (e: any) {
    console.error('drive create sheet', e?.response?.data?.error?.message ?? e);
    throw new AppError(
      (user ? `Подпапка «${g.folderName}» готова, но Google не дал создать таблицу от имени подключённого аккаунта. ` :
        `Подпапка «${g.folderName}» готова, но Google не даёт техническому аккаунту создавать таблицы в личном Диске (подключите вход через Google). `) +
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

const TACTS_SHOWN = 3;

/** Row kinds of the money sheet; each has its own look, like the organisers' "Деньги" sheet. */
type Style = 'head' | 'tact' | 'row' | 'alt' | 'blank' | 'total';
export interface SheetData { title: string; rows: Cell[][]; notes?: string[][]; styles?: Style[]; first?: boolean; log?: boolean }

/**
 * Every money action, like the organisers' "База": accepted transfers and the ones the bank refused,
 * with the reason, in the order they happened. Column A is the status.
 */
async function actionsSheet(db: Db, gameId: number): Promise<SheetData> {
  const done = await listTransfers(db, gameId, {});
  const refused = await db.query(
    `select a.created_at, tc.number as tact, a.kind, a.amount, a.comment, a.reason,
            coalesce(fa.title, '') as from_title, coalesce(ta.title, '') as to_title,
            coalesce(ip.first_name || ' ' || ip.last_name || ' (' || ir.title || ')', s.name, '') as initiator
     from transfer_attempt a
     left join tact tc on tc.id = a.tact_id
     left join account fa on fa.id = a.from_account_id
     left join account ta on ta.id = a.to_account_id
     left join player ip on ip.id = a.initiator_player_id
     left join role ir on ir.id = ip.role_id
     left join staff s on s.id = a.initiator_staff_id
     where a.game_id = $1`,
    [gameId],
  );
  const all = [...done.map((t) => ({ ...t, status: 'Принято', reason: '' })), ...refused.map((t) => ({ ...t, status: 'Отклонено' }))]
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  return {
    title: 'Переводы',
    log: true,
    rows: [
      ['Статус', 'Причина', 'Отметка времени', 'Такт', 'Кто сделал', 'От кого', 'Действие', 'Кому', 'Сумма', 'Комментарий'],
      ...all.map((t): Cell[] => [t.status, t.reason, dt(t.created_at), t.tact ?? '', t.initiator.trim() || 'Банк', t.from_title,
        KIND_LABEL[t.kind] ?? t.kind, t.to_title, t.amount === null ? '' : Number(t.amount), t.comment]),
    ],
  };
}

export const column = (n: number): string => (n <= 26 ? String.fromCharCode(64 + n) : column(Math.floor((n - 1) / 26)) + column(((n - 1) % 26) + 1));

/**
 * The organisers' "Деньги" sheet: a block per tact, a row per company. B is the money at the start
 * of the tact (the previous tact's balance), every transfer goes into the next free cell to the
 * right (+ came in, − went out, details in the cell's note), C is the balance = B + all of them.
 */
async function moneySheet(db: Db, gameId: number, title: string): Promise<SheetData> {
  const kindOrder: Record<string, number> = { legal: 0, individual: 1 };
  const accounts = (await db.query("select id, kind, title from account where game_id = $1 and kind <> 'host'", [gameId]))
    .sort((x, y) => kindOrder[x.kind] - kindOrder[y.kind] || x.title.localeCompare(y.title, 'ru'));
  const moves = await db.query(
    `select t.tact_id, t.kind, t.amount, t.comment, t.from_account_id, t.to_account_id, fa.title as from_title, ta.title as to_title
     from transfer t join account fa on fa.id = t.from_account_id join account ta on ta.id = t.to_account_id
     where t.game_id = $1 order by t.id`,
    [gameId],
  );
  // The game is planned for three tacts: all of them are on the sheet from the start, later ones empty.
  const played = await tacts(db, gameId);
  const all = [...played, ...Array.from({ length: Math.max(0, TACTS_SHOWN - played.length) }, (_, i) => ({ id: 0, number: played.length + i + 1, closed_at: null, future: true }))];
  const cellsOf = (tactId: number, id: number) => moves
    .filter((m) => m.tact_id === tactId && m.kind !== 'initial' && (m.from_account_id === id || m.to_account_id === id))
    .map((m) => {
      const incoming = m.to_account_id === id;
      return { v: incoming ? Number(m.amount) : -Number(m.amount), note: `${incoming ? `от: ${m.from_title}` : `кому: ${m.to_title}`}${m.comment ? ` — ${m.comment}` : ''}` };
    });
  const most = Math.max(0, ...all.flatMap((t) => accounts.map((x) => cellsOf(t.id, x.id).length)));
  const last = column(3 + Math.max(most + 5, 20));

  const rows: Cell[][] = [[title, 'На начало такта', 'Остаток на счету', 'Переводы: + пришло, − ушло (от кого и за что — в примечании к ячейке)']];
  const notes: string[][] = [[]];
  const styles: Style[] = ['head'];
  const push = (style: Style, row: Cell[] = [], note: string[] = []) => { rows.push(row); styles.push(style); notes.push(note); return rows.length; };
  const prevRow = new Map<number, number>();
  for (const t of all) {
    push('tact', [`${t.number} такт${'future' in t ? '' : t.closed_at ? '' : ' — идёт'}`]);
    const first = rows.length + 1;
    accounts.forEach((x, i) => {
      const n = rows.length + 1;
      // Start capital is money at the start of tact 1, not a transfer.
      const initial = moves.filter((m) => m.tact_id === t.id && m.kind === 'initial' && m.to_account_id === x.id).reduce((sum, m) => sum + Number(m.amount), 0)
        - moves.filter((m) => m.tact_id === t.id && m.kind === 'initial' && m.from_account_id === x.id).reduce((sum, m) => sum + Number(m.amount), 0);
      const prev = prevRow.get(x.id);
      const start: Cell = prev ? `=C${prev}${initial ? `+${initial}` : ''}` : initial;
      const cells = cellsOf(t.id, x.id);
      push(i % 2 ? 'alt' : 'row', [x.title, start, `=B${n}+SUM(D${n}:${last}${n})`, ...cells.map((c) => c.v)], ['', '', '', ...cells.map((c) => c.note)]);
      prevRow.set(x.id, n);
    });
    const end = rows.length;
    push('blank');
    push('total', ['Сумма у всех:', `=SUM(B${first}:B${end})`, `=SUM(C${first}:C${end})`]);
    push('blank');
  }
  return { title: 'Деньги', rows, notes, styles, first: true };
}

/** The sheets as rows. Exported for tests: no Google calls here. Styled sheets carry formulas and formatting. */
export async function buildSheets(db: Db, gameId: number): Promise<SheetData[]> {
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
    ...(sum.tact ? [await moneySheet(db, gameId, (await gameNames(db, gameId)).title)] : []),
    await actionsSheet(db, gameId),
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

const rgb = (hex: string) => ({ red: parseInt(hex.slice(1, 3), 16) / 255, green: parseInt(hex.slice(3, 5), 16) / 255, blue: parseInt(hex.slice(5, 7), 16) / 255 });
const BG: Record<Style, string> = { head: '#f9e2cf', tact: '#f9e2cf', row: '#ffffff', alt: '#dff3f8', blank: '#ffffff', total: '#fbe0d9' };
const thin = { style: 'SOLID', color: rgb('#c7c7c7') };
const bold = { style: 'SOLID_MEDIUM', color: rgb('#000000') };

/** Whole-sheet rewrite of a styled sheet: size, frozen panes, values with formulas, colours, notes. */
const size = (sheetId: number, dimension: 'COLUMNS' | 'ROWS', start: number, end: number, pixelSize: number) =>
  ({ updateDimensionProperties: { range: { sheetId, dimension, startIndex: start, endIndex: end }, properties: { pixelSize }, fields: 'pixelSize' } });

/** The actions log: grey header, green "Принято" / red "Отклонено" in column A, like "База". */
export function logRequests(sheetId: number, x: SheetData): object[] {
  const widths = [100, 240, 150, 48, 220, 170, 120, 170, 72, 320];
  const rows = x.rows.map((r, i) => ({
    values: widths.map((_, c) => {
      const v = r[c];
      const ok = r[0] === 'Принято';
      const status = i > 0 && c === 0;
      return {
        ...(v === undefined || v === '' ? {} : { userEnteredValue: typeof v === 'number' ? { numberValue: v } : { stringValue: v } }),
        userEnteredFormat: {
          backgroundColor: rgb(i === 0 ? '#efefef' : status ? (ok ? '#d9ead3' : '#f4cccc') : '#ffffff'),
          horizontalAlignment: i === 0 || [0, 2, 3, 6, 8].includes(c) ? 'CENTER' : 'LEFT',
          verticalAlignment: 'MIDDLE',
          wrapStrategy: 'CLIP',
          textFormat: {
            bold: i === 0 || status, fontSize: i === 0 ? 11 : 10,
            foregroundColor: rgb(status ? (ok ? '#274e13' : '#990000') : '#000000'),
          },
          ...(c === 8 && i > 0 ? { numberFormat: { type: 'NUMBER', pattern: '#,##0' } } : {}),
          borders: { top: thin, bottom: i === 0 ? bold : thin, left: thin, right: thin },
        },
      };
    }),
  }));
  return [
    { updateSheetProperties: {
      properties: { sheetId, gridProperties: { rowCount: Math.max(x.rows.length + 50, 200), columnCount: widths.length, frozenRowCount: 1, frozenColumnCount: 0 } },
      fields: 'gridProperties(rowCount,columnCount,frozenRowCount,frozenColumnCount)',
    } },
    { updateCells: { range: { sheetId }, fields: '*' } },
    { updateCells: { start: { sheetId, rowIndex: 0, columnIndex: 0 }, rows, fields: 'userEnteredValue,userEnteredFormat' } },
    ...widths.map((w, c) => size(sheetId, 'COLUMNS', c, c + 1, w)), size(sheetId, 'ROWS', 0, 1, 32),
  ];
}

export function styledRequests(sheetId: number, x: SheetData): object[] {
  const width = Math.max(...x.rows.map((r) => r.length), 23);
  const value = (v: Cell) => (typeof v === 'number' ? { numberValue: v } : v.startsWith('=') ? { formulaValue: v } : { stringValue: v });
  const rows = x.rows.map((r, i) => {
    const style = x.styles![i];
    return {
      values: Array.from({ length: width }, (_, c) => {
        const v = r[c];
        const black = c === 0 && (style === 'tact' || style === 'head');
        const money = c >= 3 && (style === 'row' || style === 'alt');
        return {
          ...(v === undefined || v === '' ? {} : { userEnteredValue: value(v) }),
          ...(x.notes?.[i]?.[c] ? { note: x.notes[i][c] } : {}),
          userEnteredFormat: {
            backgroundColor: rgb(black ? '#000000' : BG[style]),
            horizontalAlignment: style === 'total' && c === 0 ? 'RIGHT' : style === 'head' && c >= 3 ? 'LEFT' : 'CENTER',
            verticalAlignment: 'MIDDLE',
            wrapStrategy: style === 'head' && c < 3 ? 'WRAP' : 'OVERFLOW_CELL',
            textFormat: {
              bold: style === 'head' || style === 'tact' || (c > 0 && c < 3 && style !== 'blank'),
              fontSize: style === 'tact' && c === 0 ? 14 : 10,
              foregroundColor: rgb(black ? '#ffffff' : money && typeof v === 'number' && v < 0 ? '#b91c1c' : '#000000'),
            },
            ...(money ? { numberFormat: { type: 'NUMBER', pattern: '+#,##0;-#,##0;0' } } : {}),
            ...(c > 0 && c < 3 ? { numberFormat: { type: 'NUMBER', pattern: '#,##0;[Red]-#,##0;0' } } : {}),
            ...(style === 'blank' ? {} : {
              borders: { top: thin, bottom: thin, left: c === 1 ? bold : thin, right: c === 0 || c === 2 ? bold : thin },
            }),
          },
        };
      }),
    };
  });
  const size = (dimension: 'COLUMNS' | 'ROWS', start: number, end: number, pixelSize: number) =>
    ({ updateDimensionProperties: { range: { sheetId, dimension, startIndex: start, endIndex: end }, properties: { pixelSize }, fields: 'pixelSize' } });
  return [
    { updateSheetProperties: {
      properties: { sheetId, gridProperties: { rowCount: Math.max(x.rows.length + 20, 200), columnCount: width, frozenRowCount: 1, frozenColumnCount: 3 } },
      fields: 'gridProperties(rowCount,columnCount,frozenRowCount,frozenColumnCount)',
    } },
    { updateCells: { range: { sheetId }, fields: '*' } },
    { updateCells: { start: { sheetId, rowIndex: 0, columnIndex: 0 }, rows, fields: 'userEnteredValue,userEnteredFormat,note' } },
    size('COLUMNS', 0, 1, 230), size('COLUMNS', 1, 3, 84), size('COLUMNS', 3, width, 56), size('ROWS', 0, 1, 64),
    ...x.styles!.flatMap((st, i) => (st === 'tact' ? [size('ROWS', i, i + 1, 36)] : [])),
  ];
}

export async function syncNow(db: Db, gameId: number) {
  const [g] = await db.query('select sheet_id, sheet_gids from game where id = $1', [gameId]);
  if (!g?.sheet_id) throw new AppError('Google-таблица не подключена');
  try {
    const api = google();
    const sheets = await buildSheets(db, gameId);
    // Tab ids are remembered; Google is asked only when a tab is missing (first sync, deleted tab).
    let gids: Record<string, number> = g.sheet_gids ?? {};
    if (!sheets.every((s) => s.title in gids)) {
      const meta = await api.request<{ sheets: { properties: { title: string; sheetId: number } }[] }>({
        url: `${API}/${g.sheet_id}?fields=sheets.properties(title,sheetId)`,
      });
      gids = Object.fromEntries(meta.data.sheets.map((x) => [x.properties.title, x.properties.sheetId]));
      const missing = sheets.filter((x) => !(x.title in gids));
      if (missing.length) {
        const added = await api.request<{ replies: { addSheet: { properties: { title: string; sheetId: number } } }[] }>({
          url: `${API}/${g.sheet_id}:batchUpdate`, method: 'POST',
          // The account sheet goes first, the way the organisers' own file opens.
          data: { requests: missing.map((x) => ({ addSheet: { properties: { title: x.title, ...(x.first ? { index: 0 } : {}) } } })) },
        });
        for (const r of added.data.replies) gids[r.addSheet.properties.title] = r.addSheet.properties.sheetId;
      }
      await db.query('update game set sheet_gids = $2 where id = $1', [gameId, JSON.stringify(gids)]);
    }
    const range = (title: string) => `'${title}'`;
    const plain = sheets.filter((x) => !x.styles && !x.log);
    await api.request({ url: `${API}/${g.sheet_id}/values:batchClear`, method: 'POST', data: { ranges: plain.map((x) => range(x.title)) } });
    await api.request({
      url: `${API}/${g.sheet_id}/values:batchUpdate`, method: 'POST',
      data: { valueInputOption: 'RAW', data: plain.map((x) => ({ range: `${range(x.title)}!A1`, values: x.rows })) },
    });
    const styled = sheets.filter((x) => x.styles || x.log);
    if (styled.length) {
      await api.request({
        url: `${API}/${g.sheet_id}:batchUpdate`, method: 'POST',
        data: { requests: styled.flatMap((x) => (x.log ? logRequests(gids[x.title], x) : styledRequests(gids[x.title], x))) },
      });
    }
    await db.query("update game set sheet_synced_at = now(), sheet_error = '' where id = $1", [gameId]);
  } catch (e: any) {
    // A tab deleted by hand makes the remembered ids stale: forget them, the next sync re-reads.
    if (e?.response?.status === 400) await db.query("update game set sheet_gids = '{}' where id = $1", [gameId]).catch(() => {});
    const message = e instanceof AppError ? e.message
      : e?.response?.status === 403 || e?.response?.status === 404 ? `Нет доступа к таблице: откройте её для ${serviceEmail()} с правом редактирования`
      : 'Не удалось записать в Google-таблицу';
    if (!(e instanceof AppError)) console.error('sheets sync', e?.response?.data ?? e);
    await db.query('update game set sheet_error = $2 where id = $1', [gameId, message]);
    throw new AppError(message, 502);
  }
}

const timers = new Map<number, NodeJS.Timeout>();
const running = new Set<number>();
const again = new Set<number>();

/**
 * Writes a game to its sheet about a second after a change. Changes arriving meanwhile join the
 * same write; one arriving during a write triggers one more right after. Two Google calls per write
 * keep a busy game well inside the Sheets API quota.
 */
export function scheduleSync(db: Db, gameId: number, delayMs = 1200) {
  if (!credentials()) return;
  if (running.has(gameId)) { again.add(gameId); return; }
  if (timers.has(gameId)) return;
  timers.set(gameId, setTimeout(async () => {
    timers.delete(gameId);
    const [g] = await db.query('select sheet_id from game where id = $1', [gameId]).catch(() => [null]);
    if (!g?.sheet_id) return;
    running.add(gameId);
    await syncNow(db, gameId).catch(() => {});
    running.delete(gameId);
    if (again.delete(gameId)) scheduleSync(db, gameId, delayMs);
  }, delayMs));
}

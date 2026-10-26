import { existsSync, readFileSync } from 'node:fs';
import { JWT, OAuth2Client } from 'google-auth-library';
import * as assets from './assets.js';
import { AppError, Db } from './db.js';
import { userClient } from './google-user.js';
import { deleteTransfer, editTransfer, hostAccountId, transfer } from './transfers.js';
import { KIND_LABEL, PLANNED_TACTS, listTransfers, tacts } from './reports.js';

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
export function google() {
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
export async function placeInFolder(db: Db, gameId: number, copy?: { sheetId: string; owner: string }) {
  const base = await getSetting(db, 'drive_folder_id');
  const g = await gameNames(db, gameId);
  // A game master's copy is named after them: "Развлечения — Игорь Воробьев".
  if (copy) Object.assign(g, { sheet_id: copy.sheetId, sheetName: `${g.sheetName} — ${copy.owner}` });
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

/** "1 такт — идёт", "4 такт — дополнительный, завершён": planned tacts are shown from the start, extra ones are marked. */
const tactLabel = (t: { number: number; closed_at: unknown; begun_at?: unknown; future?: boolean }) =>
  `${t.number} такт${[t.number > PLANNED_TACTS ? 'дополнительный' : '', t.future || t.closed_at ? '' : t.begun_at ? 'идёт' : 'не начат']
    .filter(Boolean).map((x, i) => (i ? `, ${x}` : ` — ${x}`)).join('')}`;

/** One cell: its value (a formula starts with "=") and its look. */
export interface Spec {
  /** `edit`: what a change of this cell in Google means for the bank (see applyEdit). */
  v?: Cell; note?: string; bg?: string; fg?: string; bold?: boolean; size?: number; edit?: string;
  align?: 'LEFT' | 'CENTER' | 'RIGHT'; wrap?: boolean; fmt?: string; edge?: boolean; bare?: boolean;
}
/** A whole sheet as the bank writes it: values with formulas, colours, notes, column widths, frozen panes. */
export interface Grid { title: string; cells: Spec[][]; widths: number[]; frozen: [rows: number, cols: number]; tall?: Record<number, number>; first?: boolean }
export const values = (g: Grid): Cell[][] => g.cells.map((r) => r.map((c) => c.v ?? ''));

export const column = (n: number): string => (n <= 26 ? String.fromCharCode(64 + n) : column(Math.floor((n - 1) / 26)) + column(((n - 1) % 26) + 1));
const pad = (cells: Spec[], width: number, fill: Spec = {}) => [...cells, ...Array.from({ length: Math.max(0, width - cells.length) }, () => ({ ...fill }))];

const BLACK: Spec = { bg: '#000000', fg: '#ffffff', bold: true };
const PEACH = '#f9e2cf';
const ALT = '#dff3f8';
const TOTAL = '#fbe0d9';
const INCOME = '#d9ead3';
const COST = '#f4cccc';
const COST_SUM = '#e6b8b7';
const POWER = '#fce5cd';
const POWER_GREEN = '#d9ead3';
const NUM = '#,##0;[Red]-#,##0;0';
const SIGNED = '+#,##0;-#,##0;0';

const kindOrder: Record<string, number> = { legal: 0, individual: 1 };
const companiesOf = async (db: Db, gameId: number) =>
  (await db.query("select id, kind, title from account where game_id = $1 and kind <> 'host'", [gameId]))
    .sort((x, y) => kindOrder[x.kind] - kindOrder[y.kind] || x.title.localeCompare(y.title, 'ru'));

/**
 * "Мощности": per tact a row per company and, across, a group of columns per asset — quantity,
 * hours or trips served (when they cost or earn), expenses = quantity × expense of one unit
 * (+ served × cost of one trip), capacity = quantity × capacity of one unit — and the company's
 * total expenses, which "Счета" takes. Quantities and served of the current tact can be edited.
 */
async function capacitySheet(db: Db, gameId: number) {
  const types = await db.query('select * from asset_type where game_id = $1 order by sort, id', [gameId]);
  const played = await tacts(db, gameId);
  const tables = [];
  for (const t of played) tables.push({ t, cap: await assets.capacityTable(db, gameId, t.id) });
  // Tacts still ahead are a forecast: the last tact's assets, each a tact older (trucks: +1 year).
  const typeBy = new Map(types.map((ty) => [ty.code, ty]));
  const age = (held: Map<string, number>) => {
    const next = new Map<string, number>();
    for (const [code, qty] of held) {
      const to = typeBy.get(code)?.ages_to;
      if (to === 'expire' || !qty) continue;
      const target = to && typeBy.has(to) ? to : code;
      next.set(target, (next.get(target) ?? 0) + qty);
    }
    return next;
  };
  const lastCap = tables.at(-1)?.cap;
  const forecast: { number: number; rows: { title: string; held: Map<string, number> }[] }[] = [];
  if (lastCap) {
    let rows = [...lastCap.rows].sort((x, y) => kindOrder[x.kind] - kindOrder[y.kind] || x.title.localeCompare(y.title, 'ru'))
      .filter((r) => r.assets.some((x) => x.end))
      .map((r) => ({ title: r.title, held: new Map(r.assets.filter((x) => x.end).map((x) => [x.code, x.end])) }));
    for (let number = played.length + 1; number <= PLANNED_TACTS; number++) {
      rows = rows.map((r) => ({ title: r.title, held: age(r.held) }));
      forecast.push({ number, rows });
    }
  }
  // Only assets someone has, had or will have get columns.
  const used = new Set([
    ...tables.flatMap(({ cap }) => cap.rows.flatMap((r) => r.assets.filter((x) => x.end || x.output).map((x) => x.code))),
    ...forecast.flatMap((f) => f.rows.flatMap((r) => [...r.held.keys()])),
  ]);
  const shown = types.filter((ty) => used.has(ty.code));
  type Col = { kind: 'qty' | 'out' | 'cost' | 'power'; ty: any };
  const groups = shown.map((ty) => [
    { kind: 'qty', ty },
    ...(ty.cost_per_output || ty.revenue_per_output ? [{ kind: 'out', ty }] : []),
    ...(ty.opex_per_unit || ty.cost_per_output ? [{ kind: 'cost', ty }] : []),
    ...(ty.capacity_per_unit ? [{ kind: 'power', ty }] : []),
  ] as Col[]);
  const cols = groups.flat();
  const width = 1 + cols.length + 1;
  const totalCol = column(width);
  const letter = (i: number) => column(2 + i); // column of cols[i]

  // Two header rows: the asset over its group, then what each column is.
  const top: Spec[] = [{ ...BLACK, v: 'Компания', wrap: true }];
  const sub: Spec[] = [{ ...BLACK, v: '' }];
  groups.forEach((g, gi) => g.forEach((c, k) => {
    const bg = gi % 2 ? '#fdf3e7' : PEACH;
    // An asset that ages says what it becomes when the tact ends (trucks: 1 year → 2 years…).
    const ages = c.ty.ages_to === 'expire' ? 'исчезает в конце такта' : c.ty.ages_to ? `в конце такта → ${types.find((x) => x.code === c.ty.ages_to)?.title ?? ''}` : '';
    top.push({ v: k === 0 ? c.ty.title : '', bold: true, bg, align: 'LEFT', wrap: g.length === 1, ...(k === 0 && ages ? { note: ages } : {}) });
    const label = c.kind === 'qty' ? 'Кол-во'
      : c.kind === 'out' ? `Обслужено, ${c.ty.capacity_unit || 'ед.'}`
      : c.kind === 'cost' ? `Расходы (${[c.ty.opex_per_unit ? `${c.ty.opex_per_unit} за шт.` : '', c.ty.cost_per_output ? `${c.ty.cost_per_output} за ${c.ty.capacity_unit || 'ед.'}` : ''].filter(Boolean).join(' + ')})`
      : `Мощность (${c.ty.capacity_per_unit} ${c.ty.capacity_unit} на шт.)`;
    sub.push({ v: label, bold: true, wrap: true, size: 9, bg: c.kind === 'cost' ? COST : c.kind === 'power' ? '#b6d7a8' : c.kind === 'qty' ? '#f6b26b' : POWER });
  }));
  top.push({ v: 'Всего расходов', bold: true, bg: '#e06666', fg: '#ffffff', wrap: true });
  sub.push({ v: 'спишется в конце такта', size: 9, bg: '#e06666', fg: '#ffffff', wrap: true });
  const cells: Spec[][] = [top, sub];
  const tall: Record<number, number> = { 0: 44, 1: 48 };
  const ranges = new Map<string, [number, number]>();

  for (const { t, cap } of tables) {
    const open = !t.closed_at; // a finished tact is frozen: no edits
    tall[cells.length] = 32;
    cells.push(pad([{ ...BLACK, v: tactLabel(t), size: 12 }], width, { bg: PEACH }));
    const first = cells.length + 1;
    const rows = [...cap.rows].sort((x, y) => kindOrder[x.kind] - kindOrder[y.kind] || x.title.localeCompare(y.title, 'ru'))
      .filter((r) => r.assets.some((x) => x.end || x.output));
    rows.forEach((r, i) => {
      const n = cells.length + 1;
      const bg = i % 2 ? ALT : '#ffffff';
      const by = new Map(r.assets.map((x) => [x.code, x]));
      const row: Spec[] = [{ v: r.title, bg, bold: true, align: 'LEFT' }];
      const costCells: string[] = [];
      cols.forEach((c, k) => {
        const x = by.get(c.ty.code);
        const qtyAt = letter(cols.findIndex((y) => y.ty === c.ty && y.kind === 'qty'));
        const outIdx = cols.findIndex((y) => y.ty === c.ty && y.kind === 'out');
        if (c.kind === 'qty') {
          row.push({ v: x?.end ?? 0, bg, bold: true, ...(open ? { edit: `qty:${t.id}:${r.accountId}:${c.ty.code}` } : {}) });
        } else if (c.kind === 'out') {
          row.push({ v: x?.output ?? 0, bg: POWER, ...(open && c.ty.capacity_unit ? { edit: `out:${t.id}:${r.accountId}:${c.ty.code}` } : {}) });
        } else if (c.kind === 'cost') {
          const parts = [c.ty.opex_per_unit ? `${qtyAt}${n}*${c.ty.opex_per_unit}` : '', c.ty.cost_per_output && outIdx >= 0 ? `${letter(outIdx)}${n}*${c.ty.cost_per_output}` : ''].filter(Boolean);
          row.push({ v: `=${parts.join('+') || 0}`, bg: COST, fmt: NUM });
          costCells.push(`${letter(k)}${n}`);
        } else {
          row.push({ v: `=${qtyAt}${n}*${c.ty.capacity_per_unit}`, bg: '#d9ead3', fg: '#274e13', bold: true, fmt: NUM });
        }
      });
      row.push({ v: costCells.length ? `=${costCells.join('+')}` : 0, bg: '#e06666', fg: '#ffffff', bold: true, fmt: NUM, ...(r.opexText ? { note: r.opexText } : {}) });
      cells.push(row);
      ranges.set(`${t.id}:${r.accountId}`, [n, n]);
    });
    const last = cells.length;
    const sums: Spec[] = [{ v: 'Итого:', bg: TOTAL, align: 'RIGHT', bold: true }];
    cols.forEach((c, k) => sums.push(c.kind === 'cost' || c.kind === 'power'
      ? { v: last >= first ? `=SUM(${letter(k)}${first}:${letter(k)}${last})` : 0, bg: TOTAL, bold: true, fmt: NUM }
      : { bg: TOTAL }));
    sums.push({ v: last >= first ? `=SUM(${totalCol}${first}:${totalCol}${last})` : 0, bg: TOTAL, bold: true, fmt: NUM });
    cells.push(sums);
    cells.push(pad([], width, { bare: true }));
  }
  // Tacts still ahead: the forecast, in grey and not editable; the real numbers come with the tact.
  for (const f of forecast) {
    tall[cells.length] = 32;
    cells.push(pad([{ ...BLACK, v: `${tactLabel({ number: f.number, closed_at: null, future: true })} — прогноз`, size: 12,
      note: 'Активы последнего такта, машины на год старше. Настоящие цифры появятся, когда такт начнётся' }], width, { bg: PEACH }));
    const first = cells.length + 1;
    f.rows.forEach((r, i) => {
      const n = cells.length + 1;
      const bg = i % 2 ? ALT : '#ffffff';
      const grey = '#6b7280';
      const row: Spec[] = [{ v: r.title, bg, bold: true, align: 'LEFT', fg: grey }];
      const costCells: string[] = [];
      cols.forEach((c, k) => {
        const qtyAt = letter(cols.findIndex((y) => y.ty === c.ty && y.kind === 'qty'));
        if (c.kind === 'qty') row.push({ v: r.held.get(c.ty.code) ?? 0, bg, fg: grey });
        else if (c.kind === 'out') row.push({ v: '', bg: POWER });
        else if (c.kind === 'cost') {
          row.push({ v: c.ty.opex_per_unit ? `=${qtyAt}${n}*${c.ty.opex_per_unit}` : 0, bg: COST, fmt: NUM, fg: grey });
          costCells.push(`${letter(k)}${n}`);
        } else row.push({ v: `=${qtyAt}${n}*${c.ty.capacity_per_unit}`, bg: '#eef7ea', fg: grey, fmt: NUM });
      });
      row.push({ v: costCells.length ? `=${costCells.join('+')}` : 0, bg: '#f4cccc', fg: '#7f1d1d', fmt: NUM, note: 'Прогноз без рейсов: расходы на рейсы появятся, когда их впишут' });
      cells.push(row);
    });
    const last = cells.length;
    const sums: Spec[] = [{ v: 'Итого (прогноз):', bg: TOTAL, align: 'RIGHT', bold: true }];
    cols.forEach((c, k) => sums.push(c.kind === 'cost' || c.kind === 'power'
      ? { v: last >= first ? `=SUM(${letter(k)}${first}:${letter(k)}${last})` : 0, bg: TOTAL, fmt: NUM }
      : { bg: TOTAL }));
    sums.push({ v: last >= first ? `=SUM(${totalCol}${first}:${totalCol}${last})` : 0, bg: TOTAL, fmt: NUM });
    cells.push(sums);
    cells.push(pad([], width, { bare: true }));
  }
  // An asset with a single column gets room for its name.
  const alone = new Set(groups.filter((g) => g.length === 1).map((g) => g[0].ty.code));
  const grid: Grid = { title: 'Мощности', cells, widths: [190, ...cols.map((c) => (c.kind !== 'qty' ? 92 : alone.has(c.ty.code) ? 100 : 64)), 100], frozen: [2, 1], tall };
  return { grid, ranges, costCol: totalCol };
}

/**
 * "Счета", like the organisers' "Деньги": a block per tact, a row per company. B — money at the start
 * (the previous tact's balance), C — income typed in by the game master, D — expenses from "Мощности",
 * E — the balance = B + C − D + every transfer, each written into the next free cell to the right
 * (+ came in, − went out; from whom and what for is in the cell's note).
 */
async function accountsSheet(db: Db, gameId: number, title: string, cap: Awaited<ReturnType<typeof capacitySheet>>): Promise<Grid> {
  const accounts = await companiesOf(db, gameId);
  const moves = await db.query(
    `select t.id, t.tact_id, t.kind, t.amount, t.comment, t.from_account_id, t.to_account_id, fa.title as from_title, ta.title as to_title,
            coalesce(t.idempotency_key like 'post:%', false) as posting
     from transfer t join account fa on fa.id = t.from_account_id join account ta on ta.id = t.to_account_id
     where t.game_id = $1 order by t.id`,
    [gameId],
  );
  const played = await tacts(db, gameId);
  const all = [...played, ...Array.from({ length: Math.max(0, PLANNED_TACTS - played.length) }, (_, i) => ({ id: 0, number: played.length + i + 1, closed_at: null, begun_at: null, future: true }))];
  const capBy = new Map<number, Map<number, any>>();
  for (const t of played) capBy.set(t.id, new Map((await assets.capacityTable(db, gameId, t.id)).rows.map((r) => [r.accountId, r])));
  // Income and expense postings are shown in C and D, not as transfers; start capital is in B.
  const cellsOf = (tactId: number, id: number) => moves
    .filter((m) => m.tact_id === tactId && m.kind !== 'initial' && !m.posting && (m.from_account_id === id || m.to_account_id === id))
    .map((m) => {
      const incoming = m.to_account_id === id;
      return { id: m.id as number, v: incoming ? Number(m.amount) : -Number(m.amount), note: `${incoming ? `от: ${m.from_title}` : `кому: ${m.to_title}`}${m.comment ? ` — ${m.comment}` : ''}` };
    });
  const most = Math.max(0, ...played.flatMap((t) => accounts.map((x) => cellsOf(t.id, x.id).length)));
  const width = 5 + Math.max(most + 5, 20);
  const last = column(width);

  const cells: Spec[][] = [pad([
    { ...BLACK, v: title, wrap: true },
    { v: 'На начало такта', bold: true, wrap: true, bg: PEACH },
    { v: 'Доходы', bold: true, wrap: true, bg: INCOME, note: 'Вписывает игротехник в банке (раздел «Счета»). Начисляется на счёт при завершении такта' },
    { v: 'Расходы', bold: true, wrap: true, bg: COST_SUM, note: 'Из вкладки «Мощности»: количество × расход на 1 шт. Списываются при завершении такта' },
    { v: 'Остаток на счету', bold: true, wrap: true, bg: PEACH, edge: true },
    { v: 'Переводы: + пришло, − ушло (от кого и за что — в примечании). Число в пустой ячейке — начисление (+) или списание (−) игротехника', bold: true, bg: PEACH, align: 'LEFT' },
  ], width, { bg: PEACH })];
  const tall: Record<number, number> = { 0: 64 };
  const prevRow = new Map<number, number>();
  for (const t of all) {
    tall[cells.length] = 36;
    cells.push(pad([{ ...BLACK, v: tactLabel(t), size: 14 }], width, { bg: PEACH }));
    const first = cells.length + 1;
    accounts.forEach((x, i) => {
      const n = cells.length + 1;
      const bg = i % 2 ? ALT : '#ffffff';
      const initial = moves.filter((m) => m.tact_id === t.id && m.kind === 'initial')
        .reduce((sum, m) => sum + (m.to_account_id === x.id ? Number(m.amount) : m.from_account_id === x.id ? -Number(m.amount) : 0), 0);
      const prev = prevRow.get(x.id);
      const r = capBy.get(t.id)?.get(x.id);
      const range = cap.ranges.get(`${t.id}:${x.id}`);
      const cost: Cell = range ? `='Мощности'!${cap.costCol}${range[0]}` : r?.opex ?? '';
      const moved = cellsOf(t.id, x.id);
      // The current tact can be edited right in the sheet: income, a transfer's amount, a new number to the right.
      // A finished tact is frozen, so its cells take no edits.
      const played = !('future' in t) && !t.closed_at;
      cells.push(pad([
        { v: x.title, bg },
        { v: prev ? `=E${prev}${initial ? `+${initial}` : ''}` : initial, bg, bold: true, fmt: NUM },
        { v: r ? r.revenue : '', bg: INCOME, fmt: NUM, ...(r?.revenueText ? { note: r.revenueText } : {}), ...(r && played ? { edit: `earned:${t.id}:${x.id}:${r.revenue - r.earned}` } : {}) },
        { v: cost, bg: COST, fmt: NUM, ...(r?.opexText ? { note: r.opexText } : {}) },
        { v: `=B${n}+C${n}-D${n}+SUM(F${n}:${last}${n})`, bg, bold: true, fmt: NUM, edge: true },
        ...moved.map((m) => ({ v: m.v, note: m.note, bg, fmt: SIGNED, fg: m.v < 0 ? '#b91c1c' : undefined, ...(played ? { edit: `move:${m.id}` } : {}) })),
      ], width, { bg, fmt: SIGNED, ...(played ? { edit: `new:${t.id}:${x.id}` } : {}) }));
      prevRow.set(x.id, n);
    });
    const end = cells.length;
    cells.push(pad([], width, { bare: true }));
    const sum = (c: string): Spec => ({ v: `=SUM(${c}${first}:${c}${end})`, bg: TOTAL, bold: true, fmt: NUM });
    cells.push(pad([{ v: 'Сумма у всех:', bg: TOTAL, align: 'RIGHT' }, sum('B'), sum('C'), sum('D'), { ...sum('E'), edge: true }], width, { bg: TOTAL }));
    cells.push(pad([], width, { bare: true }));
  }
  return { title: 'Счета', cells, widths: [230, 84, 84, 84, 90, ...Array(width - 5).fill(56)], frozen: [1, 5], tall, first: true };
}

/**
 * "Переводы", like the organisers' "База": accepted transfers and the ones the bank refused,
 * with the reason, in the order they happened. Column A is the status.
 */
async function actionsSheet(db: Db, gameId: number): Promise<Grid> {
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
  const closed = new Set((await tacts(db, gameId)).filter((t) => t.closed_at).map((t) => t.number));
  const all = [...done.map((t) => ({ ...t, status: 'Принято', reason: '' })), ...refused.map((t) => ({ ...t, status: 'Отклонено' }))]
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  // Tact, time, amount, who and whom, what, the comment; status and reason last.
  const head = ['Такт', 'Время', 'Сумма', 'От кого', 'Кому', 'Действие', 'Комментарий', 'Кто сделал', 'Статус', 'Причина'];
  const clock = (d: string | Date) =>
    new Date(d).toLocaleTimeString('ru-RU', { timeZone: process.env.TZ_DISPLAY ?? 'Europe/Moscow', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return {
    title: 'Переводы',
    widths: [48, 80, 80, 170, 170, 120, 320, 220, 100, 240],
    frozen: [1, 0],
    tall: { 0: 32 },
    cells: [
      head.map((v) => ({ v, bold: true, size: 11, bg: '#efefef' })),
      ...all.map((t): Spec[] => {
        const ok = t.status === 'Принято';
        const editable = ok && !closed.has(t.tact); // transfers of a finished tact are frozen
        const bg = ok ? '#ffffff' : '#fdf2f2';
        return [
          { v: t.tact ?? '', bg }, { v: clock(t.created_at), bg },
          { v: t.amount === null ? '' : Number(t.amount), fmt: NUM, bold: true, bg, ...(editable ? { edit: `amount:${t.id}` } : {}) },
          { v: t.from_title, align: 'LEFT', bg }, { v: t.to_title, align: 'LEFT', bg }, { v: KIND_LABEL[t.kind] ?? t.kind, bg },
          { v: t.comment, align: 'LEFT', bg, ...(editable ? { edit: `comment:${t.id}` } : {}) },
          { v: t.initiator.trim() || 'Банк', align: 'LEFT', bg },
          { v: t.status, bold: true, bg: ok ? '#d9ead3' : '#f4cccc', fg: ok ? '#274e13' : '#990000' },
          { v: t.reason, align: 'LEFT', bg },
        ];
      }),
    ],
  };
}

/** The sheets of a game: "Счета", "Переводы", "Мощности". Exported for tests: no Google calls here. */
export async function buildSheets(db: Db, gameId: number): Promise<Grid[]> {
  const log = await actionsSheet(db, gameId);
  if (!(await tacts(db, gameId)).length) return [log];
  const cap = await capacitySheet(db, gameId);
  return [await accountsSheet(db, gameId, (await gameNames(db, gameId)).title, cap), log, cap.grid];
}

/** Tabs the bank used to write; they are removed so the file holds only the three sheets above. */
const OBSOLETE = ['Деньги', 'Сводка', 'Выручка и OPEX', 'Журнал активов', 'Расчётка'];

const API = 'https://sheets.googleapis.com/v4/spreadsheets';

const rgb = (hex: string) => ({ red: parseInt(hex.slice(1, 3), 16) / 255, green: parseInt(hex.slice(3, 5), 16) / 255, blue: parseInt(hex.slice(5, 7), 16) / 255 });
const thin = { style: 'SOLID', color: rgb('#c7c7c7') };
const bold = { style: 'SOLID_MEDIUM', color: rgb('#000000') };

/** Whole-sheet rewrite: size, frozen panes, values with formulas, colours, notes, widths. */
export function gridRequests(sheetId: number, g: Grid): object[] {
  const width = Math.max(g.widths.length, ...g.cells.map((r) => r.length));
  const rows = g.cells.map((r) => ({
    values: Array.from({ length: width }, (_, c) => {
      const x = r[c] ?? { bare: true };
      return {
        ...(x.v === undefined || x.v === '' ? {} : {
          userEnteredValue: typeof x.v === 'number' ? { numberValue: x.v } : x.v.startsWith('=') ? { formulaValue: x.v } : { stringValue: x.v },
        }),
        ...(x.note ? { note: x.note } : {}),
        userEnteredFormat: {
          backgroundColor: rgb(x.bg ?? '#ffffff'),
          horizontalAlignment: x.align ?? 'CENTER',
          verticalAlignment: 'MIDDLE',
          wrapStrategy: x.wrap ? 'WRAP' : 'OVERFLOW_CELL',
          textFormat: { bold: !!x.bold, fontSize: x.size ?? 10, foregroundColor: rgb(x.fg ?? '#000000') },
          ...(x.fmt ? { numberFormat: { type: 'NUMBER', pattern: x.fmt } } : {}),
          ...(x.bare ? {} : { borders: { top: thin, bottom: thin, left: thin, right: x.edge ? bold : thin } }),
        },
      };
    }),
  }));
  const size = (dimension: 'COLUMNS' | 'ROWS', start: number, end: number, pixelSize: number) =>
    ({ updateDimensionProperties: { range: { sheetId, dimension, startIndex: start, endIndex: end }, properties: { pixelSize }, fields: 'pixelSize' } });
  return [
    { updateSheetProperties: {
      properties: { sheetId, gridProperties: { rowCount: Math.max(g.cells.length + 50, 200), columnCount: width, frozenRowCount: g.frozen[0], frozenColumnCount: g.frozen[1] } },
      fields: 'gridProperties(rowCount,columnCount,frozenRowCount,frozenColumnCount)',
    } },
    { updateCells: { range: { sheetId }, fields: '*' } },
    { updateCells: { start: { sheetId, rowIndex: 0, columnIndex: 0 }, rows, fields: 'userEnteredValue,userEnteredFormat,note' } },
    ...g.widths.map((w, c) => size('COLUMNS', c, c + 1, w)),
    ...Object.entries(g.tall ?? {}).map(([i, h]) => size('ROWS', Number(i), Number(i) + 1, h)),
  ];
}

/** Writes the sheets into one spreadsheet; returns the tab ids (remembered so Google is asked only when a tab is missing). */
async function writeSheet(db: Db, api: JWT, sheetId: string, known: Record<string, number>, sheets: Grid[]) {
  let gids = known;
  if (!sheets.every((s) => s.title in gids)) {
    const meta = await api.request<{ sheets: { properties: { title: string; sheetId: number } }[] }>({
      url: `${API}/${sheetId}?fields=sheets.properties(title,sheetId)`,
    });
    gids = Object.fromEntries(meta.data.sheets.map((x) => [x.properties.title, x.properties.sheetId]));
    const missing = sheets.filter((x) => !(x.title in gids));
    if (missing.length) {
      const added = await api.request<{ replies: { addSheet?: { properties: { title: string; sheetId: number } } }[] }>({
        url: `${API}/${sheetId}:batchUpdate`, method: 'POST',
        // The account sheet goes first, the way the organisers' own file opens.
        data: { requests: [
          ...missing.map((x) => ({ addSheet: { properties: { title: x.title, ...(x.first ? { index: 0 } : {}) } } })),
          ...OBSOLETE.filter((t) => t in gids).map((t) => ({ deleteSheet: { sheetId: gids[t] } })),
        ] },
      });
      for (const r of added.data.replies) if (r.addSheet) gids[r.addSheet.properties.title] = r.addSheet.properties.sheetId;
      for (const t of OBSOLETE) delete gids[t];
    }
  }
  await api.request({
    url: `${API}/${sheetId}:batchUpdate`, method: 'POST',
    data: { requests: sheets.flatMap((x) => gridRequests(gids[x.title], x)) },
  });
  for (const g of sheets) {
    await db.query(
      `insert into sheet_state (sheet_id, title, cells) values ($1, $2, $3)
       on conflict (sheet_id, title) do update set cells = excluded.cells`,
      [sheetId, g.title, JSON.stringify(stateOf(g))],
    );
  }
  return gids;
}

// ---------- Edits made right in Google come back to the bank ----------

type State = Record<string, [string, Cell]>;

/** Editable cells of a sheet as the bank writes them: "row:col" → [meaning, value]. */
export function stateOf(g: Grid): State {
  const out: State = {};
  g.cells.forEach((row, r) => row.forEach((c, k) => { if (c.edit) out[`${r}:${k}`] = [c.edit, c.v ?? '']; }));
  return out;
}

/** '' for an empty cell, a number for a number (also typed as text), otherwise the text. */
const norm = (v: unknown): Cell => {
  if (v === undefined || v === null || String(v).trim() === '') return '';
  if (typeof v === 'number') return v;
  const n = Number(String(v).trim().replace(/\s/g, '').replace(',', '.').replace('−', '-'));
  return Number.isFinite(n) ? n : String(v).trim();
};

/** The cells a game master changed in one spreadsheet since the bank last wrote it. */
export async function readEdits(db: Db, api: JWT, sheetId: string) {
  const states = await db.query('select title, cells from sheet_state where sheet_id = $1', [sheetId]);
  if (!states.length) return [];
  const query = states.map((x) => `ranges=${encodeURIComponent(`'${x.title}'`)}`).join('&');
  const r = await api.request<{ valueRanges: { values?: unknown[][] }[] }>({
    url: `${API}/${sheetId}/values:batchGet?valueRenderOption=UNFORMATTED_VALUE&${query}`,
  });
  const edits: { title: string; pos: string; key: string; was: Cell; now: Cell }[] = [];
  states.forEach((x, i) => {
    const values = r.data.valueRanges[i]?.values ?? [];
    for (const [pos, [key, was]] of Object.entries(x.cells as State)) {
      const [row, col] = pos.split(':').map(Number);
      const now = norm(values[row]?.[col]);
      if (now !== norm(was)) edits.push({ title: x.title, pos, key, was: norm(was), now });
    }
  });
  return edits;
}

const GOOGLE = 'Изменено в Google-таблице';

/** Applies one edited cell to the bank; what the cell means is in its key (see the sheet builders). */
export async function applyEdit(db: Db, gameId: number, key: string, was: Cell, now: Cell) {
  const [kind, ...p] = key.split(':');
  const ids = p.map(Number);
  // A finished tact is frozen: an edit there is ignored and the next write restores the cell.
  const tactOfKey = ['earned', 'new', 'qty', 'out'].includes(kind) ? ids[0]
    : (await db.query('select tact_id from transfer where id = $1', [ids[0]]))[0]?.tact_id;
  if (tactOfKey && (await db.query('select closed_at from tact where id = $1', [tactOfKey]))[0]?.closed_at) return;
  const n = now === '' ? 0 : typeof now === 'number' ? Math.round(now) : NaN;
  if (Number.isNaN(n) && kind !== 'comment') return; // text where a number belongs: the next write restores it
  switch (kind) {
    case 'earned': // "Счета" C: income of the tact = typed value minus what capacities bring
      return assets.setOutput(db, gameId, { tactId: ids[0], accountId: ids[1], code: assets.EARNED, amount: Math.max(0, n - ids[2]) });
    case 'move': // "Счета": a transfer's cell; emptied = the transfer is removed
      return n === 0 ? deleteTransfer(db, gameId, ids[0]) : editTransfer(db, gameId, ids[0], { amount: Math.abs(n) });
    case 'new': { // "Счета": a number typed into an empty cell = the game master credits (+) or debits (−)
      if (!n) return;
      const host = await hostAccountId(db, gameId);
      return transfer(db, {
        gameId, kind: n > 0 ? 'host_credit' : 'host_debit', fromAccountId: n > 0 ? host : ids[1], toAccountId: n > 0 ? ids[1] : host,
        amount: Math.abs(n), comment: 'Вписано в Google-таблице', allowNegative: true,
      });
    }
    case 'qty': { // "Мощности": quantity of an asset in that tact
      const delta = Math.max(0, n) - Number(was || 0);
      if (!delta) return;
      return assets.addLedger(db, gameId, null, { accountId: ids[1], code: p[2], delta, comment: GOOGLE, tactId: ids[0] });
    }
    case 'out': // "Мощности": hours or trips served
      return assets.setOutput(db, gameId, { tactId: ids[0], accountId: ids[1], code: p[2], amount: Math.max(0, n) });
    case 'amount': // "Переводы": the amount of a transfer
      return n > 0 ? editTransfer(db, gameId, ids[0], { amount: n }) : undefined;
    case 'comment': // "Переводы": the comment
      return editTransfer(db, gameId, ids[0], { comment: String(now) });
  }
}

const pulling = new Map<number, Promise<number>>();

/**
 * Reads every sheet of the game and applies what was changed there — once: one read runs at a time
 * per game, and an applied cell is marked as seen at once, so a second read never applies it again.
 */
export function pullEdits(db: Db, gameId: number): Promise<number> {
  const prev = pulling.get(gameId) ?? Promise.resolve(0);
  const next = prev.catch(() => 0).then(() => pullOnce(db, gameId));
  pulling.set(gameId, next);
  next.finally(() => { if (pulling.get(gameId) === next) pulling.delete(gameId); }).catch(() => {});
  return next;
}

async function pullOnce(db: Db, gameId: number) {
  if (!credentials()) return 0;
  const [g] = await db.query('select sheet_id from game where id = $1', [gameId]);
  const copies = await db.query('select sheet_id from staff_sheet where game_id = $1', [gameId]);
  const api = google();
  let applied = 0;
  for (const sheetId of [g?.sheet_id, ...copies.map((c) => c.sheet_id)].filter(Boolean)) {
    let edits: Awaited<ReturnType<typeof readEdits>> = [];
    try { edits = await readEdits(db, api, sheetId); } catch (e: any) { console.error('sheets read', e?.response?.data?.error?.message ?? e); continue; }
    for (const e of edits) {
      // Seen before applying: whatever happens, this value is not taken a second time.
      await db.query(
        `update sheet_state set cells = jsonb_set(cells, array[$3::text], jsonb_build_array($4::text, $5::jsonb))
         where sheet_id = $1 and title = $2`,
        [sheetId, e.title, e.pos, e.key, JSON.stringify(e.now)],
      );
      try {
        await applyEdit(db, gameId, e.key, e.was, e.now);
        applied++;
      } catch (err: any) {
        console.error('sheets edit', e.key, err?.message ?? err);
      }
    }
  }
  if (applied) editListener?.(gameId);
  return applied;
}

let editListener: ((gameId: number) => void) | null = null;
/** The app refreshes screens when edits from Google were applied. */
export function onSheetEdits(fn: (gameId: number) => void) { editListener = fn; }

/**
 * Looks for edits made in Google every `everyMs`, for running games with a sheet. Only reads; when
 * something changed, the bank applies it and rewrites the sheets through the usual sync.
 */
export function startPolling(db: Db, everyMs = 20_000) {
  if (!credentials()) return () => {};
  // Edits are found by comparing with what the bank wrote: after a restart, write every sheet once.
  db.query(
    `select id from game g where kind = 'branch' and status = 'active'
       and (sheet_id <> '' or exists (select 1 from staff_sheet c where c.game_id = g.id))`,
  ).then((list) => list.forEach(({ id }, i) => scheduleSync(db, id, 5_000 + i * 2_000))).catch(() => {});
  const timer = setInterval(async () => {
    const list = await db.query(
      `select id from game g where kind = 'branch' and status = 'active'
         and (sheet_id <> '' or exists (select 1 from staff_sheet c where c.game_id = g.id))`,
    ).catch(() => []);
    for (const { id } of list) {
      if (running.has(id) || timers.has(id)) continue;
      running.add(id);
      const applied = await pullEdits(db, id).catch(() => 0);
      running.delete(id);
      if (applied) scheduleSync(db, id, 0);
    }
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

const failure = (e: any) => {
  if (!(e instanceof AppError)) console.error('sheets sync', e?.response?.data ?? e);
  return e instanceof AppError ? e.message
    : e?.response?.status === 403 || e?.response?.status === 404 ? `Нет доступа к таблице: откройте её для ${serviceEmail()} с правом редактирования`
    : 'Не удалось записать в Google-таблицу';
};

/**
 * Writes the game into its main sheet (the admin's) and into every game master's own copy.
 * Each sheet keeps its own error; the main sheet's error is thrown.
 */
export async function syncNow(db: Db, gameId: number) {
  const [g] = await db.query('select sheet_id, sheet_gids from game where id = $1', [gameId]);
  const copies = await db.query('select staff_id, sheet_id, sheet_gids from staff_sheet where game_id = $1', [gameId]);
  if (!g?.sheet_id && !copies.length) throw new AppError('Google-таблица не подключена');
  let api: JWT;
  let sheets: Grid[];
  try {
    api = google();
    // Edits made in Google since the last write go into the bank first, so the write never loses them.
    await pullEdits(db, gameId).catch((e) => console.error('sheets pull', e?.message ?? e));
    sheets = await buildSheets(db, gameId);
  } catch (e: any) {
    throw new AppError(failure(e), 502);
  }
  let mainError: string | null = null;
  if (g.sheet_id) {
    try {
      const gids = await writeSheet(db, api, g.sheet_id, g.sheet_gids ?? {}, sheets);
      await db.query("update game set sheet_gids = $2, sheet_synced_at = now(), sheet_error = '' where id = $1", [gameId, JSON.stringify(gids)]);
    } catch (e: any) {
      mainError = failure(e);
      // A tab deleted by hand makes the remembered ids stale: forget them, the next sync re-reads.
      await db.query(`update game set sheet_error = $2${e?.response?.status === 400 ? ", sheet_gids = '{}'" : ''} where id = $1`, [gameId, mainError]);
    }
  }
  for (const c of copies) {
    try {
      const gids = await writeSheet(db, api, c.sheet_id, c.sheet_gids ?? {}, sheets);
      await db.query("update staff_sheet set sheet_gids = $3, synced_at = now(), error = '' where game_id = $1 and staff_id = $2", [gameId, c.staff_id, JSON.stringify(gids)]);
    } catch (e: any) {
      await db.query(`update staff_sheet set error = $3${e?.response?.status === 400 ? ", sheet_gids = '{}'" : ''} where game_id = $1 and staff_id = $2`,
        [gameId, c.staff_id, failure(e)]);
    }
  }
  if (mainError) throw new AppError(mainError, 502);
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
    const [g] = await db.query(
      "select sheet_id <> '' or exists (select 1 from staff_sheet where game_id = $1) as mirrored from game where id = $1", [gameId],
    ).catch(() => [null]);
    if (!g?.mirrored) return;
    running.add(gameId);
    await syncNow(db, gameId).catch(() => {});
    running.delete(gameId);
    if (again.delete(gameId)) scheduleSync(db, gameId, delayMs);
  }, delayMs));
}

/**
 * One tab as the assistant reads it: the cells the bank writes (formulas and notes included) and,
 * when the game has a sheet, the values Google computed. Rows and columns are 1-based like A1.
 */
export async function readSheet(db: Db, gameId: number, title: string, fromRow = 1, toRow = fromRow + 149) {
  const grid = (await buildSheets(db, gameId)).find((g) => g.title === title);
  if (!grid) return { error: `Листа «${title}» пока нет: он появляется, когда игра запущена` };
  const [g] = await db.query('select sheet_id, sheet_gids from game where id = $1', [gameId]);
  let live: Cell[][] | null = null;
  if (g?.sheet_id && credentials()) {
    try {
      const r = await google().request<{ values?: Cell[][] }>({
        url: `${API}/${g.sheet_id}/values/${encodeURIComponent(`'${title}'`)}?valueRenderOption=UNFORMATTED_VALUE`,
      });
      live = r.data.values ?? [];
    } catch {
      live = null;
    }
  }
  const rows = [];
  for (let n = Math.max(1, fromRow); n <= Math.min(toRow, grid.cells.length); n++) {
    const cells: Record<string, unknown> = {};
    const notes: Record<string, string> = {};
    grid.cells[n - 1].forEach((c, i) => {
      const col = column(i + 1);
      const formula = typeof c.v === 'string' && c.v.startsWith('=');
      const value = formula ? live?.[n - 1]?.[i] : c.v;
      if (formula) cells[col] = { formula: c.v, ...(value !== undefined && value !== '' ? { value } : {}) };
      else if (value !== undefined && value !== '') cells[col] = value;
      if (c.note) notes[col] = c.note;
    });
    if (Object.keys(cells).length) rows.push({ row: n, cells, ...(Object.keys(notes).length ? { notes } : {}) });
  }
  return {
    sheet: title,
    total_rows: grid.cells.length,
    rows,
    google_values: !!live,
    url: g?.sheet_id ? `https://docs.google.com/spreadsheets/d/${g.sheet_id}/edit#gid=${g.sheet_gids?.[title] ?? 0}` : null,
  };
}

import { AppError, Db, Tx } from './db.js';
import { hashSecret, isFourDigits, newRoleCode, verifySecret } from './security.js';
import { hostAccountId, transferTx } from './transfers.js';

export type Entity = 'role' | 'asset_type' | 'start_account' | 'price_item';
// Order matters when copying a game: start accounts reference roles and asset codes.
export const ENTITIES: Entity[] = ['role', 'asset_type', 'start_account', 'price_item'];

const FIELDS: Record<Entity, string[]> = {
  role: ['title', 'description', 'start_balance', 'preset_first_name', 'preset_last_name'],
  asset_type: ['title', 'unit', 'capacity_per_unit', 'capacity_unit', 'opex_per_unit', 'income_per_unit',
    'revenue_per_output', 'cost_per_output', 'ages_to', 'sort'],
  start_account: ['title', 'owner_role_id', 'coowner_role_ids', 'start_balance', 'pin', 'assets'],
  price_item: ['title', 'price', 'active', 'asset_code', 'asset_qty'],
};

const nonNegInt = (v: unknown, label: string) => {
  const n = Number(v ?? 0);
  if (!Number.isSafeInteger(n) || n < 0) throw new AppError(`${label}: нужно целое число ≥ 0`);
  return n;
};
const text = (v: unknown, max = 200) => String(v ?? '').trim().slice(0, max);

/** Validates and normalizes config fields. Partial: only keys present in `data` are returned. */
async function clean(tx: Tx, entity: Entity, gameId: number, data: any, partial: boolean) {
  const out: Record<string, unknown> = {};
  for (const f of FIELDS[entity]) {
    if (!(f in data)) continue;
    const v = data[f];
    switch (f) {
      case 'title':
        out.title = text(v);
        if (!out.title) throw new AppError('Укажите название');
        break;
      case 'description':
        out.description = text(v, 2000);
        break;
      case 'preset_first_name':
      case 'preset_last_name':
        out[f] = text(v, 100);
        break;
      case 'start_balance':
        out.start_balance = nonNegInt(v, 'Стартовый баланс');
        break;
      case 'price':
        out.price = nonNegInt(v, 'Цена');
        if (out.price === 0) throw new AppError('Цена должна быть больше нуля');
        break;
      case 'active':
        out.active = Boolean(v);
        break;
      case 'pin':
        out.pin = text(v, 4);
        if (out.pin && !isFourDigits(out.pin)) throw new AppError('PIN — ровно 4 цифры');
        break;
      case 'owner_role_id':
        out.owner_role_id = v ? Number(v) : null;
        break;
      case 'coowner_role_ids':
        out.coowner_role_ids = Array.isArray(v) ? [...new Set(v.map(Number))] : [];
        break;
      case 'unit':
        out.unit = text(v, 20) || 'шт.';
        break;
      case 'capacity_unit':
        out.capacity_unit = text(v, 30);
        break;
      case 'capacity_per_unit':
      case 'opex_per_unit':
      case 'income_per_unit':
      case 'revenue_per_output':
      case 'cost_per_output':
      case 'asset_qty':
        out[f] = nonNegInt(v, 'Число');
        break;
      case 'sort':
        out.sort = Number.isSafeInteger(Number(v)) ? Number(v) : 0;
        break;
      case 'ages_to':
      case 'asset_code':
        out[f] = text(v, 40);
        break;
      case 'assets': {
        const obj: Record<string, number> = {};
        for (const [code, qty] of Object.entries(v && typeof v === 'object' ? v : {})) {
          const n = nonNegInt(qty, 'Количество актива');
          if (n > 0) obj[code] = n;
        }
        out.assets = obj;
        break;
      }
    }
  }
  if (!partial && !('title' in out)) throw new AppError('Укажите название');
  if (entity === 'price_item' && !partial && !('price' in out)) throw new AppError('Укажите цену');
  const codes = [
    ...Object.keys((out.assets as object) ?? {}),
    ...(out.asset_code ? [out.asset_code] : []),
    ...(out.ages_to && out.ages_to !== 'expire' ? [out.ages_to] : []),
  ] as string[];
  if (codes.length) {
    const found = await tx.query('select code from asset_type where game_id = $1 and code = any($2::text[])', [gameId, codes]);
    if (found.length !== new Set(codes).size) throw new AppError('Такого актива нет в игре');
  }
  if (entity === 'start_account') {
    const ids = [out.owner_role_id, ...((out.coowner_role_ids as number[]) ?? [])].filter(Boolean) as number[];
    if (ids.length) {
      const found = await tx.query('select id from role where game_id = $1 and id = any($2::int[])', [gameId, ids]);
      if (found.length !== new Set(ids).size) throw new AppError('Роль не из этой игры');
    }
  }
  return out;
}

async function getGame(tx: Tx, gameId: number) {
  const [g] = await tx.query('select * from game where id = $1', [gameId]);
  if (!g) throw new AppError('Игра не найдена', 404);
  return g;
}

/** Maps root role ids to the branch's own role ids (for start_account owner/coowner refs). */
async function roleMap(tx: Tx, branchId: number) {
  const rows = await tx.query('select id, source_id from role where game_id = $1 and source_id is not null', [branchId]);
  return new Map<number, number>(rows.map((r) => [r.source_id, r.id]));
}

function mapRoleRefs(values: Record<string, unknown>, map: Map<number, number>) {
  const v = { ...values };
  if ('owner_role_id' in v) v.owner_role_id = v.owner_role_id ? map.get(v.owner_role_id as number) ?? null : null;
  if ('coowner_role_ids' in v) {
    v.coowner_role_ids = (v.coowner_role_ids as number[]).map((id) => map.get(id)).filter(Boolean);
  }
  return v;
}

/** jsonb columns get JSON text; int[] columns stay arrays. */
const sqlValue = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : v);

async function newAssetCode(tx: Tx, gameId: number) {
  for (;;) {
    const code = `a${Math.random().toString(36).slice(2, 8)}`;
    const [taken] = await tx.query('select 1 from asset_type where game_id = $1 and code = $2', [gameId, code]);
    if (!taken) return code;
  }
}

async function insertRow(tx: Tx, entity: Entity, gameId: number, values: Record<string, unknown>, sourceId: number | null) {
  const v: Record<string, unknown> = { ...values, game_id: gameId, source_id: sourceId };
  if (entity === 'role') v.code = newRoleCode();
  if (entity === 'asset_type' && !v.code) v.code = await newAssetCode(tx, gameId);
  const cols = Object.keys(v);
  const [row] = await tx.query(
    `insert into ${entity} (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')}) returning *`,
    cols.map((c) => sqlValue(v[c])),
  );
  return row;
}

async function updateById(tx: Tx, entity: Entity, id: number, values: Record<string, unknown>) {
  const cols = Object.keys(values);
  if (!cols.length) return;
  await tx.query(
    `update ${entity} set ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} where id = $1`,
    [id, ...cols.map((c) => sqlValue(values[c]))],
  );
}

export async function createRootGame(db: Db, title: string) {
  const t = text(title);
  if (!t) throw new AppError('Укажите название игры');
  const [g] = await db.query("insert into game (title, kind) values ($1, 'root') returning *", [t]);
  return g;
}

/** A branch is a full copy of the root config; rows keep source_id so later root edits flow down. */
export async function createBranch(db: Db, rootId: number, title: string, staffIds: number[]) {
  return db.transaction(async (tx) => {
    const root = await getGame(tx, rootId);
    if (root.kind !== 'root') throw new AppError('Ответвление делается от корневой игры');
    const [b] = await tx.query(
      "insert into game (title, kind, parent_id, rules) values ($1, 'branch', $2, $3) returning *",
      [text(title) || root.title, rootId, root.rules],
    );
    for (const entity of ENTITIES) {
      const map = entity === 'start_account' ? await roleMap(tx, b.id) : null;
      for (const r of await tx.query(`select * from ${entity} where game_id = $1 order by id`, [rootId])) {
        const values: Record<string, unknown> = Object.fromEntries(FIELDS[entity].map((f) => [f, r[f]]));
        if (entity === 'asset_type') values.code = r.code;
        await insertRow(tx, entity, b.id, map ? mapRoleRefs(values, map) : values, r.id);
      }
    }
    for (const sid of staffIds) {
      await tx.query('insert into game_staff (game_id, staff_id) values ($1, $2) on conflict do nothing', [b.id, sid]);
    }
    return b;
  });
}

export async function createRow(db: Db, entity: Entity, gameId: number, data: any) {
  return db.transaction(async (tx) => {
    const game = await getGame(tx, gameId);
    const values = await clean(tx, entity, gameId, data, false);
    const row = await insertRow(tx, entity, gameId, values, null);
    const targets = game.kind === 'root'
      ? await tx.query("select id, status from game where parent_id = $1 and kind = 'branch'", [gameId])
      : [];
    if (game.kind === 'branch') targets.push(game);
    for (const b of targets) {
      let copy = row;
      if (b.id !== gameId) {
        const v = entity === 'start_account' ? mapRoleRefs(values, await roleMap(tx, b.id))
          : entity === 'asset_type' ? { ...values, code: row.code } : values;
        copy = await insertRow(tx, entity, b.id, v, row.id);
      }
      if (entity === 'start_account' && b.status === 'active') await openStartAccount(tx, b.id, copy);
    }
    return row;
  });
}

export async function updateRow(db: Db, entity: Entity, id: number, data: any) {
  return db.transaction(async (tx) => {
    const [row] = await tx.query(`select * from ${entity} where id = $1`, [id]);
    if (!row) throw new AppError('Не найдено', 404);
    const game = await getGame(tx, row.game_id);
    const values = await clean(tx, entity, row.game_id, data, true);
    if (game.kind === 'branch') {
      await updateById(tx, entity, id, { ...values, local_modified: row.source_id !== null });
    } else {
      await updateById(tx, entity, id, values);
      const copies = await tx.query(
        `select id, game_id from ${entity} where source_id = $1 and not local_modified`,
        [id],
      );
      for (const c of copies) {
        const v = entity === 'start_account' ? mapRoleRefs(values, await roleMap(tx, c.game_id)) : values;
        await updateById(tx, entity, c.id, v);
      }
    }
    const [updated] = await tx.query(`select * from ${entity} where id = $1`, [id]);
    return updated;
  });
}

export async function deleteRow(db: Db, entity: Entity, id: number) {
  return db.transaction(async (tx) => {
    const [row] = await tx.query(`select * from ${entity} where id = $1`, [id]);
    if (!row) throw new AppError('Не найдено', 404);
    if (entity === 'role') {
      const [p] = await tx.query('select 1 from player where role_id = $1', [id]);
      if (p) throw new AppError('Роль занята игроком — сначала сбросьте привязку');
    }
    // Untouched, unused copies in branches go with the root row; the rest stay as branch-local rows.
    const copies = await tx.query(
      `select c.id from ${entity} c where c.source_id = $1 and not c.local_modified
         ${entity === 'role' ? 'and not exists (select 1 from player p where p.role_id = c.id)' : ''}`,
      [id],
    );
    for (const c of copies) await tx.query(`delete from ${entity} where id = $1`, [c.id]);
    await tx.query(`delete from ${entity} where id = $1`, [id]);
  });
}

/** Root rules flow to branches that have not written their own version. */
export async function updateRules(db: Db, gameId: number, rules: unknown) {
  const value = text(rules, 50_000);
  return db.transaction(async (tx) => {
    const g = await getGame(tx, gameId);
    if (g.kind === 'branch') {
      await tx.query('update game set rules = $2, rules_local_modified = true where id = $1', [gameId, value]);
    } else {
      await tx.query('update game set rules = $2 where id = $1', [gameId, value]);
      await tx.query('update game set rules = $2 where parent_id = $1 and not rules_local_modified', [gameId, value]);
    }
  });
}

export async function regenerateCode(db: Db, roleId: number) {
  const [r] = await db.query('update role set code = $2 where id = $1 returning code', [roleId, newRoleCode()]);
  if (!r) throw new AppError('Роль не найдена', 404);
  return r.code as string;
}

async function openStartAccount(tx: Tx, gameId: number, sa: any) {
  const [acc] = await tx.query(
    `insert into account (game_id, kind, title, pin_hash, start_account_id)
     values ($1, 'legal', $2, $3, $4) returning id`,
    [gameId, sa.title, sa.pin ? hashSecret(sa.pin) : null, sa.id],
  );
  if (sa.owner_role_id) {
    await tx.query("insert into account_member (account_id, role_id, member) values ($1, $2, 'owner')", [acc.id, sa.owner_role_id]);
  }
  for (const rid of sa.coowner_role_ids ?? []) {
    if (rid === sa.owner_role_id) continue;
    await tx.query(
      "insert into account_member (account_id, role_id, member) values ($1, $2, 'coowner') on conflict do nothing",
      [acc.id, rid],
    );
  }
  await tx.query("insert into account_event (account_id, type, actor) values ($1, 'created', 'ведущий')", [acc.id]);
  const [tact] = await tx.query('select id from tact where game_id = $1 and closed_at is null', [gameId]);
  for (const [code, qty] of Object.entries((sa.assets ?? {}) as Record<string, number>)) {
    if (qty > 0) {
      await tx.query(
        "insert into asset_ledger (game_id, account_id, asset_code, delta, tact_id, reason, comment) values ($1, $2, $3, $4, $5, 'start', 'Стартовые активы')",
        [gameId, acc.id, code, qty, tact?.id ?? null],
      );
    }
  }
  if (sa.start_balance > 0) {
    await transferTx(tx, {
      gameId, kind: 'initial', fromAccountId: await hostAccountId(tx, gameId), toAccountId: acc.id,
      amount: sa.start_balance, comment: 'Стартовый баланс',
    });
  }
}

/** Opens the game: game-master account, tact 1, start legal entities with their balances. */
export async function launchBranch(db: Db, gameId: number) {
  return db.transaction(async (tx) => {
    const [g] = await tx.query('select * from game where id = $1 for update', [gameId]);
    if (!g || g.kind !== 'branch') throw new AppError('Запускается только ответвление игры');
    if (g.status !== 'draft') throw new AppError('Игра уже запущена');
    await tx.query("insert into account (game_id, kind, title) values ($1, 'host', 'Игротехник')", [gameId]);
    await tx.query('insert into tact (game_id, number) values ($1, 1)', [gameId]);
    for (const sa of await tx.query('select * from start_account where game_id = $1 order by id', [gameId])) {
      await openStartAccount(tx, gameId, sa);
    }
    await tx.query("update game set status = 'active' where id = $1", [gameId]);
  });
}

/**
 * First entry claims the role (name + code). Re-entering the code later (new device, Telegram)
 * returns the same player. The role's individual account is created once and survives a reset.
 */
export async function joinRole(
  db: Db,
  body: { gameId: number; roleId: number; firstName?: string; lastName?: string; code: string },
) {
  return db.transaction(async (tx) => {
    const [g] = await tx.query("select * from game where id = $1 and kind = 'branch'", [body.gameId]);
    if (!g || g.status !== 'active') throw new AppError('Игра не найдена или не запущена', 404);
    // A closed game keeps its players but takes no new sign-ins.
    if (!g.visible) throw new AppError('Игра сейчас закрыта ведущим', 403);
    const [role] = await tx.query('select * from role where id = $1 and game_id = $2 for update', [body.roleId, g.id]);
    if (!role) throw new AppError('Роль не найдена', 404);
    if (!role.code || String(body.code) !== role.code) throw new AppError('Неверный код роли', 403);

    const [existing] = await tx.query('select * from player where role_id = $1', [role.id]);
    if (existing) return existing;

    const first = text(body.firstName, 100) || role.preset_first_name;
    const last = text(body.lastName, 100) || role.preset_last_name;
    if (!first || !last) throw new AppError('Укажите имя и фамилию');
    const [player] = await tx.query(
      'insert into player (game_id, role_id, first_name, last_name) values ($1, $2, $3, $4) returning *',
      [g.id, role.id, first, last],
    );
    const title = `${first} ${last}`;
    const [acc] = await tx.query(
      `select a.id from account a join account_member m on m.account_id = a.id
       where a.kind = 'individual' and m.role_id = $1`,
      [role.id],
    );
    if (acc) {
      await tx.query('update account set title = $2 where id = $1', [acc.id, title]);
    } else {
      const [created] = await tx.query(
        "insert into account (game_id, kind, title) values ($1, 'individual', $2) returning id",
        [g.id, title],
      );
      await tx.query("insert into account_member (account_id, role_id, member) values ($1, $2, 'owner')", [created.id, role.id]);
      if (role.start_balance > 0) {
        await transferTx(tx, {
          gameId: g.id, kind: 'initial', fromAccountId: await hostAccountId(tx, g.id), toAccountId: created.id,
          amount: role.start_balance, comment: 'Стартовый баланс', initiatorPlayerId: player.id,
        });
      }
    }
    return player;
  });
}

export async function releaseRole(db: Db, roleId: number) {
  await db.query('delete from player where role_id = $1', [roleId]);
}

// ---------- Player-side account management ----------

export async function createLegal(db: Db, roleId: number, gameId: number, body: { title?: string; coownerRoleIds?: number[]; pin?: string }) {
  const title = text(body.title);
  if (!title) throw new AppError('Укажите название юрлица');
  if (!isFourDigits(body.pin)) throw new AppError('PIN — ровно 4 цифры');
  const coowners = [...new Set((body.coownerRoleIds ?? []).map(Number))].filter((id) => id !== roleId);
  return db.transaction(async (tx) => {
    if (coowners.length) {
      const found = await tx.query('select id from role where game_id = $1 and id = any($2::int[])', [gameId, coowners]);
      if (found.length !== coowners.length) throw new AppError('Совладелец не из этой игры');
    }
    const [g] = await tx.query('select status from game where id = $1', [gameId]);
    if (g?.status !== 'active') throw new AppError('Игра не запущена');
    const [acc] = await tx.query(
      "insert into account (game_id, kind, title, pin_hash) values ($1, 'legal', $2, $3) returning *",
      [gameId, title, hashSecret(body.pin!)],
    );
    await tx.query("insert into account_member (account_id, role_id, member) values ($1, $2, 'owner')", [acc.id, roleId]);
    for (const rid of coowners) {
      await tx.query("insert into account_member (account_id, role_id, member) values ($1, $2, 'coowner')", [acc.id, rid]);
    }
    await tx.query("insert into account_event (account_id, type, actor, payload) values ($1, 'created', $2, $3)",
      [acc.id, `role:${roleId}`, JSON.stringify({ coowners })]);
    return acc;
  });
}

async function ownedLegal(tx: Tx, roleId: number, accountId: number) {
  const [a] = await tx.query(
    `select a.* from account a join account_member m on m.account_id = a.id
     where a.id = $1 and m.role_id = $2 and m.member = 'owner' for update of a`,
    [accountId, roleId],
  );
  if (!a) throw new AppError('Это может сделать только владелец счёта', 403);
  if (a.kind !== 'legal') throw new AppError('Действие доступно только для юрлиц');
  return a;
}

/** Co-owner confirms the PIN once to be allowed to send; a non-member with the PIN joins as co-owner. */
export async function confirmPin(db: Db, roleId: number, gameId: number, accountId: number, pin: string) {
  return db.transaction(async (tx) => {
    const [a] = await tx.query("select * from account where id = $1 and game_id = $2 and kind = 'legal'", [accountId, gameId]);
    if (!a) throw new AppError('Юрлицо не найдено', 404);
    if (!verifySecret(String(pin), a.pin_hash)) throw new AppError('Неверный PIN', 403);
    await tx.query(
      `insert into account_member (account_id, role_id, member, pin_ok) values ($1, $2, 'coowner', true)
       on conflict (account_id, role_id) do update set pin_ok = true`,
      [accountId, roleId],
    );
    await tx.query("insert into account_event (account_id, type, actor) values ($1, 'pin_confirmed', $2)", [accountId, `role:${roleId}`]);
  });
}

export async function setCoowners(db: Db, roleId: number, gameId: number, accountId: number, roleIds: number[]) {
  return db.transaction(async (tx) => {
    await ownedLegal(tx, roleId, accountId);
    const ids = [...new Set(roleIds.map(Number))].filter((id) => id !== roleId);
    const found = ids.length ? await tx.query('select id from role where game_id = $1 and id = any($2::int[])', [gameId, ids]) : [];
    if (found.length !== ids.length) throw new AppError('Совладелец не из этой игры');
    await tx.query("delete from account_member where account_id = $1 and member = 'coowner' and not (role_id = any($2::int[]))", [accountId, ids]);
    for (const rid of ids) {
      await tx.query(
        "insert into account_member (account_id, role_id, member) values ($1, $2, 'coowner') on conflict do nothing",
        [accountId, rid],
      );
    }
    await tx.query("insert into account_event (account_id, type, actor, payload) values ($1, 'coowners_set', $2, $3)",
      [accountId, `role:${roleId}`, JSON.stringify({ ids })]);
  });
}

export async function changePin(db: Db, roleId: number, accountId: number, pin: string) {
  if (!isFourDigits(pin)) throw new AppError('PIN — ровно 4 цифры');
  return db.transaction(async (tx) => {
    await ownedLegal(tx, roleId, accountId);
    await tx.query('update account set pin_hash = $2 where id = $1', [accountId, hashSecret(pin)]);
    await tx.query("insert into account_event (account_id, type, actor) values ($1, 'pin_changed', $2)", [accountId, `role:${roleId}`]);
  });
}

/** Instant hand-over: the new owner replaces the old one, who loses access unless re-added. */
export async function transferOwnership(db: Db, roleId: number, gameId: number, accountId: number, toRoleId: number) {
  return db.transaction(async (tx) => {
    await ownedLegal(tx, roleId, accountId);
    if (toRoleId === roleId) throw new AppError('Вы уже владелец');
    const [r] = await tx.query('select id from role where id = $1 and game_id = $2', [toRoleId, gameId]);
    if (!r) throw new AppError('Игрок не найден', 404);
    await tx.query('delete from account_member where account_id = $1 and role_id = $2', [accountId, roleId]);
    await tx.query(
      `insert into account_member (account_id, role_id, member, pin_ok) values ($1, $2, 'owner', true)
       on conflict (account_id, role_id) do update set member = 'owner', pin_ok = true`,
      [accountId, toRoleId],
    );
    await tx.query("insert into account_event (account_id, type, actor, payload) values ($1, 'owner_changed', $2, $3)",
      [accountId, `role:${roleId}`, JSON.stringify({ to: toRoleId })]);
  });
}

import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import Fastify, { FastifyReply, FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import * as assets from './assets.js';
import * as assistant from './assistant.js';
import { AppError, Db } from './db.js';
import * as games from './games.js';
import * as reports from './reports.js';
import { AttemptLimiter, hashSecret, newToken, tokenHash, verifySecret } from './security.js';
import * as googleUser from './google-user.js';
import * as sheets from './sheets.js';
import * as telegram from './telegram.js';
import * as hostBot from './telegram-host.js';
import { transcribe, transcriptionEnabled } from './transcribe.js';
import { hostAdjust, payFixedPrice, playerTransfer, transfer } from './transfers.js';

const STAFF_COOKIE = 'sid';
const PLAYER_COOKIE = 'psid';

export function buildApp(db: Db, opts: { webDist?: string; secureCookies?: boolean; claude?: assistant.ClaudeClient } = {}) {
  // Photos for the assistant and voice files arrive base64-encoded in JSON.
  const app = Fastify({ logger: false, bodyLimit: 20 * 1024 * 1024 });
  let claude = opts.claude;
  const claudeClient = () => {
    // Fail before the user's message is stored, with a message the host can act on.
    if (!claude && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      throw new AppError('Помощник не настроен: задайте ANTHROPIC_API_KEY на сервере', 503);
    }
    return (claude ??= new Anthropic());
  };
  app.register(cookie);
  const bus = new EventEmitter().setMaxListeners(0);
  const changed = (gameId: number) => {
    bus.emit(`game:${gameId}`);
    sheets.scheduleSync(db, gameId);
  };
  const codeLimiter = new AttemptLimiter(5, 60_000);
  const loginLimiter = new AttemptLimiter(10, 60_000);

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.status).send({ error: err.message });
    if (err instanceof Anthropic.AuthenticationError) {
      return reply.status(503).send({ error: 'Помощник не настроен: проверьте ANTHROPIC_API_KEY' });
    }
    if (err instanceof Anthropic.RateLimitError) return reply.status(429).send({ error: 'Помощник перегружен, повторите через минуту' });
    if (err instanceof Anthropic.APIError) {
      console.error(err);
      return reply.status(502).send({ error: 'Помощник временно недоступен' });
    }
    if (err.validation || err.statusCode === 400) return reply.status(400).send({ error: 'Некорректный запрос' });
    console.error(err);
    return reply.status(500).send({ error: 'Внутренняя ошибка сервера' });
  });

  const cookieOpts = { path: '/', httpOnly: true, sameSite: 'lax' as const, secure: !!opts.secureCookies, maxAge: 60 * 60 * 24 * 60 };

  async function startSession(reply: FastifyReply, name: string, who: { staffId?: number; playerId?: number }) {
    const { token, hash } = newToken();
    await db.query('insert into session (token_hash, staff_id, player_id) values ($1, $2, $3)',
      [hash, who.staffId ?? null, who.playerId ?? null]);
    reply.setCookie(name, token, cookieOpts);
  }

  async function staffOf(req: FastifyRequest) {
    const t = req.cookies[STAFF_COOKIE];
    if (!t) return null;
    const [s] = await db.query(
      'select st.id, st.name, st.login, st.kind from session se join staff st on st.id = se.staff_id where se.token_hash = $1',
      [tokenHash(t)],
    );
    return s ?? null;
  }

  async function playerOf(req: FastifyRequest) {
    const t = req.cookies[PLAYER_COOKIE];
    if (!t) return null;
    const [p] = await db.query(
      `select p.id as "playerId", p.role_id as "roleId", p.game_id as "gameId", p.first_name as "firstName",
              p.last_name as "lastName", r.title as "roleTitle", g.title as "gameTitle"
       from session se join player p on p.id = se.player_id join role r on r.id = p.role_id
       join game g on g.id = p.game_id where se.token_hash = $1`,
      [tokenHash(t)],
    );
    return p ?? null;
  }

  async function needStaff(req: FastifyRequest) {
    const s = await staffOf(req);
    if (!s) throw new AppError('Нужно войти', 401);
    return s;
  }
  async function needSuper(req: FastifyRequest) {
    const s = await needStaff(req);
    if (s.kind !== 'super') throw new AppError('Только для админа', 403);
    return s;
  }
  async function needPlayer(req: FastifyRequest) {
    const p = await playerOf(req);
    if (!p) throw new AppError('Нужно войти в игру', 401);
    return p;
  }

  /** Super sees everything; a host sees the branches they are attached to. */
  async function canSee(staff: any, gameId: number) {
    if (staff.kind === 'super') return true;
    const [r] = await db.query('select 1 from game_staff where game_id = $1 and staff_id = $2', [gameId, staff.id]);
    return !!r;
  }
  async function needGame(req: FastifyRequest, gameId: number, mode: 'view' | 'config' | 'run') {
    const staff = await needStaff(req);
    const [g] = await db.query('select * from game where id = $1', [gameId]);
    if (!g) throw new AppError('Игра не найдена', 404);
    if (!(await canSee(staff, gameId))) throw new AppError('Нет доступа к игре', 403);
    if (mode === 'config' && g.kind === 'root' && staff.kind !== 'super') throw new AppError('Корневую игру меняет админ', 403);
    // Money and tacts belong to the host of the branch, not to the super host.
    if (mode === 'run') {
      if (g.kind !== 'branch') throw new AppError('Действие доступно только в ответвлении');
      const [r] = await db.query('select 1 from game_staff where game_id = $1 and staff_id = $2', [gameId, staff.id]);
      if (!r) throw new AppError('Это делает ведущий игры', 403);
    }
    return { staff, game: g };
  }
  async function needRow(req: FastifyRequest, entity: games.Entity, id: number) {
    const [row] = await db.query(`select game_id from ${entity} where id = $1`, [id]);
    if (!row) throw new AppError('Не найдено', 404);
    return needGame(req, row.game_id, 'config');
  }

  const num = (v: unknown) => (v === undefined || v === '' || v === null ? undefined : Number(v));
  const filtersOf = (q: any): reports.Filters => ({ tactId: num(q.tact), roleId: num(q.role), accountId: num(q.account) });
  const entityOf = (e: string): games.Entity => {
    const map: Record<string, games.Entity> = {
      roles: 'role', 'asset-types': 'asset_type', 'start-accounts': 'start_account', 'price-items': 'price_item',
    };
    if (!map[e]) throw new AppError('Не найдено', 404);
    return map[e];
  };

  // ---------- Auth ----------

  app.post('/api/staff/login', async (req, reply) => {
    const { login, password } = req.body as any;
    if (!loginLimiter.check(`${req.ip}:${login}`)) throw new AppError('Слишком много попыток, подождите минуту', 429);
    const [s] = await db.query('select * from staff where login = $1', [String(login ?? '').trim()]);
    if (!s || !verifySecret(String(password ?? ''), s.password_hash)) throw new AppError('Неверный логин или пароль', 401);
    await startSession(reply, STAFF_COOKIE, { staffId: s.id });
    return { id: s.id, name: s.name, kind: s.kind };
  });

  app.post('/api/logout', async (req, reply) => {
    const { who } = (req.body as any) ?? {};
    const name = who === 'staff' ? STAFF_COOKIE : PLAYER_COOKIE;
    const t = req.cookies[name];
    if (t) await db.query('delete from session where token_hash = $1', [tokenHash(t)]);
    reply.clearCookie(name, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', async (req) => ({ staff: await staffOf(req), player: await playerOf(req) }));

  // ---------- Public: choose game and role ----------

  app.get('/api/public/games', async () => {
    return db.query(
      `select g.id, g.title, coalesce(string_agg(s.name, ', ' order by s.name), '') as hosts
       from game g left join game_staff gs on gs.game_id = g.id left join staff s on s.id = gs.staff_id
       where g.kind = 'branch' and g.status = 'active' and g.visible group by g.id order by g.title`,
    );
  });

  app.get('/api/public/games/:id/roles', async (req) => {
    const id = Number((req.params as any).id);
    return db.query(
      `select r.id, r.title, r.description, r.preset_first_name as "presetFirstName", r.preset_last_name as "presetLastName",
              exists (select 1 from player p where p.role_id = r.id) as taken
       from role r join game g on g.id = r.game_id
       where r.game_id = $1 and g.kind = 'branch' and g.status = 'active' and g.visible order by r.title`,
      [id],
    );
  });

  app.post('/api/player/join', async (req, reply) => {
    const b = req.body as any;
    if (!codeLimiter.check(`role:${b.roleId}`) || !codeLimiter.check(`ip:${req.ip}`)) {
      throw new AppError('Слишком много попыток, подождите минуту', 429);
    }
    const player = await games.joinRole(db, {
      gameId: Number(b.gameId), roleId: Number(b.roleId), firstName: b.firstName, lastName: b.lastName, code: String(b.code ?? ''),
    });
    await startSession(reply, PLAYER_COOKIE, { playerId: player.id });
    // Joined from the Telegram Mini App: link the Telegram user too, so the bot knows them.
    const tg = b.initData && telegram.botToken() ? telegram.validateInitData(String(b.initData), telegram.botToken()) : null;
    if (tg) await telegram.linkTelegram(db, tg.id, player.id);
    changed(player.game_id);
    return { ok: true };
  });

  /** Host bot's Mini App: the linked host gets a staff session (same cabinet as on the web). */
  app.post('/api/telegram/host-webapp-login', async (req, reply) => {
    const token = hostBot.hostBotToken();
    const user = token ? telegram.validateInitData(String((req.body as any)?.initData ?? ''), token) : null;
    if (!user) throw new AppError('Не удалось проверить вход из Telegram', 401);
    const s = await hostBot.staffOfTelegram(db, user.id);
    if (!s) return { linked: false };
    await startSession(reply, STAFF_COOKIE, { staffId: s.staffId });
    return { linked: true };
  });

  /** Mini App opened inside Telegram: a linked Telegram user gets a player session at once. */
  app.post('/api/telegram/webapp-login', async (req, reply) => {
    const token = telegram.botToken();
    const user = token ? telegram.validateInitData(String((req.body as any)?.initData ?? ''), token) : null;
    if (!user) throw new AppError('Не удалось проверить вход из Telegram', 401);
    const p = await telegram.playerOfTelegram(db, user.id);
    if (!p) return { linked: false };
    await startSession(reply, PLAYER_COOKIE, { playerId: p.playerId });
    return { linked: true };
  });

  // ---------- Live updates (SSE) ----------

  app.get('/api/stream/:gameId', async (req, reply) => {
    const gameId = Number((req.params as any).gameId);
    const p = await playerOf(req);
    const s = p ? null : await staffOf(req);
    if (!(p?.gameId === gameId || (s && (await canSee(s, gameId))))) throw new AppError('Нет доступа', 403);
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    reply.raw.write('retry: 3000\n\n');
    const send = () => reply.raw.write('event: changed\ndata: {}\n\n');
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
    bus.on(`game:${gameId}`, send);
    req.raw.on('close', () => {
      clearInterval(ping);
      bus.off(`game:${gameId}`, send);
    });
  });

  // ---------- Player ----------

  app.get('/api/player/accounts', async (req) => {
    const p = await needPlayer(req);
    const members = await reports.membersByAccount(db, p.gameId);
    const rows = await db.query(
      `select a.id, a.kind, a.title, a.balance, m.member, m.pin_ok as "pinOk"
       from account a join account_member m on m.account_id = a.id
       where m.role_id = $1 order by (a.kind = 'individual') desc, a.title`,
      [p.roleId],
    );
    return rows.map((a) => ({ ...a, members: members.get(a.id) ?? [] }));
  });

  app.get('/api/player/accounts/:id/history', async (req) => {
    const p = await needPlayer(req);
    const id = Number((req.params as any).id);
    const [m] = await db.query('select 1 from account_member where account_id = $1 and role_id = $2', [id, p.roleId]);
    if (!m) throw new AppError('Нет доступа к этому счёту', 403);
    return reports.listTransfers(db, p.gameId, { accountId: id });
  });

  /** All operations on the player's accounts, newest first (the "История" tab). */
  app.get('/api/player/history', async (req) => {
    const p = await needPlayer(req);
    return reports.listTransfers(db, p.gameId, { roleId: p.roleId });
  });

  /** Recipients: game master first, then legal entities, then individuals. */
  app.get('/api/player/recipients', async (req) => {
    const p = await needPlayer(req);
    const rows = await db.query(
      `select a.id, a.kind, a.title, r.title as role_title
       from account a
       left join account_member m on m.account_id = a.id and m.member = 'owner' and a.kind = 'individual'
       left join role r on r.id = m.role_id
       where a.game_id = $1
       order by case a.kind when 'host' then 0 when 'legal' then 1 else 2 end, a.title`,
      [p.gameId],
    );
    return rows.map((a) => ({
      id: a.id, kind: a.kind,
      title: a.kind === 'individual' && a.role_title ? `${a.title} (${a.role_title})` : a.title,
    }));
  });

  app.get('/api/player/roles', async (req) => {
    const p = await needPlayer(req);
    return db.query(
      `select r.id, r.title, (select string_agg(trim(p.first_name || ' ' || p.last_name), ', ' order by p.id) from player p where p.role_id = r.id) as "playerName"
       from role r where r.game_id = $1 order by r.title`,
      [p.gameId],
    );
  });

  app.get('/api/player/price-items', async (req) => {
    const p = await needPlayer(req);
    return db.query('select id, title, price from price_item where game_id = $1 and active order by title', [p.gameId]);
  });

  app.post('/api/player/transfers', async (req) => {
    const p = await needPlayer(req);
    const b = req.body as any;
    const res = await playerTransfer(db, p, {
      fromAccountId: Number(b.fromAccountId), toAccountId: Number(b.toAccountId), amount: b.amount,
      comment: b.comment, idempotencyKey: b.idempotencyKey,
    });
    changed(p.gameId);
    return res;
  });

  app.post('/api/player/pay-fixed', async (req) => {
    const p = await needPlayer(req);
    const b = req.body as any;
    const res = await payFixedPrice(db, p, {
      fromAccountId: Number(b.fromAccountId), priceItemId: Number(b.priceItemId), quantity: b.quantity,
      comment: b.comment, idempotencyKey: b.idempotencyKey,
    });
    changed(p.gameId);
    return res;
  });

  app.post('/api/player/legal', async (req) => {
    const p = await needPlayer(req);
    const b = req.body as any;
    const acc = await games.createLegal(db, p.roleId, p.gameId, { title: b.title, coownerRoleIds: b.coownerRoleIds, pin: String(b.pin ?? '') });
    changed(p.gameId);
    return { id: acc.id };
  });

  app.post('/api/player/accounts/:id/pin-confirm', async (req) => {
    const p = await needPlayer(req);
    const id = Number((req.params as any).id);
    if (!codeLimiter.check(`pin:${id}:${p.roleId}`)) throw new AppError('Слишком много попыток, подождите минуту', 429);
    await games.confirmPin(db, p.roleId, p.gameId, id, String((req.body as any).pin ?? ''));
    changed(p.gameId);
    return { ok: true };
  });

  app.post('/api/player/accounts/:id/coowners', async (req) => {
    const p = await needPlayer(req);
    await games.setCoowners(db, p.roleId, p.gameId, Number((req.params as any).id), (req.body as any).roleIds ?? []);
    changed(p.gameId);
    return { ok: true };
  });

  app.post('/api/player/accounts/:id/pin', async (req) => {
    const p = await needPlayer(req);
    await games.changePin(db, p.roleId, Number((req.params as any).id), String((req.body as any).pin ?? ''));
    return { ok: true };
  });

  app.post('/api/player/accounts/:id/owner', async (req) => {
    const p = await needPlayer(req);
    await games.transferOwnership(db, p.roleId, p.gameId, Number((req.params as any).id), Number((req.body as any).roleId));
    changed(p.gameId);
    return { ok: true };
  });

  // ---------- Staff: games and config ----------

  app.get('/api/admin/games', async (req) => {
    const s = await needStaff(req);
    const rows = await db.query(
      `select g.*, coalesce(string_agg(st.name, ', ' order by st.name), '') as hosts,
              exists (select 1 from game_staff m where m.game_id = g.id and m.staff_id = $1) as mine
       from game g left join game_staff gs on gs.game_id = g.id left join staff st on st.id = gs.staff_id
       ${s.kind === 'super' ? '' : 'where g.id in (select game_id from game_staff where staff_id = $1)'}
       group by g.id order by g.kind desc, g.title`,
      [s.id],
    );
    return rows;
  });

  app.post('/api/admin/games', async (req) => {
    await needSuper(req);
    return games.createRootGame(db, (req.body as any).title);
  });

  /** Super host: open / close a game for players, and rename it. */
  app.patch('/api/admin/games/:id', async (req) => {
    await needSuper(req);
    const id = Number((req.params as any).id);
    const b = req.body as any;
    if ('visible' in b) await db.query('update game set visible = $2 where id = $1', [id, Boolean(b.visible)]);
    if ('title' in b) {
      const title = String(b.title ?? '').trim().slice(0, 200);
      if (!title) throw new AppError('Укажите название игры');
      await db.query('update game set title = $2 where id = $1', [id, title]);
    }
    changed(id);
    const [g] = await db.query('select * from game where id = $1', [id]);
    return g;
  });

  app.post('/api/admin/games/:id/branches', async (req) => {
    await needSuper(req);
    const b = req.body as any;
    return games.createBranch(db, Number((req.params as any).id), b.title, (b.staffIds ?? []).map(Number));
  });

  app.get('/api/admin/games/:id', async (req) => {
    const id = Number((req.params as any).id);
    const { game, staff } = await needGame(req, id, 'view');
    const [roles, startAccounts, priceItems, gameStaff, branches, assetTypes] = await Promise.all([
      db.query(
        `select r.*, (select string_agg(trim(p.first_name || ' ' || p.last_name), ', ' order by p.id) from player p where p.role_id = r.id) as players, (select count(*)::int from player p where p.role_id = r.id) as player_count
         from role r where r.game_id = $1 order by r.title`, [id]),
      db.query('select * from start_account where game_id = $1 order by title', [id]),
      db.query('select * from price_item where game_id = $1 order by title', [id]),
      db.query('select st.id, st.name, st.login from game_staff gs join staff st on st.id = gs.staff_id where gs.game_id = $1 order by st.name', [id]),
      db.query(
        `select g.id, g.title, g.status, coalesce(string_agg(st.name, ', '), '') as hosts from game g
         left join game_staff gs on gs.game_id = g.id left join staff st on st.id = gs.staff_id
         where g.parent_id = $1 group by g.id order by g.title`, [id]),
      assets.assetTypes(db, id),
    ]);
    const isHost = gameStaff.some((s: any) => s.id === staff.id);
    return { game, roles, startAccounts, priceItems, assetTypes, staff: gameStaff, branches,
      can: { config: game.kind === 'branch' || staff.kind === 'super', run: game.kind === 'branch' && isHost, super: staff.kind === 'super' } };
  });

  app.post('/api/admin/games/:id/:entity', async (req) => {
    const { id, entity } = req.params as any;
    if (entity === 'launch' || entity === 'branches' || entity === 'staff' || entity === 'adjust' || entity === 'close-tact') {
      throw new AppError('Не найдено', 404);
    }
    const e = entityOf(entity);
    await needGame(req, Number(id), 'config');
    const row = await games.createRow(db, e, Number(id), req.body);
    changed(Number(id));
    return row;
  });

  app.patch('/api/admin/:entity/:rowId', async (req) => {
    const { entity, rowId } = req.params as any;
    const e = entityOf(entity);
    const { game } = await needRow(req, e, Number(rowId));
    const row = await games.updateRow(db, e, Number(rowId), req.body);
    changed(game.id);
    return row;
  });

  app.delete('/api/admin/:entity/:rowId', async (req) => {
    const { entity, rowId } = req.params as any;
    const e = entityOf(entity);
    const { game } = await needRow(req, e, Number(rowId));
    await games.deleteRow(db, e, Number(rowId));
    changed(game.id);
    return { ok: true };
  });

  app.post('/api/admin/roles/:rowId/code', async (req) => {
    const id = Number((req.params as any).rowId);
    await needRow(req, 'role', id);
    return { code: await games.setRoleCode(db, id, (req.body as any)?.code) };
  });

  app.post('/api/admin/roles/:rowId/release', async (req) => {
    const id = Number((req.params as any).rowId);
    const { game } = await needRow(req, 'role', id);
    await games.releaseRole(db, id);
    changed(game.id);
    return { ok: true };
  });

  app.post('/api/admin/games/:id/launch', async (req) => {
    const id = Number((req.params as any).id);
    await needGame(req, id, 'run');
    await games.launchBranch(db, id);
    changed(id);
    return { ok: true };
  });

  // ---------- Host Telegram bot: link a chat with a one-time t.me link ----------

  app.get('/api/admin/telegram', async (req) => {
    const s = await needStaff(req);
    return { botUsername: hostBot.hostBotUsername() || null, linked: await hostBot.isLinked(db, s.id) };
  });

  app.post('/api/admin/telegram/link', async (req) => {
    const s = await needStaff(req);
    const name = hostBot.hostBotUsername();
    if (!name) throw new AppError('Бот ведущих не запущен на сервере', 503);
    return { url: `https://t.me/${name}?start=${await hostBot.createLinkCode(db, s.id)}` };
  });

  // ---------- Staff accounts ----------

  app.get('/api/admin/staff', async (req) => {
    await needSuper(req);
    return db.query('select id, name, login, kind from staff order by kind desc, name');
  });

  async function createStaff(b: any) {
    const name = String(b.name ?? '').trim();
    const login = String(b.login ?? '').trim();
    if (!name || !login || String(b.password ?? '').length < 6) throw new AppError('Нужны имя, логин и пароль от 6 символов');
    const [exists] = await db.query('select 1 from staff where login = $1', [login]);
    if (exists) throw new AppError('Такой логин уже есть');
    const [s] = await db.query(
      "insert into staff (name, login, password_hash, kind) values ($1, $2, $3, 'host') returning id, name, login, kind",
      [name, login, hashSecret(String(b.password))],
    );
    return s;
  }

  app.post('/api/admin/staff', async (req) => {
    await needSuper(req);
    return createStaff(req.body);
  });

  /** The admin edits a staff account: name, login, password. */
  app.patch('/api/admin/staff/:sid', async (req) => {
    await needSuper(req);
    const id = Number((req.params as any).sid);
    const b = req.body as any;
    if (b.name !== undefined) {
      const name = String(b.name).trim();
      if (!name) throw new AppError('Укажите имя');
      await db.query('update staff set name = $2 where id = $1', [id, name]);
    }
    if (b.login !== undefined) {
      const login = String(b.login).trim();
      const [taken] = await db.query('select 1 from staff where login = $1 and id <> $2', [login, id]);
      if (!login || taken) throw new AppError('Такой логин уже есть');
      await db.query('update staff set login = $2 where id = $1', [id, login]);
    }
    if (b.password !== undefined) {
      if (String(b.password).length < 6) throw new AppError('Пароль — не короче 6 символов');
      await db.query('update staff set password_hash = $2 where id = $1', [id, hashSecret(String(b.password))]);
    }
    const [s] = await db.query('select id, name, login, kind from staff where id = $1', [id]);
    if (!s) throw new AppError('Не найдено', 404);
    return s;
  });

  /** Attach an existing host (super only) or create a chancellery login for this branch (its host). */
  app.post('/api/admin/games/:id/staff', async (req) => {
    const id = Number((req.params as any).id);
    const b = req.body as any;
    const [g] = await db.query('select kind from game where id = $1', [id]);
    if (g?.kind !== 'branch') throw new AppError('Ведущие прикрепляются к ответвлению');
    let staffId: number;
    if (b.staffId) {
      await needSuper(req);
      staffId = Number(b.staffId);
    } else {
      const s = await needStaff(req);
      if (s.kind !== 'super') await needGame(req, id, 'run');
      staffId = (await createStaff(b)).id;
    }
    await db.query('insert into game_staff (game_id, staff_id) values ($1, $2) on conflict do nothing', [id, staffId]);
    return { ok: true };
  });

  app.delete('/api/admin/games/:id/staff/:staffId', async (req) => {
    const { id, staffId } = req.params as any;
    const s = await needStaff(req);
    if (s.kind !== 'super') await needGame(req, Number(id), 'run');
    if (Number(staffId) === s.id) throw new AppError('Нельзя открепить самого себя');
    await db.query('delete from game_staff where game_id = $1 and staff_id = $2', [Number(id), Number(staffId)]);
    return { ok: true };
  });

  // ---------- Staff: running the game ----------

  app.get('/api/admin/games/:id/accounts', async (req) => {
    const id = Number((req.params as any).id);
    await needGame(req, id, 'view');
    const members = await reports.membersByAccount(db, id);
    const rows = await db.query('select id, kind, title, balance from account where game_id = $1 order by kind, title', [id]);
    return rows.map((a) => ({ ...a, members: members.get(a.id) ?? [] }));
  });

  app.get('/api/admin/games/:id/tacts', async (req) => {
    const id = Number((req.params as any).id);
    await needGame(req, id, 'view');
    return reports.tacts(db, id);
  });

  app.get('/api/admin/games/:id/transfers', async (req) => {
    const id = Number((req.params as any).id);
    await needGame(req, id, 'view');
    return reports.listTransfers(db, id, filtersOf(req.query));
  });

  app.get('/api/admin/games/:id/summary', async (req) => {
    const id = Number((req.params as any).id);
    await needGame(req, id, 'view');
    const f = filtersOf(req.query);
    const { tact, rows } = await reports.summary(db, id, f.tactId);
    const members = await reports.membersByAccount(db, id);
    return { tact, rows: reports.filterSummary(rows, f), totals: reports.totalsByOwner(rows, members) };
  });

  app.get('/api/admin/games/:id/export.xlsx', async (req, reply) => {
    const id = Number((req.params as any).id);
    const { game } = await needGame(req, id, 'view');
    // Capacity, revenue/OPEX and the asset journal go along with transfers and the summary.
    const extra = (await sheets.buildSheets(db, id)).filter((x) => ['Мощности', 'Выручка и OPEX', 'Журнал активов'].includes(x.title));
    const buf = await reports.exportXlsx(db, id, filtersOf(req.query), extra);
    reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(game.title)}.xlsx`);
    return reply.send(buf);
  });

  app.post('/api/admin/games/:id/adjust', async (req) => {
    const id = Number((req.params as any).id);
    const { staff } = await needGame(req, id, 'run');
    const b = req.body as any;
    const res = await hostAdjust(db, id, staff.id, {
      accountId: Number(b.accountId), direction: b.direction, amount: b.amount, comment: b.comment, idempotencyKey: b.idempotencyKey,
    });
    changed(id);
    return res;
  });

  /** The host moves money between two companies (e.g. a signed paper slip). Balance rules apply. */
  app.post('/api/admin/games/:id/transfer', async (req) => {
    const id = Number((req.params as any).id);
    const { staff } = await needGame(req, id, 'run');
    const b = req.body as any;
    const [to] = await db.query('select kind from account where id = $1 and game_id = $2', [Number(b.toAccountId), id]);
    if (!to) throw new AppError('Получатель не найден', 404);
    const res = await transfer(db, {
      gameId: id, kind: to.kind === 'host' ? 'to_host' : 'player', fromAccountId: Number(b.fromAccountId), toAccountId: Number(b.toAccountId),
      amount: b.amount, comment: b.comment, initiatorStaffId: staff.id,
      idempotencyKey: b.idempotencyKey ? `s${staff.id}:${String(b.idempotencyKey).slice(0, 100)}` : null,
    });
    changed(id);
    return res;
  });

  app.post('/api/admin/games/:id/close-tact', async (req) => {
    const id = Number((req.params as any).id);
    const { staff } = await needGame(req, id, 'run');
    const res = await assets.finishTact(db, id, staff.id);
    changed(id);
    return res;
  });

  // ---------- Assets, capacities, revenue and OPEX per tact ----------

  app.get('/api/admin/games/:id/capacity', async (req) => {
    const id = Number((req.params as any).id);
    await needGame(req, id, 'view');
    return assets.capacityTable(db, id, num((req.query as any).tact));
  });

  app.put('/api/admin/games/:id/capacity/output', async (req) => {
    const id = Number((req.params as any).id);
    await needGame(req, id, 'run');
    const b = req.body as any;
    await assets.setOutput(db, id, { tactId: Number(b.tactId), accountId: Number(b.accountId), code: String(b.code), amount: b.amount });
    changed(id);
    return { ok: true };
  });

  app.post('/api/admin/games/:id/capacity/post', async (req) => {
    const id = Number((req.params as any).id);
    const { staff } = await needGame(req, id, 'run');
    const res = await assets.postTact(db, id, staff.id, (req.body as any).kind);
    changed(id);
    return res;
  });

  app.get('/api/admin/games/:id/ledger', async (req) => {
    const id = Number((req.params as any).id);
    await needGame(req, id, 'view');
    return assets.ledger(db, id, num((req.query as any).account));
  });

  app.post('/api/admin/games/:id/ledger', async (req) => {
    const id = Number((req.params as any).id);
    const { staff } = await needGame(req, id, 'run');
    const b = req.body as any;
    const row = await assets.addLedger(db, id, staff.id, { accountId: Number(b.accountId), code: String(b.code ?? ''), delta: b.delta, comment: b.comment });
    changed(id);
    return row;
  });

  app.patch('/api/admin/games/:id/ledger/:lid', async (req) => {
    const { id, lid } = req.params as any;
    await needGame(req, Number(id), 'run');
    await assets.updateLedger(db, Number(id), Number(lid), req.body as any);
    changed(Number(id));
    return { ok: true };
  });

  app.delete('/api/admin/games/:id/ledger/:lid', async (req) => {
    const { id, lid } = req.params as any;
    await needGame(req, Number(id), 'run');
    await assets.deleteLedger(db, Number(id), Number(lid));
    changed(Number(id));
    return { ok: true };
  });

  // ---------- Google Sheets mirror ----------

  async function sheetStatus(id: number) {
    const [g] = await db.query('select sheet_id, sheet_synced_at, sheet_error, drive_folder_id, sheet_gids from game where id = $1', [id]);
    return {
      sheetId: g.sheet_id, gids: g.sheet_gids, syncedAt: g.sheet_synced_at, error: g.sheet_error, serviceEmail: sheets.serviceEmail(),
      baseFolderId: await sheets.getSetting(db, 'drive_folder_id'), gameFolderId: g.drive_folder_id,
      oauthConfigured: googleUser.oauthConfigured(), googleUser: await googleUser.connectedEmail(db),
    };
  }

  // "Войти через Google": the super host lets the bank create files in their Drive.
  const callbackUrl = (req: FastifyRequest) =>
    process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL.replace(/\/$/, '')}/api/admin/google/callback`
      : `${req.protocol}://${req.headers.host}/api/admin/google/callback`;

  app.get('/api/admin/google/connect', async (req, reply) => {
    await needSuper(req);
    const back = String((req.query as any).back ?? '/admin');
    return reply.redirect(googleUser.authUrl(callbackUrl(req), back.startsWith('/admin') ? back : '/admin'));
  });

  // Errors come back to the cabinet as ?google_error=… so the host sees why sign-in failed.
  app.get('/api/admin/google/callback', async (req, reply) => {
    const q = req.query as any;
    const back = googleUser.returnTo(String(q.state ?? ''));
    const fail = (msg: string) => reply.redirect(`${back}?google_error=${encodeURIComponent(msg)}`);
    try {
      await needSuper(req);
      if (q.error) return fail(q.error === 'access_denied' ? 'Доступ не разрешён в Google' : `Google: ${q.error}`);
      await googleUser.finishAuth(db, String(q.code ?? ''), String(q.state ?? ''));
      return reply.redirect(back);
    } catch (e: any) {
      console.error('google callback', e?.response?.data ?? e?.message ?? e);
      return fail(e instanceof AppError ? (e.status === 401 ? 'Войдите в кабинет как админ и повторите вход через Google' : e.message) : 'Не удалось завершить вход через Google');
    }
  });

  app.post('/api/admin/google/disconnect', async (req) => {
    await needSuper(req);
    await googleUser.disconnect(db);
    return { ok: true };
  });

  /** The Drive folder where game spreadsheets are created, in subfolders per root game. */
  app.put('/api/admin/drive-folder', async (req) => {
    await needSuper(req);
    await sheets.setSetting(db, 'drive_folder_id', sheets.parseFolderId((req.body as any).folder));
    return { ok: true };
  });

  app.post('/api/admin/games/:id/sheet/create', async (req) => {
    const id = Number((req.params as any).id);
    const { game } = await needGame(req, id, 'config');
    if (game.kind !== 'branch') throw new AppError('Таблица создаётся для ответвления игры');
    await sheets.createInFolder(db, id);
    return sheetStatus(id);
  });

  app.get('/api/admin/games/:id/sheet', async (req) => {
    const id = Number((req.params as any).id);
    await needGame(req, id, 'view');
    return sheetStatus(id);
  });

  app.put('/api/admin/games/:id/sheet', async (req) => {
    const id = Number((req.params as any).id);
    await needGame(req, id, 'config');
    const sheetId = sheets.parseSheetId((req.body as any).sheet);
    await db.query("update game set sheet_id = $2, sheet_error = '', sheet_synced_at = null, sheet_gids = '{}' where id = $1", [id, sheetId]);
    if (sheetId) {
      // Tidy up: move the sheet into the game's subfolder; a failure here never blocks the sync.
      await sheets.placeInFolder(db, id).catch((e) => console.error('drive place', e?.response?.data?.error?.message ?? e));
      await sheets.syncNow(db, id).catch(() => {});
    }
    return sheetStatus(id);
  });

  app.post('/api/admin/games/:id/sheet/sync', async (req) => {
    const id = Number((req.params as any).id);
    await needGame(req, id, 'view');
    await sheets.syncNow(db, id).catch(() => {});
    return sheetStatus(id);
  });

  app.patch('/api/admin/games/:id/rules', async (req) => {
    const id = Number((req.params as any).id);
    await needGame(req, id, 'config');
    await games.updateRules(db, id, (req.body as any).rules);
    changed(id);
    return { ok: true };
  });

  // ---------- AI assistant: a private chat per staff member and game ----------

  app.get('/api/admin/games/:id/assistant', async (req) => {
    const id = Number((req.params as any).id);
    const { staff } = await needGame(req, id, 'view');
    const thread = await assistant.currentThread(db, id, staff.id);
    return { ...(await assistant.threadView(db, thread.id)), transcription: transcriptionEnabled() };
  });

  app.post('/api/admin/games/:id/assistant/new', async (req) => {
    const id = Number((req.params as any).id);
    const { staff } = await needGame(req, id, 'view');
    const thread = await assistant.newThread(db, id, staff.id);
    return { ...(await assistant.threadView(db, thread.id)), transcription: transcriptionEnabled() };
  });

  app.post('/api/admin/games/:id/assistant/messages', async (req) => {
    const id = Number((req.params as any).id);
    const { staff } = await needGame(req, id, 'view');
    const b = req.body as any;
    const image = b.image?.data ? { mediaType: String(b.image.mediaType), data: String(b.image.data) } : undefined;
    return assistant.chat(db, claudeClient(), id, staff.id, { text: b.text, image });
  });

  async function needOwnProposal(req: FastifyRequest) {
    const pid = Number((req.params as any).pid);
    const [p] = await db.query(
      'select p.game_id, t.staff_id from assistant_proposal p join assistant_thread t on t.id = p.thread_id where p.id = $1',
      [pid],
    );
    if (!p) throw new AppError('Операция не найдена', 404);
    const { staff } = await needGame(req, p.game_id, 'run');
    if (p.staff_id !== staff.id) throw new AppError('Это операция из чужого чата', 403);
    return { pid, staff };
  }

  app.post('/api/admin/assistant/proposals/:pid/confirm', async (req) => {
    const { pid, staff } = await needOwnProposal(req);
    const gameId = await assistant.confirmProposal(db, pid, staff.id);
    changed(gameId);
    return { ok: true };
  });

  app.post('/api/admin/assistant/proposals/:pid/reject', async (req) => {
    const { pid } = await needOwnProposal(req);
    await assistant.rejectProposal(db, pid);
    return { ok: true };
  });

  app.post('/api/admin/assistant/transcribe', async (req) => {
    await needStaff(req);
    const b = req.body as any;
    const audio = Buffer.from(String(b.data ?? ''), 'base64');
    if (!audio.length) throw new AppError('Пустой аудиофайл');
    return { text: await transcribe(audio, String(b.mediaType ?? ''), String(b.filename ?? '')) };
  });

  // ---------- Static web client ----------

  const dist = opts.webDist ?? fileURLToPath(new URL('../../web/dist', import.meta.url));
  if (existsSync(dist)) {
    app.register(fastifyStatic, { root: dist });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'Не найдено' });
      return reply.sendFile('index.html');
    });
  }

  return app;
}

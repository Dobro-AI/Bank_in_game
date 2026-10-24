import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { Bot, InlineKeyboard, Keyboard } from 'grammy';
import { AppError, Db } from './db.js';
import * as games from './games.js';
import { KIND_LABEL, listTransfers } from './reports.js';
import { AttemptLimiter } from './security.js';
import { payFixedPrice, playerTransfer, transferEvents } from './transfers.js';

/**
 * Telegram bot for players (and the Mini App login). Same bank, same rules: the bot calls the
 * same transfer functions as the web cabinet. Dialog state lives in memory per chat.
 */

export function botToken() {
  const file = process.env.TELEGRAM_BOT_TOKEN_FILE;
  return process.env.TELEGRAM_BOT_TOKEN ?? (file && existsSync(file) ? readFileSync(file, 'utf8').trim() : '');
}

/** Mini App URL: Telegram opens web apps only over HTTPS. */
export function webAppUrl() {
  const base = process.env.PUBLIC_URL?.replace(/\/$/, '');
  return base?.startsWith('https://') ? `${base}/play` : null;
}

// ---------- Mini App initData (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app) ----------

export function validateInitData(initData: string, token: string, maxAgeSec = 24 * 3600) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  if (createHmac('sha256', secret).update(check).digest('hex') !== hash) return null;
  const authDate = Number(params.get('auth_date'));
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSec) return null;
  const user = JSON.parse(params.get('user') ?? 'null');
  return user?.id ? (user as { id: number; first_name?: string; last_name?: string }) : null;
}

// ---------- Links between Telegram users and players ----------

export async function linkTelegram(db: Db, telegramId: number, playerId: number) {
  await db.query(
    `insert into telegram_link (telegram_id, player_id) values ($1, $2)
     on conflict (telegram_id, player_id) do update set created_at = now()`,
    [telegramId, playerId],
  );
}

export async function playerOfTelegram(db: Db, telegramId: number) {
  const [p] = await db.query(
    `select p.id as "playerId", p.role_id as "roleId", p.game_id as "gameId", p.first_name as "firstName",
            p.last_name as "lastName", r.title as "roleTitle", g.title as "gameTitle"
     from telegram_link t join player p on p.id = t.player_id join role r on r.id = p.role_id
     join game g on g.id = p.game_id
     where t.telegram_id = $1 and g.status = 'active' order by t.created_at desc limit 1`,
    [telegramId],
  );
  return p ?? null;
}

/** Telegram chats to notify about a transfer: members of the receiving account (and of the
 * debited one for the game master's write-offs), except whoever started it. */
export async function recipientsOf(db: Db, t: any) {
  const accounts = t.kind === 'host_debit' || t.kind === 'fixed_price' ? [t.to_account_id, t.from_account_id] : [t.to_account_id];
  return db.query(
    `select distinct tl.telegram_id, m.account_id
     from account_member m join player p on p.role_id = m.role_id join telegram_link tl on tl.player_id = p.id
     where m.account_id = any($1::int[]) and p.id is distinct from $2`,
    [accounts, t.initiator_player_id],
  );
}

// ---------- Bot ----------

const fmt = (n: number) => new Intl.NumberFormat('ru-RU').format(n);
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

type State =
  | { step: 'name'; gameId: number; roleId: number }
  | { step: 'code'; gameId: number; roleId: number; firstName?: string; lastName?: string }
  | { step: 'amount'; from: number; to: number }
  | { step: 'comment'; from: number; to: number; amount: number }
  | { step: 'confirm'; key: string; action: 'transfer'; from: number; to: number; amount: number; comment: string }
  | { step: 'confirm'; key: string; action: 'price'; from: number; item: number; qty: number };

const MENU = {
  balance: 'Баланс',
  send: 'Перевести',
  pay: 'Оплатить по прайсу',
  history: 'История',
  logout: 'Выйти из игры',
};

export function createBot(db: Db, token: string) {
  const bot = new Bot(token);
  const states = new Map<number, State>();
  const codeLimiter = new AttemptLimiter(5, 60_000);

  const menu = () => {
    const k = new Keyboard().text(MENU.balance).text(MENU.send).row().text(MENU.pay).text(MENU.history).row();
    const url = webAppUrl();
    if (url) k.webApp('Открыть банк', url).row();
    return k.text(MENU.logout).resized().persistent();
  };

  const player = async (tgId: number) => playerOfTelegram(db, tgId);
  const accountsOf = (roleId: number) =>
    db.query(
      `select a.id, a.kind, a.title, a.balance, m.member, m.pin_ok as "pinOk"
       from account a join account_member m on m.account_id = a.id where m.role_id = $1
       order by (a.kind = 'individual') desc, a.title`,
      [roleId],
    );
  const spendable = async (roleId: number) => (await accountsOf(roleId)).filter((a) => a.member === 'owner' || a.pinOk);
  const titleOf = async (id: number) => {
    const [a] = await db.query('select kind, title from account where id = $1', [id]);
    return a ? (a.kind === 'host' ? 'Игротехник' : a.title) : '';
  };

  async function startJoin(ctx: any) {
    const list = await db.query("select id, title from game where kind = 'branch' and status = 'active' and visible order by title");
    if (!list.length) return ctx.reply('Сейчас нет открытых игр. Дождитесь, пока игротехник откроет игру.');
    // Usually one game is open at a time: go straight to its roles.
    if (list.length === 1) return showRoles(ctx, list[0].id, false);
    const kb = new InlineKeyboard();
    for (const g of list) kb.text(g.title, `g:${g.id}`).row();
    return ctx.reply('Добро пожаловать в игровой банк! Выберите игру:', { reply_markup: kb });
  }

  async function showBalance(ctx: any, p: any) {
    const accs = await accountsOf(p.roleId);
    const lines = accs.map((a) => `• ${esc(a.title)} — <b>${fmt(a.balance)}</b>${a.kind === 'legal' ? ' (юрлицо)' : ''}${a.member === 'coowner' && !a.pinOk ? ' — нужен PIN' : ''}`);
    const total = accs.reduce((s, a) => s + a.balance, 0);
    return ctx.reply(
      `<b>${esc(p.gameTitle)}</b>\n${esc(p.firstName)} ${esc(p.lastName)} · ${esc(p.roleTitle)}\n\n${lines.join('\n') || 'Счетов нет'}\n\nВсего: <b>${fmt(total)}</b>`,
      { parse_mode: 'HTML', reply_markup: menu() },
    );
  }

  async function needPlayer(ctx: any) {
    const p = await player(ctx.from.id);
    if (!p) {
      await startJoin(ctx);
      return null;
    }
    return p;
  }

  // ----- Entry and joining a game -----

  bot.command('start', async (ctx) => {
    states.delete(ctx.chat.id);
    const p = await player(ctx.from!.id);
    return p ? showBalance(ctx, p) : startJoin(ctx);
  });

  bot.command('help', (ctx) =>
    ctx.reply(
      'Это игровой банк. Деньги виртуальные.\n\n/balance — баланс\n/send — перевести\n/pay — оплатить по прайсу игротехнику\n/history — история операций\n/logout — выйти из игры\n\nКод роли выдаёт ведущий.',
      { reply_markup: menu() },
    ));

  async function showRoles(ctx: any, gameId: number, edit: boolean) {
    const roles = await db.query(
      `select r.id, r.title, (p.id is not null) as taken from role r join game g on g.id = r.game_id
       left join player p on p.role_id = r.id where r.game_id = $1 and g.status = 'active' and g.visible order by r.title`,
      [gameId],
    );
    const kb = new InlineKeyboard();
    for (const r of roles) kb.text(r.taken ? `${r.title} · войти по коду` : r.title, `r:${gameId}:${r.id}`).row();
    const [g] = await db.query('select title from game where id = $1', [gameId]);
    const text = `Добро пожаловать в игровой банк!\n${g?.title ?? ''}\n\nВыберите свою роль:`;
    return edit ? ctx.editMessageText(text, { reply_markup: kb }) : ctx.reply(text, { reply_markup: kb });
  }

  bot.callbackQuery(/^g:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    return showRoles(ctx, Number(ctx.match[1]), true);
  });

  bot.callbackQuery(/^r:(\d+):(\d+)$/, async (ctx) => {
    const gameId = Number(ctx.match[1]);
    const roleId = Number(ctx.match[2]);
    const [role] = await db.query(
      `select r.title, r.preset_first_name, r.preset_last_name, (p.id is not null) as taken
       from role r left join player p on p.role_id = r.id where r.id = $1 and r.game_id = $2`,
      [roleId, gameId],
    );
    await ctx.answerCallbackQuery();
    if (!role) return ctx.reply('Роль не найдена');
    if (role.taken || (role.preset_first_name && role.preset_last_name)) {
      states.set(ctx.chat!.id, { step: 'code', gameId, roleId, firstName: role.preset_first_name, lastName: role.preset_last_name });
      return ctx.editMessageText(`Роль «${role.title}». Введите код роли — 4 цифры от ведущего.`);
    }
    states.set(ctx.chat!.id, { step: 'name', gameId, roleId });
    return ctx.editMessageText(`Роль «${role.title}». Напишите имя и фамилию.`);
  });

  // ----- Menu -----

  const balance = async (ctx: any) => { const p = await needPlayer(ctx); if (p) return showBalance(ctx, p); };
  bot.command('balance', balance);
  bot.hears(MENU.balance, balance);

  const history = async (ctx: any) => {
    const p = await needPlayer(ctx);
    if (!p) return;
    const mine = new Set((await accountsOf(p.roleId)).map((a) => a.id));
    const ops = (await listTransfers(db, p.gameId, { roleId: p.roleId })).slice(0, 15);
    if (!ops.length) return ctx.reply('Операций пока нет.', { reply_markup: menu() });
    const lines = ops.map((o) => {
      const inc = mine.has(o.to_account_id) && !mine.has(o.from_account_id);
      const who = inc ? o.from_title : o.to_title;
      return `${inc ? '+' : '−'}${fmt(o.amount)} · ${esc(who)}${o.comment ? ` · ${esc(o.comment)}` : ''} · такт ${o.tact}`;
    });
    return ctx.reply(`<b>Последние операции</b>\n${lines.join('\n')}`, { parse_mode: 'HTML', reply_markup: menu() });
  };
  bot.command('history', history);
  bot.hears(MENU.history, history);

  const logout = async (ctx: any) => {
    states.delete(ctx.chat.id);
    await db.query('delete from telegram_link where telegram_id = $1', [ctx.from.id]);
    return ctx.reply('Вы вышли из игры в этом Telegram. Чтобы вернуться — /start и код роли.', { reply_markup: { remove_keyboard: true } });
  };
  bot.command('logout', logout);
  bot.hears(MENU.logout, logout);

  // ----- Transfer: from → to → amount → comment → confirm -----

  async function chooseSource(ctx: any, p: any, prefix: 'tf' | 'pf') {
    const accs = await spendable(p.roleId);
    if (!accs.length) return ctx.reply('Нет счетов, с которых можно переводить.');
    if (accs.length === 1) return prefix === 'tf' ? chooseRecipient(ctx, p, accs[0].id) : chooseItem(ctx, p, accs[0].id);
    const kb = new InlineKeyboard();
    for (const a of accs) kb.text(`${a.title} — ${fmt(a.balance)}`, `${prefix}:${a.id}`).row();
    return ctx.reply('С какого счёта?', { reply_markup: kb });
  }

  async function chooseRecipient(ctx: any, p: any, from: number) {
    const list = await db.query(
      `select a.id, a.kind, a.title from account a where a.game_id = $1 and a.id <> $2
       order by case a.kind when 'host' then 0 when 'legal' then 1 else 2 end, a.title`,
      [p.gameId, from],
    );
    const kb = new InlineKeyboard();
    for (const a of list) kb.text(a.kind === 'host' ? 'Игротехник (ведущий)' : a.title, `tt:${from}:${a.id}`).row();
    return ctx.reply('Кому перевести?', { reply_markup: kb });
  }

  const send = async (ctx: any) => { const p = await needPlayer(ctx); if (p) return chooseSource(ctx, p, 'tf'); };
  bot.command('send', send);
  bot.hears(MENU.send, send);

  bot.callbackQuery(/^tf:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const p = await needPlayer(ctx);
    if (p) return chooseRecipient(ctx, p, Number(ctx.match[1]));
  });

  bot.callbackQuery(/^tt:(\d+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const from = Number(ctx.match[1]);
    const to = Number(ctx.match[2]);
    const [a] = await db.query('select balance from account where id = $1', [from]);
    states.set(ctx.chat!.id, { step: 'amount', from, to });
    return ctx.editMessageText(`Перевод: ${await titleOf(from)} → ${await titleOf(to)}\nВведите сумму (доступно ${fmt(a?.balance ?? 0)}).`);
  });

  bot.callbackQuery('tc:skip', async (ctx) => {
    await ctx.answerCallbackQuery();
    const st = states.get(ctx.chat!.id);
    if (st?.step === 'comment') return confirmTransfer(ctx, { ...st, comment: '' });
  });

  async function confirmTransfer(ctx: any, t: { from: number; to: number; amount: number; comment: string }) {
    const key = randomUUID();
    states.set(ctx.chat.id, { step: 'confirm', key, action: 'transfer', ...t });
    const kb = new InlineKeyboard().text('Перевести', `ok:${key}`).text('Отмена', 'no');
    return ctx.reply(
      `Подтвердите перевод\n\nОткуда: ${await titleOf(t.from)}\nКуда: ${await titleOf(t.to)}\nСумма: ${fmt(t.amount)}${t.comment ? `\nКомментарий: ${t.comment}` : ''}`,
      { reply_markup: kb },
    );
  }

  // ----- Price list (CAPEX): from → item → quantity → confirm -----

  async function chooseItem(ctx: any, p: any, from: number) {
    const items = await db.query('select id, title, price from price_item where game_id = $1 and active order by title', [p.gameId]);
    if (!items.length) return ctx.reply('Ведущий ещё не заполнил прайс.');
    const kb = new InlineKeyboard();
    for (const i of items) kb.text(`${i.title} — ${fmt(i.price)}`, `pi:${from}:${i.id}`).row();
    return ctx.reply('Что покупаете у игротехника?', { reply_markup: kb });
  }

  const pay = async (ctx: any) => { const p = await needPlayer(ctx); if (p) return chooseSource(ctx, p, 'pf'); };
  bot.command('pay', pay);
  bot.hears(MENU.pay, pay);

  bot.callbackQuery(/^pf:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const p = await needPlayer(ctx);
    if (p) return chooseItem(ctx, p, Number(ctx.match[1]));
  });

  bot.callbackQuery(/^pi:(\d+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const [from, item] = [Number(ctx.match[1]), Number(ctx.match[2])];
    const kb = new InlineKeyboard();
    for (const q of [1, 2, 3, 5, 10]) kb.text(`${q} шт.`, `pq:${from}:${item}:${q}`);
    return ctx.editMessageText('Сколько штук?', { reply_markup: kb });
  });

  bot.callbackQuery(/^pq:(\d+):(\d+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const [from, item, qty] = [Number(ctx.match[1]), Number(ctx.match[2]), Number(ctx.match[3])];
    const [i] = await db.query('select title, price from price_item where id = $1', [item]);
    if (!i) return ctx.reply('Позиция не найдена');
    const key = randomUUID();
    states.set(ctx.chat!.id, { step: 'confirm', key, action: 'price', from, item, qty });
    const kb = new InlineKeyboard().text('Оплатить', `ok:${key}`).text('Отмена', 'no');
    return ctx.editMessageText(
      `Подтвердите оплату игротехнику\n\nСо счёта: ${await titleOf(from)}\n${i.title} × ${qty}\nСумма: ${fmt(i.price * qty)}\n\nОплата по прайсу может увести счёт в минус.`,
      { reply_markup: kb },
    );
  });

  // ----- Confirm / cancel -----

  bot.callbackQuery('no', async (ctx) => {
    states.delete(ctx.chat!.id);
    await ctx.answerCallbackQuery('Отменено');
    return ctx.editMessageText('Отменено.');
  });

  bot.callbackQuery(/^ok:(.+)$/, async (ctx) => {
    const st = states.get(ctx.chat!.id);
    // The same key is reused if the button is pressed twice, so money moves once.
    if (st?.step !== 'confirm' || st.key !== ctx.match[1]) return ctx.answerCallbackQuery('Операция уже обработана');
    await ctx.answerCallbackQuery();
    const p = await needPlayer(ctx);
    if (!p) return;
    try {
      if (st.action === 'transfer') {
        await playerTransfer(db, p, { fromAccountId: st.from, toAccountId: st.to, amount: st.amount, comment: st.comment, idempotencyKey: `tg:${st.key}` });
        await ctx.editMessageText(`Готово: ${fmt(st.amount)} → ${await titleOf(st.to)}`);
      } else {
        const r = await payFixedPrice(db, p, { fromAccountId: st.from, priceItemId: st.item, quantity: st.qty, idempotencyKey: `tg:${st.key}` });
        await ctx.editMessageText(`Оплачено: ${r.transfer.comment}, ${fmt(r.transfer.amount)}`);
      }
      states.delete(ctx.chat!.id);
    } catch (e: any) {
      states.delete(ctx.chat!.id);
      return ctx.editMessageText(`Не получилось: ${e instanceof AppError ? e.message : 'ошибка сервера'}`);
    }
  });

  // ----- Free text: name, code, amount, comment -----

  bot.on('message:text', async (ctx) => {
    const st = states.get(ctx.chat.id);
    const text = ctx.message.text.trim();
    if (!st) return ctx.reply('Выберите действие в меню или нажмите /start.', { reply_markup: (await player(ctx.from.id)) ? menu() : undefined });

    if (st.step === 'name') {
      const [firstName, ...rest] = text.split(/\s+/);
      if (!firstName || !rest.length) return ctx.reply('Напишите имя и фамилию через пробел.');
      states.set(ctx.chat.id, { step: 'code', gameId: st.gameId, roleId: st.roleId, firstName, lastName: rest.join(' ') });
      return ctx.reply('Теперь код роли — 4 цифры от ведущего.');
    }

    if (st.step === 'code') {
      if (!/^\d{4}$/.test(text)) return ctx.reply('Код — ровно 4 цифры.');
      if (!codeLimiter.check(`tg:${ctx.from.id}`) || !codeLimiter.check(`role:${st.roleId}`)) {
        return ctx.reply('Слишком много попыток, подождите минуту.');
      }
      try {
        const pl = await games.joinRole(db, { gameId: st.gameId, roleId: st.roleId, firstName: st.firstName, lastName: st.lastName, code: text });
        await linkTelegram(db, ctx.from.id, pl.id);
        states.delete(ctx.chat.id);
        const p = await player(ctx.from.id);
        await ctx.reply('Вы в игре! Буду присылать сюда уведомления о поступлениях.');
        return showBalance(ctx, p);
      } catch (e: any) {
        return ctx.reply(e instanceof AppError ? e.message : 'Не удалось войти, попробуйте ещё раз.');
      }
    }

    if (st.step === 'amount') {
      const n = Number(text.replace(/\s/g, ''));
      if (!Number.isInteger(n) || n <= 0) return ctx.reply('Сумма — целое число больше нуля.');
      states.set(ctx.chat.id, { step: 'comment', from: st.from, to: st.to, amount: n });
      return ctx.reply('Комментарий к переводу (за что)?', { reply_markup: new InlineKeyboard().text('Без комментария', 'tc:skip') });
    }

    if (st.step === 'comment') return confirmTransfer(ctx, { from: st.from, to: st.to, amount: st.amount, comment: text.slice(0, 500) });

    return ctx.reply('Подтвердите или отмените операцию кнопками выше.');
  });

  bot.catch((err) => console.error('telegram bot', err.error));

  // ----- Notifications -----

  transferEvents.on('transfer', async (t: any) => {
    if (t.kind === 'initial') return;
    try {
      const recipients = await recipientsOf(db, t);
      const from = await titleOf(t.from_account_id);
      const to = await titleOf(t.to_account_id);
      for (const r of recipients) {
        const incoming = r.account_id === t.to_account_id;
        const text = incoming
          ? `Поступление <b>+${fmt(t.amount)}</b> на «${esc(to)}» от «${esc(from)}»${t.comment ? `\n${esc(t.comment)}` : ''}`
          : `Списание <b>−${fmt(t.amount)}</b> со счёта «${esc(from)}» (${KIND_LABEL[t.kind] ?? ''})${t.comment ? `\n${esc(t.comment)}` : ''}`;
        await bot.api.sendMessage(Number(r.telegram_id), text, { parse_mode: 'HTML' }).catch(() => {});
      }
    } catch (e) {
      console.error('telegram notify', e);
    }
  });

  return bot;
}

/** Commands, description and the Mini App menu button, as players see them in Telegram. */
export async function configureBot(bot: Bot) {
  await bot.api.setMyCommands([
    { command: 'start', description: 'Войти в игру / главное меню' },
    { command: 'balance', description: 'Баланс счетов' },
    { command: 'send', description: 'Перевести деньги' },
    { command: 'pay', description: 'Оплатить по прайсу игротехнику' },
    { command: 'history', description: 'История операций' },
    { command: 'logout', description: 'Выйти из игры' },
    { command: 'help', description: 'Помощь' },
  ]);
  await bot.api.setMyShortDescription('Игровой банк: баланс, переводы и уведомления о поступлениях.');
  await bot.api.setMyDescription(
    'Игровой банк для ролевой игры. Деньги виртуальные.\n\n' +
    'Нажмите «Старт», выберите игру и роль и введите код роли от ведущего. ' +
    'Дальше — баланс, переводы, оплата по прайсу игротехнику и уведомления о поступлениях.',
  );
  const url = webAppUrl();
  await bot.api.setChatMenuButton({ menu_button: url ? { type: 'web_app', text: 'Банк', web_app: { url } } : { type: 'commands' } });
}

export async function startBot(db: Db) {
  const token = botToken();
  if (!token) return null;
  const bot = createBot(db, token);
  await configureBot(bot).catch((e) => console.error('telegram configure', e?.description ?? e));
  bot.start({ drop_pending_updates: false, onStart: (me) => console.log(`Telegram-бот запущен: @${me.username}`) }).catch((e) => console.error('telegram polling', e?.description ?? e));
  return bot;
}

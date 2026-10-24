import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { Bot, InlineKeyboard, Keyboard } from 'grammy';
import * as assets from './assets.js';
import * as assistant from './assistant.js';
import { AppError, Db } from './db.js';
import { KIND_LABEL, closeTact, listTransfers, summary } from './reports.js';
import { transcribe, transcriptionEnabled } from './transcribe.js';
import { hostAdjust, transferEvents } from './transfers.js';

/**
 * Telegram bot for hosts (игротехники): summary, transfers, credits/debits, tacts, revenue/OPEX,
 * the AI assistant (photos of paper slips, questions, voice) and alerts about payments to the host.
 * A chat is linked to a staff account with a one-time link from the web cabinet — no passwords in chat.
 */

export function hostBotToken() {
  const file = process.env.TELEGRAM_HOST_BOT_TOKEN_FILE;
  return process.env.TELEGRAM_HOST_BOT_TOKEN ?? (file && existsSync(file) ? readFileSync(file, 'utf8').trim() : '');
}

let username = '';
export const hostBotUsername = () => username;

// ---------- Linking ----------

export async function createLinkCode(db: Db, staffId: number) {
  const code = randomBytes(9).toString('base64url');
  await db.query("delete from staff_link_code where staff_id = $1 or expires_at < now()", [staffId]);
  await db.query("insert into staff_link_code (code, staff_id, expires_at) values ($1, $2, now() + interval '15 minutes')", [code, staffId]);
  return code;
}

export async function linkByCode(db: Db, code: string, telegramId: number) {
  return db.transaction(async (tx) => {
    const [c] = await tx.query('delete from staff_link_code where code = $1 and expires_at > now() returning staff_id', [code]);
    if (!c) throw new AppError('Ссылка устарела. Получите новую в кабинете ведущего.');
    await tx.query(
      `insert into staff_telegram (telegram_id, staff_id) values ($1, $2)
       on conflict (telegram_id) do update set staff_id = excluded.staff_id, game_id = null`,
      [telegramId, c.staff_id],
    );
    const [s] = await tx.query('select id, name, kind from staff where id = $1', [c.staff_id]);
    return s;
  });
}

export async function staffOfTelegram(db: Db, telegramId: number) {
  const [s] = await db.query(
    `select st.id as "staffId", st.name, st.kind, t.game_id as "gameId", t.notify, g.title as "gameTitle"
     from staff_telegram t join staff st on st.id = t.staff_id left join game g on g.id = t.game_id
     where t.telegram_id = $1`,
    [telegramId],
  );
  return s ?? null;
}

export async function isLinked(db: Db, staffId: number) {
  const [r] = await db.query('select 1 from staff_telegram where staff_id = $1 limit 1', [staffId]);
  return !!r;
}

/** Branches a staff member works in; the super host may look at every branch. */
async function gamesOf(db: Db, staff: { staffId: number; kind: string }) {
  return db.query(
    `select g.id, g.title, g.status from game g where g.kind = 'branch'
     ${staff.kind === 'super' ? '' : 'and g.id in (select game_id from game_staff where staff_id = $1)'}
     order by g.status = 'active' desc, g.title`,
    staff.kind === 'super' ? [] : [staff.staffId],
  );
}

async function canRun(db: Db, staffId: number, gameId: number) {
  const [r] = await db.query('select 1 from game_staff where game_id = $1 and staff_id = $2', [gameId, staffId]);
  return !!r;
}

// ---------- Bot ----------

const fmt = (n: number) => new Intl.NumberFormat('ru-RU').format(n);
const esc = (s: string) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

const MENU = {
  summary: 'Сводка',
  transfers: 'Переводы',
  adjust: 'Начислить / списать',
  tact: 'Такт',
  post: 'Выручка и OPEX',
  game: 'Сменить игру',
};

type State =
  | { step: 'amount'; dir: 'credit' | 'debit'; account: number }
  | { step: 'comment'; dir: 'credit' | 'debit'; account: number; amount: number }
  | { step: 'confirm'; key: string; dir: 'credit' | 'debit'; account: number; amount: number; comment: string };

export function createHostBot(db: Db, token: string) {
  const bot = new Bot(token);
  const states = new Map<number, State>();
  const claude = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? new Anthropic() : null;

  const menu = () =>
    new Keyboard().text(MENU.summary).text(MENU.transfers).row().text(MENU.adjust).text(MENU.tact).row()
      .text(MENU.post).text(MENU.game).resized().persistent();

  async function chooseGame(ctx: any, staff: any) {
    const list = await gamesOf(db, staff);
    if (!list.length) return ctx.reply('Вас ещё не прикрепили ни к одной игре.');
    const kb = new InlineKeyboard();
    for (const g of list) kb.text(`${g.title}${g.status === 'active' ? '' : ' (не запущена)'}`, `hg:${g.id}`).row();
    return ctx.reply('Выберите игру:', { reply_markup: kb });
  }

  /** The linked staff member with a chosen game, or a prompt to link / choose. */
  async function needGame(ctx: any) {
    const s = await staffOfTelegram(db, ctx.from.id);
    if (!s) {
      await ctx.reply('Этот бот — для ведущих. Откройте кабинет ведущего на сайте банка и нажмите «Подключить Telegram».');
      return null;
    }
    if (!s.gameId) {
      await chooseGame(ctx, s);
      return null;
    }
    return s;
  }

  async function needRun(ctx: any, s: any) {
    if (await canRun(db, s.staffId, s.gameId)) return true;
    await ctx.reply('Это делает ведущий этой игры.');
    return false;
  }

  bot.command('start', async (ctx) => {
    states.delete(ctx.chat.id);
    const code = ctx.match?.trim();
    if (code) {
      try {
        const s = await linkByCode(db, code, ctx.from!.id);
        await ctx.reply(`Готово, ${s.name}! Этот Telegram подключён к кабинету ведущего.`);
      } catch (e: any) {
        return ctx.reply(e instanceof AppError ? e.message : 'Не удалось подключить.');
      }
    }
    const s = await staffOfTelegram(db, ctx.from!.id);
    if (!s) return ctx.reply('Этот бот — для ведущих. Откройте кабинет ведущего на сайте банка и нажмите «Подключить Telegram».');
    return chooseGame(ctx, s);
  });

  bot.command('help', (ctx) =>
    ctx.reply(
      'Бот ведущего игры.\n\n' +
      'Сводка — балансы компаний в текущем такте\nПереводы — последние операции\nНачислить / списать — деньги компании\n' +
      'Такт — завершить такт\nВыручка и OPEX — провести по таблице мощностей\n\n' +
      'Пришлите фото платёжки или договора — помощник разберёт его и предложит операцию. Можно спросить текстом или голосом: «сколько денег у Steam?».\n\n' +
      '/notify — уведомления об оплатах игротехнику вкл/выкл',
      { reply_markup: menu() },
    ));

  bot.callbackQuery(/^hg:(\d+)$/, async (ctx) => {
    const s = await staffOfTelegram(db, ctx.from.id);
    const gameId = Number(ctx.match[1]);
    if (!s || !(await gamesOf(db, s)).some((g) => g.id === gameId)) return ctx.answerCallbackQuery('Нет доступа к игре');
    await db.query('update staff_telegram set game_id = $2 where telegram_id = $1', [ctx.from.id, gameId]);
    await ctx.answerCallbackQuery();
    const [g] = await db.query('select title from game where id = $1', [gameId]);
    await ctx.editMessageText(`Игра: ${g.title}`);
    return ctx.reply('Что смотрим?', { reply_markup: menu() });
  });

  const changeGame = async (ctx: any) => {
    const s = await staffOfTelegram(db, ctx.from.id);
    return s ? chooseGame(ctx, s) : ctx.reply('Сначала подключите Telegram в кабинете ведущего.');
  };
  bot.command('game', changeGame);
  bot.hears(MENU.game, changeGame);

  bot.command('notify', async (ctx) => {
    const [r] = await db.query('update staff_telegram set notify = not notify where telegram_id = $1 returning notify', [ctx.from!.id]);
    return ctx.reply(r ? (r.notify ? 'Уведомления об оплатах игротехнику включены.' : 'Уведомления выключены.') : 'Telegram не подключён.');
  });

  // ----- Summary and transfers -----

  const showSummary = async (ctx: any) => {
    const s = await needGame(ctx);
    if (!s) return;
    const { tact, rows } = await summary(db, s.gameId);
    if (!tact) return ctx.reply('Игра ещё не запущена.');
    const players = rows.filter((r) => r.kind !== 'host');
    const lines = players.map((r) => `• ${esc(r.title)} — <b>${fmt(r.balanceEnd)}</b>${r.received || r.sent ? ` (+${fmt(r.received)} / −${fmt(r.sent)})` : ''}`);
    const total = players.reduce((a, r) => a + r.balanceEnd, 0);
    return ctx.reply(`<b>${esc(s.gameTitle)}</b> · такт ${tact.number}\n\n${lines.join('\n')}\n\nВсего у игроков: <b>${fmt(total)}</b>`,
      { parse_mode: 'HTML', reply_markup: menu() });
  };
  bot.command('summary', showSummary);
  bot.hears(MENU.summary, showSummary);

  const showTransfers = async (ctx: any) => {
    const s = await needGame(ctx);
    if (!s) return;
    const ops = (await listTransfers(db, s.gameId, {})).slice(0, 15);
    if (!ops.length) return ctx.reply('Переводов пока нет.');
    const lines = ops.map((o) => `${fmt(o.amount)} · ${esc(o.from_title)} → ${esc(o.to_title)} · ${KIND_LABEL[o.kind] ?? ''}${o.comment ? ` · ${esc(o.comment)}` : ''}`);
    return ctx.reply(`<b>Последние переводы</b>\n${lines.join('\n')}`, { parse_mode: 'HTML', reply_markup: menu() });
  };
  bot.command('transfers', showTransfers);
  bot.hears(MENU.transfers, showTransfers);

  // ----- Credit / debit: direction → company → amount → comment → confirm -----

  const adjust = async (ctx: any) => {
    const s = await needGame(ctx);
    if (!s || !(await needRun(ctx, s))) return;
    return ctx.reply('Что делаем?', { reply_markup: new InlineKeyboard().text('Начислить', 'ad:credit').text('Списать', 'ad:debit') });
  };
  bot.command('adjust', adjust);
  bot.hears(MENU.adjust, adjust);

  bot.callbackQuery(/^ad:(credit|debit)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const s = await needGame(ctx);
    if (!s) return;
    const list = await db.query("select id, kind, title, balance from account where game_id = $1 and kind <> 'host' order by kind, title", [s.gameId]);
    const kb = new InlineKeyboard();
    for (const a of list) kb.text(`${a.title} — ${fmt(a.balance)}`, `aa:${ctx.match[1]}:${a.id}`).row();
    return ctx.editMessageText(ctx.match[1] === 'credit' ? 'Кому начислить?' : 'С кого списать?', { reply_markup: kb });
  });

  bot.callbackQuery(/^aa:(credit|debit):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    states.set(ctx.chat!.id, { step: 'amount', dir: ctx.match[1] as 'credit' | 'debit', account: Number(ctx.match[2]) });
    const [a] = await db.query('select title from account where id = $1', [Number(ctx.match[2])]);
    return ctx.editMessageText(`${ctx.match[1] === 'credit' ? 'Начисление' : 'Списание'}: ${a?.title}\nВведите сумму.`);
  });

  bot.callbackQuery('ac:skip', async (ctx) => {
    await ctx.answerCallbackQuery();
    const st = states.get(ctx.chat!.id);
    if (st?.step === 'comment') return confirmAdjust(ctx, { ...st, comment: '' });
  });

  async function confirmAdjust(ctx: any, a: { dir: 'credit' | 'debit'; account: number; amount: number; comment: string }) {
    const key = randomUUID();
    states.set(ctx.chat.id, { step: 'confirm', key, ...a });
    const [acc] = await db.query('select title, balance from account where id = $1', [a.account]);
    return ctx.reply(
      `${a.dir === 'credit' ? 'Начислить' : 'Списать'} ${fmt(a.amount)}\nСчёт: ${acc.title} (сейчас ${fmt(acc.balance)})${a.comment ? `\nКомментарий: ${a.comment}` : ''}${a.dir === 'debit' ? '\n\nСписание может увести счёт в минус.' : ''}`,
      { reply_markup: new InlineKeyboard().text(a.dir === 'credit' ? 'Начислить' : 'Списать', `aok:${key}`).text('Отмена', 'hno') },
    );
  }

  bot.callbackQuery(/^aok:(.+)$/, async (ctx) => {
    const st = states.get(ctx.chat!.id);
    if (st?.step !== 'confirm' || st.key !== ctx.match[1]) return ctx.answerCallbackQuery('Операция уже обработана');
    await ctx.answerCallbackQuery();
    const s = await needGame(ctx);
    if (!s || !(await needRun(ctx, s))) return;
    states.delete(ctx.chat!.id);
    try {
      await hostAdjust(db, s.gameId, s.staffId, { accountId: st.account, direction: st.dir, amount: st.amount, comment: st.comment, idempotencyKey: `tg:${st.key}` });
      return ctx.editMessageText(`Готово: ${st.dir === 'credit' ? 'начислено' : 'списано'} ${fmt(st.amount)}.`);
    } catch (e: any) {
      return ctx.editMessageText(`Не получилось: ${e instanceof AppError ? e.message : 'ошибка сервера'}`);
    }
  });

  bot.callbackQuery('hno', async (ctx) => {
    states.delete(ctx.chat!.id);
    await ctx.answerCallbackQuery('Отменено');
    return ctx.editMessageText('Отменено.');
  });

  // ----- Tact -----

  const tact = async (ctx: any) => {
    const s = await needGame(ctx);
    if (!s) return;
    const [open] = await db.query('select number, started_at from tact where game_id = $1 and closed_at is null', [s.gameId]);
    if (!open) return ctx.reply('Игра ещё не запущена.');
    const kb = (await canRun(db, s.staffId, s.gameId)) ? new InlineKeyboard().text(`Завершить такт ${open.number}`, 'tc:ask') : undefined;
    return ctx.reply(`Идёт такт ${open.number}.`, { reply_markup: kb });
  };
  bot.command('tact', tact);
  bot.hears(MENU.tact, tact);

  bot.callbackQuery('tc:ask', async (ctx) => {
    await ctx.answerCallbackQuery();
    return ctx.editMessageText('Завершить такт? Балансы зафиксируются в слепке, сразу начнётся следующий такт, грузовики постареют, разовые технологии исчезнут.',
      { reply_markup: new InlineKeyboard().text('Завершить', 'tc:yes').text('Отмена', 'hno') });
  });

  bot.callbackQuery('tc:yes', async (ctx) => {
    await ctx.answerCallbackQuery();
    const s = await needGame(ctx);
    if (!s || !(await needRun(ctx, s))) return;
    try {
      const r = await closeTact(db, s.gameId, (tx, closed, next) => assets.ageAssets(tx, s.gameId, closed, next));
      return ctx.editMessageText(`Такт ${r.closed.number} завершён. Идёт такт ${r.next.number}.`);
    } catch (e: any) {
      return ctx.editMessageText(`Не получилось: ${e instanceof AppError ? e.message : 'ошибка сервера'}`);
    }
  });

  // ----- Revenue and OPEX from the capacity table -----

  const post = async (ctx: any) => {
    const s = await needGame(ctx);
    if (!s) return;
    let t;
    try { t = await assets.capacityTable(db, s.gameId); } catch { return ctx.reply('Игра ещё не запущена.'); }
    const pending = (kind: 'revenue' | 'opex') =>
      t.rows.filter((r) => (kind === 'revenue' ? r.postedRevenue : r.postedOpex) === null).reduce((a, r) => a + (kind === 'revenue' ? r.revenue : r.opex), 0);
    const served = Object.entries(t.totals.served).map(([u, v]) => `${fmt(v)} ${u}`).join(', ') || '0';
    const kb = new InlineKeyboard();
    if (await canRun(db, s.staffId, s.gameId)) {
      if (pending('revenue')) kb.text(`Начислить выручку ${fmt(pending('revenue'))}`, 'pp:revenue').row();
      if (pending('opex')) kb.text(`Списать OPEX ${fmt(pending('opex'))}`, 'pp:opex');
    }
    return ctx.reply(
      `Такт ${t.tact.number}\nОбслужено: ${served}\nВыручка: ${fmt(t.totals.revenue)}, OPEX: ${fmt(t.totals.opex)}\n\nОбслуженные часы и рейсы вписываются в кабинете, раздел «Мощности».`,
      { reply_markup: kb },
    );
  };
  bot.command('post', post);
  bot.hears(MENU.post, post);

  bot.callbackQuery(/^pp:(revenue|opex)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const s = await needGame(ctx);
    if (!s || !(await needRun(ctx, s))) return;
    try {
      const r = await assets.postTact(db, s.gameId, s.staffId, ctx.match[1] as 'revenue' | 'opex');
      return ctx.editMessageText(`${ctx.match[1] === 'revenue' ? 'Выручка начислена' : 'OPEX списан'}: ${r.count} компаний, ${fmt(r.total)}.`);
    } catch (e: any) {
      return ctx.editMessageText(`Не получилось: ${e instanceof AppError ? e.message : 'ошибка сервера'}`);
    }
  });

  // ----- AI assistant: photos, questions, voice -----

  async function download(fileId: string) {
    const file = await bot.api.getFile(fileId);
    const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
    if (!res.ok) throw new AppError('Не удалось скачать файл из Telegram');
    return Buffer.from(await res.arrayBuffer());
  }

  async function ask(ctx: any, s: any, input: assistant.ChatInput) {
    if (!claude) return ctx.reply('Помощник не настроен: на сервере нужен ANTHROPIC_API_KEY.');
    const thinking = await ctx.reply('Помощник думает…');
    const before = new Set((await db.query(
      'select p.id from assistant_proposal p join assistant_thread t on t.id = p.thread_id where t.staff_id = $1 and t.game_id = $2',
      [s.staffId, s.gameId],
    )).map((r) => r.id));
    try {
      const view = await assistant.chat(db, claude, s.gameId, s.staffId, input);
      const last = [...view.messages].reverse().find((m: any) => m.role === 'assistant');
      await ctx.api.editMessageText(ctx.chat.id, thinking.message_id, (last?.text || 'Готово.').slice(0, 4000));
      for (const p of view.proposals.filter((x: any) => !before.has(x.id) && x.status === 'pending')) {
        await ctx.reply(
          `Операция: ${p.from} → ${p.to}, ${fmt(p.amount)}${p.priceItem ? ` (${p.priceItem})` : ''}${p.comment ? `\n${p.comment}` : ''}${p.sourceNote ? `\nНа бумажке: ${p.sourceNote}` : ''}`,
          { reply_markup: new InlineKeyboard().text('Провести', `pr:ok:${p.id}`).text('Отклонить', `pr:no:${p.id}`) },
        );
      }
    } catch (e: any) {
      await ctx.api.editMessageText(ctx.chat.id, thinking.message_id, e instanceof AppError ? e.message : 'Помощник сейчас недоступен.');
    }
  }

  bot.callbackQuery(/^pr:(ok|no):(\d+)$/, async (ctx) => {
    const s = await needGame(ctx);
    if (!s) return ctx.answerCallbackQuery();
    const id = Number(ctx.match[2]);
    const [p] = await db.query(
      'select p.game_id, t.staff_id from assistant_proposal p join assistant_thread t on t.id = p.thread_id where p.id = $1', [id]);
    if (!p || p.staff_id !== s.staffId || !(await canRun(db, s.staffId, p.game_id))) return ctx.answerCallbackQuery('Нет доступа');
    await ctx.answerCallbackQuery();
    try {
      if (ctx.match[1] === 'ok') {
        await assistant.confirmProposal(db, id, s.staffId);
        return ctx.editMessageText(`${ctx.callbackQuery.message?.text ?? ''}\n\nПроведено.`);
      }
      await assistant.rejectProposal(db, id);
      return ctx.editMessageText(`${ctx.callbackQuery.message?.text ?? ''}\n\nОтклонено.`);
    } catch (e: any) {
      return ctx.reply(`Не получилось: ${e instanceof AppError ? e.message : 'ошибка сервера'}`);
    }
  });

  bot.on('message:photo', async (ctx) => {
    const s = await needGame(ctx);
    if (!s) return;
    const photo = ctx.message.photo.at(-1)!;
    const data = (await download(photo.file_id)).toString('base64');
    return ask(ctx, s, { text: ctx.message.caption ?? '', image: { mediaType: 'image/jpeg', data } });
  });

  bot.on(['message:voice', 'message:audio'], async (ctx) => {
    const s = await needGame(ctx);
    if (!s) return;
    if (!transcriptionEnabled()) return ctx.reply('Расшифровка голосовых не настроена на сервере. Напишите вопрос текстом.');
    const file = ctx.message.voice ?? ctx.message.audio!;
    try {
      const text = await transcribe(await download(file.file_id), file.mime_type ?? 'audio/ogg', 'voice.ogg');
      await ctx.reply(`Распознано: ${text}`);
      return ask(ctx, s, { text });
    } catch (e: any) {
      return ctx.reply(e instanceof AppError ? e.message : 'Не удалось расшифровать.');
    }
  });

  bot.on('message:text', async (ctx) => {
    const st = states.get(ctx.chat.id);
    const text = ctx.message.text.trim();
    if (st?.step === 'amount') {
      const n = Number(text.replace(/\s/g, ''));
      if (!Number.isInteger(n) || n <= 0) return ctx.reply('Сумма — целое число больше нуля.');
      states.set(ctx.chat.id, { step: 'comment', dir: st.dir, account: st.account, amount: n });
      return ctx.reply('Комментарий (за что)?', { reply_markup: new InlineKeyboard().text('Без комментария', 'ac:skip') });
    }
    if (st?.step === 'comment') return confirmAdjust(ctx, { dir: st.dir, account: st.account, amount: st.amount, comment: text.slice(0, 500) });
    if (st?.step === 'confirm') return ctx.reply('Подтвердите или отмените операцию кнопками выше.');
    const s = await needGame(ctx);
    if (s) return ask(ctx, s, { text });
  });

  bot.catch((err) => console.error('telegram host bot', err.error));

  // ----- Alerts: players paying the game master -----

  transferEvents.on('transfer', async (t: any) => {
    if (t.kind !== 'to_host' && t.kind !== 'fixed_price') return;
    try {
      const chats = await db.query('select telegram_id from staff_telegram where game_id = $1 and notify', [t.game_id]);
      if (!chats.length) return;
      const [from] = await db.query('select title from account where id = $1', [t.from_account_id]);
      const text = `Оплата игротехнику <b>+${fmt(t.amount)}</b> от «${esc(from?.title)}»${t.comment ? `\n${esc(t.comment)}` : ''}`;
      for (const c of chats) await bot.api.sendMessage(Number(c.telegram_id), text, { parse_mode: 'HTML' }).catch(() => {});
    } catch (e) {
      console.error('telegram host notify', e);
    }
  });

  return bot;
}

export async function startHostBot(db: Db) {
  const token = hostBotToken();
  if (!token) return null;
  const bot = createHostBot(db, token);
  try {
    username = (await bot.api.getMe()).username;
    await bot.api.setMyCommands([
      { command: 'start', description: 'Выбрать игру' },
      { command: 'summary', description: 'Сводка по компаниям' },
      { command: 'transfers', description: 'Последние переводы' },
      { command: 'adjust', description: 'Начислить / списать' },
      { command: 'tact', description: 'Такт' },
      { command: 'post', description: 'Выручка и OPEX' },
      { command: 'game', description: 'Сменить игру' },
      { command: 'notify', description: 'Уведомления вкл/выкл' },
      { command: 'help', description: 'Помощь' },
    ]);
    await bot.api.setMyShortDescription('Бот ведущего: сводка, начисления, такты и ИИ-помощник по фото платёжек.');
    await bot.api.setMyDescription(
      'Бот для ведущих (игротехников) игрового банка.\n\nПодключается из кабинета ведущего кнопкой «Подключить Telegram». ' +
      'Сводка, переводы, начисления и списания, завершение такта, выручка и OPEX, ИИ-помощник: фото платёжки → операция на подтверждение.',
    );
  } catch (e: any) {
    console.error('telegram host configure', e?.description ?? e);
  }
  bot.start({ onStart: (me) => { username = me.username; console.log(`Telegram-бот ведущих запущен: @${me.username}`); } })
    .catch((e) => console.error('telegram host polling', e?.description ?? e));
  return bot;
}

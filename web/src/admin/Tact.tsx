import { useState } from 'react';
import { api, dateTime, money, useLoad } from '../api';
import { TactClock, clock, useLeft } from '../TactTimer';
import { Confirm, Empty, ErrorText } from '../ui';
import type { Ctx } from './GamePage';

/** The game is planned for three tacts; later ones are extra. */
const PLANNED = 3;
/** A tact lasts up to 30 minutes. */
const MAX = 30;

interface Totals { money: number; income: number; expenses: number }

/**
 * "Такт": all planned tacts at once, starting and ending the current one, and its countdown.
 * After a tact ends, transfers go to the next one; after the third an extra tact is created.
 */
export function TactPage({ ctx }: { ctx: Ctx }) {
  const tacts = ctx.tacts as (TactClock & { id: number; started_at: string })[];
  const open = tacts.find((t) => !t.closed_at);
  const [minutes, setMinutes] = useState(15);
  const [finish, setFinish] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const left = useLeft(open?.ends_at);
  const totals = useLoad(async () => {
    const all = await Promise.all(tacts.map(async (t) => {
      const [s, c] = await Promise.all([
        api<{ rows: any[] }>(`/api/admin/games/${ctx.id}/summary?tact=${t.id}`),
        api<{ rows: any[] }>(`/api/admin/games/${ctx.id}/capacity?tact=${t.id}`),
      ]);
      const players = s.rows.filter((r) => r.kind !== 'host');
      return [t.id, {
        money: players.reduce((x, r) => x + r.balanceEnd, 0),
        income: c.rows.reduce((x, r) => x + r.revenue, 0),
        expenses: c.rows.reduce((x, r) => x + r.opex, 0),
      }] as const;
    }));
    return new Map<number, Totals>(all);
  }, [ctx.id, ctx.tick, tacts.length]);

  if (ctx.d.game.status === 'draft') return <Empty>Такты начнутся после запуска игры</Empty>;
  const can = ctx.d.can.run;
  const cards = [
    ...tacts,
    ...Array.from({ length: Math.max(0, PLANNED - tacts.length) }, (_, i) => ({ id: -1 - i, number: tacts.length + i + 1, begun_at: null, ends_at: null, closed_at: null, future: true })),
  ];

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try { await fn(); ctx.reload(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const start = () => act(() => api(`/api/admin/games/${ctx.id}/tact/start`, { body: { minutes } }));
  const setTimer = (m: number) => act(() => api(`/api/admin/games/${ctx.id}/tact/timer`, { method: 'PUT', body: { minutes: m } }));
  // Not through `act`: the button stays clickable, so several clicks add several minutes.
  const addMinute = () => api(`/api/admin/games/${ctx.id}/tact/add-minute`, { body: {} }).then(ctx.reload, (e) => setError(e.message));
  const end = () => act(async () => { await api(`/api/admin/games/${ctx.id}/close-tact`, { body: {} }); setFinish(false); });
  const pending = open ? totals.data?.get(open.id) : undefined;

  return (
    <div className="stack">
      {open && (
        <section className="panel tact-now">
          <div className="row between">
            <div>
              <div className="tact-now-title">
                {open.number} такт{open.number > PLANNED ? ' · дополнительный' : ''}
              </div>
              <div className="small muted">
                {open.begun_at ? `Идёт с ${dateTime(open.begun_at)}` : 'Ещё не начат: переводы уже записываются в этот такт'}
              </div>
            </div>
            {left !== null && (
              <div className="tact-now-clock-box">
                <div className={`tact-now-clock${left === 0 ? ' over' : left < 60_000 ? ' soon' : ''}`}>{left === 0 ? 'Время вышло' : clock(left)}</div>
                {can && <button className="round-plus" onClick={addMinute} aria-label="Добавить минуту" title="Добавить минуту">+</button>}
              </div>
            )}
          </div>

          {can && (
            <>
              <div className="timer-pick">
                <label className="field-label" htmlFor="tact-minutes">Таймер</label>
                <div className="slider-box" style={{ ['--fill' as any]: `${(minutes / MAX) * 100}%` }}>
                  <span className="slider-value" aria-hidden="true">{minutes ? `${minutes} мин` : 'без таймера'}</span>
                  <input type="range" className="slider" min={0} max={MAX} step={1} value={minutes} aria-label="Минут на такт, до 30"
                    onChange={(e) => setMinutes(Number(e.target.value))} />
                </div>
                <input id="tact-minutes" className="cell-input minutes-input" inputMode="numeric" value={minutes || ''} placeholder="0"
                  aria-label="Минут, вписать числом" onChange={(e) => setMinutes(Math.min(MAX, Number(e.target.value.replace(/\D/g, '') || 0)))} />
                <button type="button" className="round-plus small" onClick={() => setMinutes((m) => Math.min(MAX, m + 1))} aria-label="Ещё минута">+</button>
              </div>
              <div className="row">
                {!open.begun_at
                  ? <button className="btn primary" disabled={busy} onClick={start}>Начать {open.number} такт</button>
                  : <button className="btn primary" disabled={busy} onClick={() => setFinish(true)}>Закончить {open.number} такт</button>}
                {open.begun_at && (
                  <span className="row" style={{ gap: 4 }}>
                    <button className="link-btn" disabled={busy || !minutes} onClick={() => setTimer(minutes)}>{open.ends_at ? 'Таймер заново' : 'Поставить таймер'}</button>
                    {open.ends_at && <button className="link-btn" disabled={busy} onClick={() => setTimer(0)}>Убрать таймер</button>}
                  </span>
                )}
              </div>
            </>
          )}
          <ErrorText error={error} />
        </section>
      )}

      <div className="tact-cards">
        {cards.map((t) => {
          const total = 'future' in t ? undefined : totals.data?.get(t.id);
          const status = 'future' in t ? 'впереди' : t.closed_at ? 'завершён' : t.begun_at ? 'идёт' : 'не начат';
          return (
            <section key={t.id} className={`panel tact-card${t.id === open?.id ? ' current' : ''}`}>
              <div className="row between">
                <h3 style={{ margin: 0 }}>{t.number} такт</h3>
                <span className={status === 'идёт' ? 'chip accent' : 'chip'}>{status}</span>
              </div>
              {t.number > PLANNED && <div className="tiny muted">дополнительный, после трёх тактов игры</div>}
              <div className="tact-card-lines small">
                {t.begun_at && <div><span className="muted">Начат</span> {dateTime(t.begun_at)}</div>}
                {t.closed_at && <div><span className="muted">Закончен</span> {dateTime(t.closed_at)}</div>}
                {total && (
                  <>
                    <div><span className="muted">Доходы</span> {money(total.income)}</div>
                    <div><span className="muted">Расходы</span> {money(total.expenses)}</div>
                    <div><span className="muted">{t.closed_at ? 'Деньги у всех на конец' : 'Деньги у всех сейчас'}</span> <strong>{money(total.money)}</strong></div>
                  </>
                )}
              </div>
            </section>
          );
        })}
      </div>

      {finish && open && (
        <Confirm title={`Закончить ${open.number} такт?`} busy={busy} error={error} confirmText="Закончить" onCancel={() => setFinish(false)} onConfirm={end}>
          <div className="summary-line"><span className="muted">Начислятся доходы</span><span>+{money(pending?.income ?? 0)}</span></div>
          <div className="summary-line"><span className="muted">Спишутся затраты на мощности</span><span>−{money(pending?.expenses ?? 0)}</span></div>
          <p className="small muted">
            Балансы зафиксируются. Дальше переводы пойдут в {open.number + 1} такт
            {open.number >= PLANNED ? ' — он будет дополнительным' : ''}; начните его кнопкой «Начать такт».
          </p>
        </Confirm>
      )}
    </div>
  );
}

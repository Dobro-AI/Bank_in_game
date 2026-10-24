import { useEffect, useState } from 'react';

export interface TactClock { number: number; begun_at: string | null; ends_at: string | null; closed_at?: string | null }

const two = (n: number) => String(n).padStart(2, '0');

/** "12:34" or "1:02:03" for the time left. */
export const clock = (ms: number) => {
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
};

/** Milliseconds left on the tact's countdown, ticking; `offset` corrects a device clock that runs off the server's. */
export function useLeft(endsAt: string | null | undefined, offset = 0) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!endsAt) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [endsAt]);
  return endsAt ? Math.max(0, new Date(endsAt).getTime() - (now + offset)) : null;
}

/** The countdown in the top-right corner of every screen, for game masters and players alike. */
export function TactTimer({ tact, offset = 0 }: { tact: TactClock | null | undefined; offset?: number }) {
  const left = useLeft(tact && !tact.closed_at ? tact.ends_at : null, offset);
  if (!tact || left === null) return null;
  const state = left === 0 ? ' over' : left < 60_000 ? ' soon' : '';
  return (
    <div className={`tact-timer${state}`} role="timer" aria-label={`Такт ${tact.number}: ${left === 0 ? 'время вышло' : `осталось ${clock(left)}`}`}>
      <span className="tact-timer-label">Такт {tact.number}</span>
      <span className="tact-timer-time">{left === 0 ? 'Время вышло' : clock(left)}</span>
    </div>
  );
}

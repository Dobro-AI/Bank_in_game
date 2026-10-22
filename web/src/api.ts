import { useCallback, useEffect, useRef, useState } from 'react';

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) throw new ApiError(data?.error ?? `Ошибка ${res.status}`, res.status);
  return data as T;
}

export const newKey = () => crypto.randomUUID();

/** Loads data and reloads it on demand; keeps previous data while reloading. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const reload = useCallback(() => {
    fnRef.current().then((d) => { setData(d); setError(undefined); }, (e) => setError(e.message));
  }, []);
  useEffect(reload, deps);
  return { data, error, reload };
}

/** Server-sent "changed" events for a game: balances update without refreshing the page. */
export function useLive(gameId: number | undefined, onChange: () => void) {
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    if (!gameId) return;
    const es = new EventSource(`/api/stream/${gameId}`);
    es.addEventListener('changed', () => cb.current());
    return () => es.close();
  }, [gameId]);
}

export const money = (n: number) => new Intl.NumberFormat('ru-RU').format(n);
export const dateTime = (s: string) =>
  new Date(s).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });

export const KIND_LABEL: Record<string, string> = {
  player: 'Перевод', to_host: 'Игротехнику', fixed_price: 'По прайсу',
  host_credit: 'Начисление', host_debit: 'Списание', initial: 'Стартовый баланс',
};
export const ACCOUNT_KIND: Record<string, string> = { legal: 'Юрлицо', individual: 'Физлицо', host: 'Игротехник' };

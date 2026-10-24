import { money } from './api';

export interface Results {
  tacts: { number: number; status: 'closed' | 'running' | 'waiting' | 'future'; extra: boolean }[];
  rows: { accountId: number; title: string; owner: string; values: (number | null)[] }[];
}

const STATUS: Record<Results['tacts'][number]['status'], string> = { closed: 'завершён', running: 'идёт', waiting: 'не начат', future: 'впереди' };

/**
 * "Итоги тактов": each company's balance after every tact (column E of "Счета"), shown to everyone.
 * Companies go by their latest result; the current tact updates live.
 */
export function ResultsBoard({ data }: { data: Results }) {
  const latest = (r: Results['rows'][number]) => [...r.values].reverse().find((v) => v !== null) ?? null;
  const rows = [...data.rows].sort((a, b) => (latest(b) ?? -Infinity) - (latest(a) ?? -Infinity) || a.title.localeCompare(b.title, 'ru'));
  const current = data.tacts.findIndex((t) => t.status === 'running' || t.status === 'waiting');

  if (!rows.length) return <p className="muted">Итоги появятся после запуска игры</p>;
  return (
    <div className="results">
      <div className="results-head" style={{ ['--cols' as any]: data.tacts.length }}>
        <span />
        <span className="results-company">Компания</span>
        {data.tacts.map((t, i) => (
          <span key={t.number} className={`results-tact${i === current ? ' current' : ''}`}>
            {t.number} такт
            <small>{t.extra ? 'доп. · ' : ''}{STATUS[t.status]}</small>
          </span>
        ))}
      </div>
      <ol className="results-list">
        {rows.map((r, place) => (
          <li key={r.accountId} className="results-row" style={{ ['--cols' as any]: data.tacts.length }}>
            <span className={`results-place${place === 0 ? ' first' : ''}`} aria-label={`${place + 1} место`}>{place + 1}</span>
            <span className="results-company">
              <strong>{r.title}</strong>
              {r.owner && r.owner !== r.title && <small>{r.owner}</small>}
            </span>
            {r.values.map((v, i) => {
              const prev = i > 0 ? r.values[i - 1] : null;
              const delta = v !== null && prev !== null ? v - prev : null;
              return (
                <span key={i} className={`results-value${i === current ? ' current' : ''}${v !== null && v < 0 ? ' negative' : ''}`}>
                  {v === null ? <span className="muted">—</span> : money(v)}
                  {delta !== null && delta !== 0 && (
                    <small className={delta > 0 ? 'up' : 'down'}>{delta > 0 ? '▲' : '▼'} {money(Math.abs(delta))}</small>
                  )}
                </span>
              );
            })}
          </li>
        ))}
      </ol>
      <p className="tiny muted">Остаток на счёте после такта. Текущий такт обновляется сам: доходы уже учтены, расходы на мощности — те, что спишутся в конце.</p>
    </div>
  );
}

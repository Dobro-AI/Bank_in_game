import { Fragment } from 'react';
import { money } from './api';

type Cell = { income: number; expenses: number; total: number } | null;
export interface Results {
  tacts: { number: number; status: 'closed' | 'running' | 'waiting' | 'future'; extra: boolean }[];
  rows: { accountId: number; title: string; owner: string; values: Cell[] }[];
}

const STATUS: Record<Results['tacts'][number]['status'], string> = { closed: 'завершён', running: 'идёт', waiting: 'не начат', future: 'впереди' };

/**
 * "Итоги тактов", shown to everyone: per company and tact — income, expenses and the balance after
 * the tact (column E of "Счета"). Companies go by their latest result; the current tact is live.
 */
export function ResultsBoard({ data }: { data: Results }) {
  const latest = (r: Results['rows'][number]) => [...r.values].reverse().find((v) => v !== null)?.total ?? null;
  const rows = [...data.rows].sort((a, b) => (latest(b) ?? -Infinity) - (latest(a) ?? -Infinity) || a.title.localeCompare(b.title, 'ru'));
  const current = data.tacts.findIndex((t) => t.status === 'running' || t.status === 'waiting');

  if (!rows.length) return <p className="muted">Итоги появятся после запуска игры</p>;
  return (
    <div className="results-wrap">
      <table className="results">
        <thead>
          <tr>
            <th rowSpan={2} className="results-place-h" aria-label="Место" />
            <th rowSpan={2} className="results-company">Компания</th>
            {data.tacts.map((t, i) => (
              <th key={t.number} colSpan={3} className={`results-tact${i === current ? ' current' : ''}`}>
                {t.number} такт <small>{t.extra ? 'доп. · ' : ''}{STATUS[t.status]}</small>
              </th>
            ))}
          </tr>
          <tr>
            {data.tacts.map((t, i) => (
              <Fragment key={t.number}>
                <th className={`results-sub${i === current ? ' current' : ''}`}>Доход</th>
                <th className={`results-sub${i === current ? ' current' : ''}`}>Затраты</th>
                <th className={`results-sub total${i === current ? ' current' : ''}`}>Итог</th>
              </Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, place) => (
            <tr key={r.accountId}>
              <td><span className={`results-place${place === 0 ? ' first' : ''}`} aria-label={`${place + 1} место`}>{place + 1}</span></td>
              <td className="results-company">
                <strong>{r.title}</strong>
                {r.owner && r.owner !== r.title && <small>{r.owner}</small>}
              </td>
              {r.values.map((v, i) => {
                const cur = i === current ? ' current' : '';
                if (!v) return <td key={i} colSpan={3} className={`results-empty${cur}`}>—</td>;
                return (
                  <Fragment key={i}>
                    <td className={`results-num ${v.income ? 'income' : 'zero'}${cur}`}>{v.income ? `+${money(v.income)}` : '0'}</td>
                    <td className={`results-num ${v.expenses ? 'expenses' : 'zero'}${cur}`}>{v.expenses ? `−${money(v.expenses)}` : '0'}</td>
                    <td className={`results-num total${cur}${v.total < 0 ? ' negative' : ''}`}>{money(v.total)}</td>
                  </Fragment>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="tiny muted">Доход — заработок за такт и полученные переводы. Затраты — расходы на мощности и отправленные переводы. Итог — остаток на счёте после такта; текущий такт показан таким, каким он будет после его окончания.</p>
    </div>
  );
}

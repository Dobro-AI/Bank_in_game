import { api, money, useLoad } from '../api';
import { ErrorText } from '../ui';
import { ScreenHeader } from './Screen';

interface View {
  tact: { number: number; closed: boolean };
  companies: {
    accountId: number; title: string; expenses: number;
    assets: { code: string; title: string; quantity: number; expenses: number; opexPerUnit: number; capacity: number; unit: string }[];
  }[];
}

/** "Мощности" for a player: their companies' assets in the current tact — quantity, expenses, capacity. */
export function PlayerCapacity({ tick }: { tick: number }) {
  const v = useLoad(() => api<View>('/api/player/capacity'), [tick]);
  return (
    <>
      <ScreenHeader title="Мощности" />
      <ErrorText error={v.error} />
      {v.data && (
        <>
          <p className="muted small" style={{ marginTop: 0 }}>Такт {v.data.tact.number}. Расходы спишутся со счёта, когда такт закончится.</p>
          {!v.data.companies.some((c) => c.assets.length) && <p className="muted">У ваших компаний нет мощностей</p>}
          {v.data.companies.filter((c) => c.assets.length).map((c) => (
            <section key={c.accountId} className="cap-card">
              <div className="cap-head">
                <strong>{c.title}</strong>
                <span className="cap-total">Расходы за такт <b>{c.expenses ? `−${money(c.expenses)}` : '0'}</b></span>
              </div>
              {c.assets.length === 0 ? <p className="muted small">Мощностей нет</p> : (
                <table className="cap-table">
                  <thead><tr><th>Актив</th><th>Кол-во</th><th>Расходы</th><th>Мощность</th></tr></thead>
                  <tbody>
                    {c.assets.map((a) => (
                      <tr key={a.code}>
                        <td>{a.title}</td>
                        <td className="num"><b>{money(a.quantity)}</b></td>
                        <td className="num expenses" title={`${a.quantity} × ${a.opexPerUnit}`}>{a.expenses ? `−${money(a.expenses)}` : '0'}</td>
                        <td className="num power">{a.unit ? <>{money(a.capacity)}<small> {a.unit}</small></> : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          ))}
        </>
      )}
    </>
  );
}

import { FormEvent, useEffect, useState } from 'react';
import { api, money, newKey, useLoad } from '../api';
import { Select } from '../Select';
import { Confirm, Empty, ErrorText, Field, Money as Amount } from '../ui';
import { Ledger, OutputInput } from './Capacity';
import type { Ctx } from './GamePage';

const EARNED = '__earned';

interface AssetCell { code: string; title: string; unit: string; start: number; change: number; end: number; capacity: number; capacityUnit: string; output: number }
interface CapRow {
  accountId: number; title: string; kind: string; balance: number; owner: string; assets: AssetCell[];
  earned: number; revenue: number; opex: number; result: number; revenueText: string; opexText: string;
  postedRevenue: number | null; postedOpex: number | null;
}
interface SumRow { accountId: number; balanceStart: number; received: number; sent: number; balanceEnd: number }
interface CapTable { tact: any; types: any[]; rows: CapRow[] }

// Legal entities first: in these games each role plays a company.
const companies = (rows: CapRow[]) =>
  [...rows].sort((a, b) => (a.kind === b.kind ? a.title.localeCompare(b.title, 'ru') : a.kind === 'legal' ? -1 : 1));
/** What the balance becomes once the tact ends: unposted earnings credited, unposted expenses subtracted. */
const afterTact = (r: CapRow) => r.balance + (r.revenue - (r.postedRevenue ?? 0)) - (r.opex - (r.postedOpex ?? 0));

/** One tact picker for both sections: the current tact or a finished one. */
function useTact(ctx: Ctx) {
  const [tactId, setTactId] = useState<number>();
  const q = tactId ? `?tact=${tactId}` : '';
  const cap = useLoad(() => api<CapTable>(`/api/admin/games/${ctx.id}/capacity${q}`), [ctx.id, q, ctx.tick]);
  const picker = (
    <div style={{ minWidth: 200 }}>
      <Select value={tactId ? String(tactId) : ''} onChange={(v) => setTactId(Number(v) || undefined)} ariaLabel="Такт"
        options={[{ value: '', label: `Текущий такт ${ctx.tacts.find((t) => !t.closed_at)?.number ?? ''}` },
          ...ctx.tacts.filter((t) => t.closed_at).map((t) => ({ value: String(t.id), label: `Такт ${t.number}`, sub: 'завершён' }))]} />
    </div>
  );
  return { q, cap, picker };
}

/**
 * "Деньги": per company and tact — money at the start, what came in and went out, the balance (typed
 * in to correct it), and what it becomes when the tact ends. Money moves from here; the tact ends here.
 */
export function Money({ ctx }: { ctx: Ctx }) {
  const { q, cap, picker } = useTact(ctx);
  const sum = useLoad(() => api<{ rows: SumRow[] }>(`/api/admin/games/${ctx.id}/summary${q}`), [ctx.id, q, ctx.tick]);
  const [moneyFor, setMoneyFor] = useState<CapRow>();
  const [finish, setFinish] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  if (ctx.d.game.status === 'draft') return <Empty>Деньги появятся после запуска игры</Empty>;
  if (!cap.data || !sum.data) return <ErrorText error={cap.error || sum.error} />;
  const tact = cap.data.tact;
  const open = !tact.closed_at;
  const editable = open && ctx.d.can.run;
  const bySum = new Map(sum.data.rows.map((r) => [r.accountId, r]));
  const rows = companies(cap.data.rows);
  const pending = rows.reduce((t, r) => ({ earned: t.earned + r.revenue - (r.postedRevenue ?? 0), opex: t.opex + r.opex - (r.postedOpex ?? 0) }), { earned: 0, opex: 0 });
  const totals = rows.reduce((t, r) => {
    const s = bySum.get(r.accountId);
    return { start: t.start + (s?.balanceStart ?? 0), in: t.in + (s?.received ?? 0), out: t.out + (s?.sent ?? 0),
      end: t.end + (s?.balanceEnd ?? 0), after: t.after + afterTact(r) };
  }, { start: 0, in: 0, out: 0, end: 0, after: 0 });
  const reload = () => { cap.reload(); sum.reload(); };

  async function doFinish() {
    setBusy(true);
    setError(undefined);
    try {
      await api(`/api/admin/games/${ctx.id}/close-tact`, { body: {} });
      setFinish(false);
      ctx.reload();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }

  return (
    <>
      <div className="row between" style={{ marginBottom: 12 }}>
        <div className="row">
          {picker}
          {editable && <button className="btn primary" onClick={() => setFinish(true)}>Завершить такт {tact.number}</button>}
        </div>
        <span className="small muted">
          {open ? 'При завершении такта заработок начислится, а расходы на мощности спишутся с каждой компании сами.' : 'Такт завершён: суммы зафиксированы.'}
        </span>
      </div>
      <ErrorText error={error} />

      <div className="table-wrap">
        <table className="calc">
          <thead>
            <tr>
              <th>Компания</th><th className="num">На начало</th><th className="num">Пришло</th><th className="num">Ушло</th>
              <th className="num">Остаток</th>{open && <th className="num">После такта</th>}<th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const s = bySum.get(r.accountId);
              const end = s?.balanceEnd ?? 0;
              return (
                <tr key={r.accountId}>
                  <td><strong>{r.title}</strong><div className="tiny muted">{r.owner}</div></td>
                  <td className="num"><Amount value={s?.balanceStart ?? 0} /></td>
                  <td className="num">{s?.received ? <span className="in"><Amount value={s.received} signed /></span> : '—'}</td>
                  <td className="num">{s?.sent ? <Amount value={-s.sent} signed /> : '—'}</td>
                  <td className="num">
                    {editable
                      ? <BalanceInput key={`${r.accountId}:${end}`} ctx={ctx} accountId={r.accountId} title={r.title} value={end} onSaved={reload} />
                      : <strong><Amount value={end} /></strong>}
                  </td>
                  {open && (
                    <td className="num">
                      <Amount value={afterTact(r)} />
                      {afterTact(r) !== r.balance && (
                        <div className="tiny muted">
                          {r.revenue - (r.postedRevenue ?? 0) ? `+${money(r.revenue - (r.postedRevenue ?? 0))} заработок` : ''}
                          {r.opex - (r.postedOpex ?? 0) ? ` −${money(r.opex - (r.postedOpex ?? 0))} расходы` : ''}
                        </div>
                      )}
                    </td>
                  )}
                  <td>{ctx.d.can.run && open && <button className="btn small" onClick={() => setMoneyFor(r)}>Деньги</button>}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td>Сумма у всех</td><td className="num"><Amount value={totals.start} /></td><td className="num"><Amount value={totals.in} /></td>
              <td className="num"><Amount value={-totals.out} signed /></td><td className="num"><Amount value={totals.end} /></td>
              {open && <td className="num"><Amount value={totals.after} /></td>}<td></td>
            </tr>
          </tfoot>
        </table>
      </div>

      {moneyFor && <MoneyDialog ctx={ctx} row={moneyFor} onClose={() => setMoneyFor(undefined)} onDone={() => { setMoneyFor(undefined); ctx.reload(); reload(); }} />}
      {finish && (
        <Confirm title={`Завершить такт ${tact.number}?`} busy={busy} error={error} confirmText="Завершить" onCancel={() => setFinish(false)} onConfirm={doFinish}>
          <div className="summary-line"><span className="muted">Начислится заработок</span><Amount value={pending.earned} /></div>
          <div className="summary-line"><span className="muted">Спишутся расходы</span><Amount value={-pending.opex} signed /></div>
          <p className="small muted">Заработок и расходы — в разделе «Мощности». Балансы зафиксируются, начнётся такт {tact.number + 1}.</p>
        </Confirm>
      )}
    </>
  );
}

/**
 * "Мощности": what each company has this tact (editable), hours or trips served, money earned typed in by
 * the host, expenses by formula and the tact's result. Any finished tact can be looked at.
 */
export function Capacities({ ctx }: { ctx: Ctx }) {
  const { cap, picker } = useTact(ctx);
  const [journal, setJournal] = useState<number>();

  if (ctx.d.game.status === 'draft') return <Empty>Мощности появятся после запуска игры</Empty>;
  if (!cap.data) return <ErrorText error={cap.error} />;
  const tact = cap.data.tact;
  const editable = !tact.closed_at && ctx.d.can.run;
  const rows = companies(cap.data.rows);
  const totals = rows.reduce((t, r) => ({ earned: t.earned + r.revenue, opex: t.opex + r.opex }), { earned: 0, opex: 0 });

  return (
    <>
      <div className="row between" style={{ marginBottom: 12 }}>
        {picker}
        <span className="small muted">
          {editable ? 'Заработок начислится, а расходы спишутся, когда такт завершат в разделе «Деньги».' : 'Такт завершён: суммы зафиксированы.'}
        </span>
      </div>
      <div className="table-wrap">
        <table className="calc">
          <thead>
            <tr>
              <th>Компания</th><th>Мощности</th><th>Обслужено</th><th className="num">Заработали</th>
              <th className="num">Расходы</th><th className="num">Итог такта</th><th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.accountId}>
                <td><strong>{r.title}</strong><div className="tiny muted">{r.owner}</div></td>
                <td><Assets ctx={ctx} row={r} types={cap.data!.types} editable={editable} onChanged={cap.reload} /></td>
                <td>
                  {r.assets.filter((a) => a.capacityUnit && a.end + a.output > 0).map((a) => (
                    <OutputInput key={a.code} ctx={ctx} tactId={tact.id} accountId={r.accountId} cell={a} editable={editable} onSaved={cap.reload} />
                  ))}
                </td>
                <td className="num">
                  {editable ? <Earned ctx={ctx} tactId={tact.id} row={r} onSaved={cap.reload} /> : <Amount value={r.earned} />}
                  {r.revenue !== r.earned && <div className="tiny muted formula">+ с мощностей {money(r.revenue - r.earned)}</div>}
                </td>
                <td className="num">
                  {r.opex ? <Amount value={-r.opex} signed /> : '—'}
                  {r.opexText && <div className="tiny muted formula">{r.opexText}</div>}
                </td>
                <td className="num"><strong><Amount value={r.result} signed /></strong></td>
                <td><button className="btn small" onClick={() => setJournal(journal === r.accountId ? undefined : r.accountId)}>{journal === r.accountId ? 'Все' : 'Журнал'}</button></td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>Итого</td><td></td><td></td><td className="num"><Amount value={totals.earned} /></td>
              <td className="num"><Amount value={-totals.opex} signed /></td><td className="num"><Amount value={totals.earned - totals.opex} signed /></td><td></td>
            </tr>
          </tfoot>
        </table>
      </div>
      <Ledger ctx={ctx} accountId={journal} onClose={() => setJournal(undefined)} onChanged={cap.reload} />
    </>
  );
}

/** The balance typed in directly: the difference is credited or debited by the host. */
function BalanceInput({ ctx, accountId, title, value, onSaved }: { ctx: Ctx; accountId: number; title: string; value: number; onSaved: () => void }) {
  const [v, setV] = useState(String(value));
  const [error, setError] = useState<string>();
  async function save() {
    if (v === '' || v === '-' || Number(v) === value) { setV(String(value)); return; }
    try {
      await api(`/api/admin/games/${ctx.id}/balance`, { method: 'PUT', body: { accountId, balance: Number(v) } });
      setError(undefined);
      onSaved();
    } catch (e: any) { setError(e.message); }
  }
  return (
    <>
      <input className="cell-input num-input" inputMode="numeric" value={v} aria-label={`Остаток, ${title}`}
        onChange={(e) => setV(e.target.value.replace(/[^\d-]/g, ''))} onBlur={save}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
      {error && <div className="tiny error">{error}</div>}
    </>
  );
}

/** Money the company earned this tact, typed by the host; saved on leaving the field. */
function Earned({ ctx, tactId, row, onSaved }: { ctx: Ctx; tactId: number; row: CapRow; onSaved: () => void }) {
  const [v, setV] = useState(row.earned ? String(row.earned) : '');
  const [error, setError] = useState<string>();
  useEffect(() => setV(row.earned ? String(row.earned) : ''), [row.earned]);
  async function save() {
    if (Number(v || 0) === row.earned) return;
    try {
      await api(`/api/admin/games/${ctx.id}/capacity/output`, { method: 'PUT', body: { tactId, accountId: row.accountId, code: EARNED, amount: Number(v || 0) } });
      setError(undefined);
      onSaved();
    } catch (e: any) { setError(e.message); }
  }
  return (
    <>
      <input className="cell-input" style={{ width: 96, textAlign: 'right' }} inputMode="numeric" placeholder="0" value={v}
        aria-label={`Заработали, ${row.title}`} onChange={(e) => setV(e.target.value.replace(/\D/g, ''))} onBlur={save}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
      {error && <div className="tiny error">{error}</div>}
    </>
  );
}

/** Assets of a company: quantity is editable (the change goes to the asset journal). */
function Assets({ ctx, row, types, editable, onChanged }: { ctx: Ctx; row: CapRow; types: any[]; editable: boolean; onChanged: () => void }) {
  const [error, setError] = useState<string>();
  const typeBy = new Map(types.map((t) => [t.code, t]));
  const have = new Set(row.assets.map((a) => a.code));
  async function change(code: string, from: number, to: number) {
    if (to === from) return;
    try {
      await api(`/api/admin/games/${ctx.id}/ledger`, { body: { accountId: row.accountId, code, delta: to - from, comment: 'Изменено в мощностях' } });
      setError(undefined);
      onChanged();
    } catch (e: any) { setError(e.message); }
  }
  return (
    <div className="calc-assets">
      {row.assets.map((a) => {
        const t = typeBy.get(a.code);
        return (
          <div key={a.code} className="calc-asset">
            <span className="grow">{a.title}</span>
            {editable ? <Qty value={a.end} label={a.title} onSave={(n) => change(a.code, a.end, n)} /> : <strong>{a.end}</strong>}
            <span className="tiny muted formula">
              {a.capacityUnit ? `= ${money(a.capacity)} ${a.capacityUnit}` : ''}
              {t?.opex_per_unit ? `${a.capacityUnit ? ', ' : '= '}расход ${a.end} × ${t.opex_per_unit}` : ''}
            </span>
          </div>
        );
      })}
      {editable && types.some((t) => !have.has(t.code)) && (
        <Select value="" placeholder="+ актив" ariaLabel={`Добавить актив, ${row.title}`}
          onChange={(code) => code && change(code, 0, 1)}
          options={types.filter((t) => !have.has(t.code)).map((t) => ({ value: t.code, label: t.title }))} />
      )}
      {error && <div className="tiny error">{error}</div>}
    </div>
  );
}

function Qty({ value, label, onSave }: { value: number; label: string; onSave: (n: number) => void }) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  return (
    <input className="cell-input" style={{ width: 64, textAlign: 'right' }} inputMode="numeric" value={v} aria-label={`Количество, ${label}`}
      onChange={(e) => setV(e.target.value.replace(/\D/g, ''))} onBlur={() => onSave(Number(v || 0))}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
  );
}

type Kind = 'transfer' | 'credit' | 'debit';

/** Move money for a company: to another company, or credit / debit by the game master. */
function MoneyDialog({ ctx, row, onClose, onDone }: { ctx: Ctx; row: CapRow; onClose: () => void; onDone: () => void }) {
  const [kind, setKind] = useState<Kind>('transfer');
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [comment, setComment] = useState('');
  const [key] = useState(newKey());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const n = Number(amount);
  const others = ctx.accounts.filter((a) => a.id !== row.accountId);

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      if (kind === 'transfer') {
        await api(`/api/admin/games/${ctx.id}/transfer`, { body: { fromAccountId: row.accountId, toAccountId: Number(to), amount: n, comment, idempotencyKey: key } });
      } else {
        await api(`/api/admin/games/${ctx.id}/adjust`, { body: { accountId: row.accountId, direction: kind, amount: n, comment, idempotencyKey: key } });
      }
      onDone();
    } catch (err: any) { setError(err.message); setBusy(false); }
  }

  return (
    <Confirm title={row.title} busy={busy} error={error} onCancel={onClose} onConfirm={() => submit()}
      confirmText={kind === 'transfer' ? 'Перевести' : kind === 'credit' ? 'Начислить' : 'Списать'}>
      <form className="stack" onSubmit={submit}>
        <div className="segmented" role="group" aria-label="Операция">
          {([['transfer', 'Перевод'], ['credit', 'Начислить'], ['debit', 'Списать']] as [Kind, string][]).map(([k, l]) => (
            <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>{l}</button>
          ))}
        </div>
        <p className="small muted" style={{ margin: 0 }}>Сейчас на счёте {money(row.balance)}</p>
        {kind === 'transfer' && (
          <div className="field">
            <span className="field-label">Кому</span>
            <Select value={to} onChange={setTo} placeholder="Выберите получателя" ariaLabel="Кому"
              options={others.map((a) => ({ value: String(a.id), label: a.kind === 'host' ? 'Игротехник' : a.title }))} />
          </div>
        )}
        <Field label="Сумма"><input value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} inputMode="numeric" required /></Field>
        <Field label="Комментарий"><input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="За что" /></Field>
        {kind === 'debit' && <p className="small muted" style={{ margin: 0 }}>Списание может увести счёт в минус.</p>}
      </form>
    </Confirm>
  );
}

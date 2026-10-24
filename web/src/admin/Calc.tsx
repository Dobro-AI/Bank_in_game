import { FormEvent, useEffect, useState } from 'react';
import { api, money, newKey, useLoad } from '../api';
import { Select } from '../Select';
import { Confirm, Empty, ErrorText, Field, Money } from '../ui';
import type { Ctx } from './GamePage';

const EARNED = '__earned';

interface AssetCell { code: string; title: string; end: number; capacity: number; capacityUnit: string }
interface CapRow {
  accountId: number; title: string; kind: string; balance: number; owner: string; assets: AssetCell[];
  earned: number; revenue: number; opex: number; opexText: string; postedRevenue: number | null; postedOpex: number | null;
}
interface SumRow { accountId: number; balanceStart: number; received: number; sent: number; balanceEnd: number }

/**
 * The organisers' "Account" sheet as one screen: per company and tact — money at the start, what
 * came in and went out, assets with capacity and expense formulas, earnings typed by the host,
 * and the balance at the end. Ending the tact credits earnings and subtracts expenses.
 */
export function Calc({ ctx }: { ctx: Ctx }) {
  const [tactId, setTactId] = useState<number>();
  const q = tactId ? `?tact=${tactId}` : '';
  const cap = useLoad(() => api<{ tact: any; types: any[]; rows: CapRow[] }>(`/api/admin/games/${ctx.id}/capacity${q}`), [ctx.id, q, ctx.tick]);
  const sum = useLoad(() => api<{ rows: SumRow[] }>(`/api/admin/games/${ctx.id}/summary${q}`), [ctx.id, q, ctx.tick]);
  const [moneyFor, setMoneyFor] = useState<CapRow>();
  const [finish, setFinish] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  if (ctx.d.game.status === 'draft') return <Empty>Расчётка начнётся после запуска игры</Empty>;
  if (!cap.data || !sum.data) return <ErrorText error={cap.error || sum.error} />;
  const tact = cap.data.tact;
  const open = !tact.closed_at;
  const editable = open && ctx.d.can.run;
  const bySum = new Map(sum.data.rows.map((r) => [r.accountId, r]));
  // Legal entities first: in these games each role plays a company.
  const rows = [...cap.data.rows].sort((a, b) => (a.kind === b.kind ? a.title.localeCompare(b.title, 'ru') : a.kind === 'legal' ? -1 : 1));
  const pendingEnd = (r: CapRow) => r.balance + (r.revenue - (r.postedRevenue ?? 0)) - (r.opex - (r.postedOpex ?? 0));
  const totals = rows.reduce((t, r) => {
    const s = bySum.get(r.accountId);
    t.start += s?.balanceStart ?? 0; t.in += s?.received ?? 0; t.out += s?.sent ?? 0;
    t.earned += r.earned; t.opex += r.opex; t.end += open ? pendingEnd(r) : s?.balanceEnd ?? 0;
    return t;
  }, { start: 0, in: 0, out: 0, earned: 0, opex: 0, end: 0 });

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
          <div style={{ minWidth: 200 }}>
            <Select value={tactId ? String(tactId) : ''} onChange={(v) => setTactId(Number(v) || undefined)} ariaLabel="Такт"
              options={[{ value: '', label: `Текущий такт ${ctx.tacts.find((t) => !t.closed_at)?.number ?? ''}` },
                ...ctx.tacts.filter((t) => t.closed_at).map((t) => ({ value: String(t.id), label: `Такт ${t.number}`, sub: 'завершён' }))]} />
          </div>
          {editable && <button className="btn primary" onClick={() => setFinish(true)}>Завершить такт {tact.number}</button>}
        </div>
        <span className="small muted">
          {open ? 'При завершении такта заработок начислится, а расходы спишутся с каждой компании сами.' : 'Такт завершён: суммы зафиксированы.'}
        </span>
      </div>
      <ErrorText error={error} />

      <div className="table-wrap">
        <table className="calc">
          <thead>
            <tr>
              <th>Компания</th><th className="num">На начало</th><th className="num">Пришло</th><th className="num">Ушло</th>
              <th>Мощности</th><th className="num">Заработали</th><th className="num">Расходы</th><th className="num">На конец</th><th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const s = bySum.get(r.accountId);
              return (
                <tr key={r.accountId}>
                  <td><strong>{r.title}</strong><div className="tiny muted">{r.owner}</div></td>
                  <td className="num"><Money value={s?.balanceStart ?? 0} /></td>
                  <td className="num">{s?.received ? <span className="in"><Money value={s.received} signed /></span> : '—'}</td>
                  <td className="num">{s?.sent ? <Money value={-s.sent} signed /> : '—'}</td>
                  <td><Assets ctx={ctx} row={r} types={cap.data!.types} editable={editable} onChanged={cap.reload} /></td>
                  <td className="num">
                    {editable
                      ? <Earned ctx={ctx} tactId={tact.id} row={r} onSaved={cap.reload} />
                      : <Money value={r.earned} />}
                    {r.revenue !== r.earned && <div className="tiny muted">+ с мощностей {money(r.revenue - r.earned)}</div>}
                  </td>
                  <td className="num">
                    {r.opex ? <Money value={-r.opex} signed /> : '—'}
                    {r.opexText && <div className="tiny muted formula">{r.opexText}</div>}
                  </td>
                  <td className="num"><strong><Money value={open ? pendingEnd(r) : s?.balanceEnd ?? 0} /></strong>
                    {open && (r.postedRevenue !== null || r.postedOpex !== null) && <div className="tiny muted">проведено</div>}
                  </td>
                  <td>{ctx.d.can.run && <button className="btn small" onClick={() => setMoneyFor(r)}>Деньги</button>}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td>Итого</td><td className="num"><Money value={totals.start} /></td><td className="num"><Money value={totals.in} /></td>
              <td className="num"><Money value={-totals.out} signed /></td><td></td><td className="num"><Money value={totals.earned} /></td>
              <td className="num"><Money value={-totals.opex} signed /></td><td className="num"><Money value={totals.end} /></td><td></td>
            </tr>
          </tfoot>
        </table>
      </div>

      {moneyFor && <MoneyDialog ctx={ctx} row={moneyFor} onClose={() => setMoneyFor(undefined)} onDone={() => { setMoneyFor(undefined); ctx.reload(); cap.reload(); sum.reload(); }} />}
      {finish && (
        <Confirm title={`Завершить такт ${tact.number}?`} busy={busy} error={error} confirmText="Завершить" onCancel={() => setFinish(false)} onConfirm={doFinish}>
          <div className="summary-line"><span className="muted">Начислится заработок</span><Money value={totals.earned} /></div>
          <div className="summary-line"><span className="muted">Спишутся расходы</span><Money value={-totals.opex} signed /></div>
          <p className="small muted">Балансы зафиксируются, начнётся такт {tact.number + 1}. Уже проведённое не повторится.</p>
        </Confirm>
      )}
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
      await api(`/api/admin/games/${ctx.id}/ledger`, { body: { accountId: row.accountId, code, delta: to - from, comment: 'Изменено в расчётке' } });
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

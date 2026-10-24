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
 * "Счета": per company and tact — money at the start, income typed in by the game master (credited at
 * once), expenses from "Мощности" (subtracted when the tact ends), net transfers and the balance =
 * start + income − expenses + transfers, the same formula as in the Google sheet.
 */
export function Money({ ctx }: { ctx: Ctx }) {
  const { q, cap, picker } = useTact(ctx);
  const sum = useLoad(() => api<{ rows: SumRow[] }>(`/api/admin/games/${ctx.id}/summary${q}`), [ctx.id, q, ctx.tick]);
  const [moneyFor, setMoneyFor] = useState<CapRow>();

  if (ctx.d.game.status === 'draft') return <Empty>Счета появятся после запуска игры</Empty>;
  if (!cap.data || !sum.data) return <ErrorText error={cap.error || sum.error} />;
  const tact = cap.data.tact;
  const open = !tact.closed_at;
  // A game master may correct a finished tact too: the bank recounts it and the tacts after it.
  const editable = ctx.d.can.run;
  const bySum = new Map(sum.data.rows.map((r) => [r.accountId, r]));
  const rows = companies(cap.data.rows);
  // Income and expense postings are shown as such, not among the transfers.
  const moved = (r: CapRow, s?: SumRow) => (s ? s.received - s.sent : 0) - (r.postedRevenue ?? 0) + (r.postedOpex ?? 0);
  const start = (r: CapRow) => bySum.get(r.accountId)?.balanceStart ?? 0;
  const end = (r: CapRow) => (open ? afterTact(r) : bySum.get(r.accountId)?.balanceEnd ?? 0);
  const total = (f: (r: CapRow) => number) => rows.reduce((t, r) => t + f(r), 0);
  const reload = () => { cap.reload(); sum.reload(); };

  return (
    <>
      <div className="row between" style={{ marginBottom: 12 }}>
        {picker}
        <span className="small muted">
          {open ? 'Доходы начислятся, а расходы на мощности спишутся, когда такт закончат во вкладке «Такт».'
            : 'Такт завершён. Правки игротехника записываются в этот такт и пересчитывают его итоги и следующие такты.'}
        </span>
      </div>
      <div className="table-wrap">
        <table className="calc">
          <thead>
            <tr>
              <th>Компания</th><th className="num">На начало</th><th className="num">Доходы</th><th className="num">Расходы</th>
              <th className="num">Переводы</th><th className="num">Остаток</th>{open && <th className="num">Сейчас на счёте</th>}<th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const s = bySum.get(r.accountId);
              const m = moved(r, s);
              return (
                <tr key={r.accountId}>
                  <td><strong>{r.title}</strong><div className="tiny muted">{r.owner}</div></td>
                  <td className="num"><Amount value={start(r)} /></td>
                  <td className="num">
                    {editable ? <Earned ctx={ctx} tactId={tact.id} row={r} onSaved={reload} /> : <Amount value={r.revenue} />}
                    {r.revenue !== r.earned && <div className="tiny muted formula">+ с мощностей {money(r.revenue - r.earned)}</div>}
                  </td>
                  <td className="num">
                    {r.opex ? <Amount value={-r.opex} signed /> : '—'}
                    {r.opexText && <div className="tiny muted formula">{r.opexText}</div>}
                  </td>
                  <td className="num">{m ? <span className={m > 0 ? 'in' : undefined}><Amount value={m} signed /></span> : '—'}</td>
                  <td className="num"><strong><Amount value={end(r)} /></strong></td>
                  {open && (
                    <td className="num">
                      {editable
                        ? <BalanceInput key={`${r.accountId}:${r.balance}`} ctx={ctx} accountId={r.accountId} title={r.title} value={r.balance} onSaved={reload} />
                        : <Amount value={r.balance} />}
                    </td>
                  )}
                  <td>{ctx.d.can.run && <button className="btn small" onClick={() => setMoneyFor(r)}>Деньги</button>}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td>Сумма у всех</td><td className="num"><Amount value={total(start)} /></td><td className="num"><Amount value={total((r) => r.revenue)} /></td>
              <td className="num"><Amount value={-total((r) => r.opex)} signed /></td><td className="num"><Amount value={total((r) => moved(r, bySum.get(r.accountId)))} signed /></td>
              <td className="num"><Amount value={total(end)} /></td>{open && <td className="num"><Amount value={total((r) => r.balance)} /></td>}<td></td>
            </tr>
          </tfoot>
        </table>
      </div>
      {open && <p className="small muted">Остаток — сколько будет на счёте после завершения такта: на начало + доходы − расходы + переводы.</p>}

      {moneyFor && <MoneyDialog ctx={ctx} row={moneyFor} tactId={open ? undefined : tact.id} tactNumber={tact.number} onClose={() => setMoneyFor(undefined)} onDone={() => { setMoneyFor(undefined); ctx.reload(); reload(); }} />}
    </>
  );
}

/**
 * "Мощности": a row per company and asset, like the organisers' sheet — quantity × expense of one
 * unit = expenses, quantity × capacity of one unit = capacity. Quantities and served hours are edited
 * here; the company's expenses go to "Счета".
 */
export function Capacities({ ctx }: { ctx: Ctx }) {
  const { cap, picker } = useTact(ctx);
  const [journal, setJournal] = useState<number>();
  const [error, setError] = useState<string>();

  if (ctx.d.game.status === 'draft') return <Empty>Мощности появятся после запуска игры</Empty>;
  if (!cap.data) return <ErrorText error={cap.error} />;
  const tact = cap.data.tact;
  const editable = ctx.d.can.run;
  const types = cap.data.types;
  const typeBy = new Map(types.map((t) => [t.code, t]));
  const rows = companies(cap.data.rows);
  const served = types.some((t) => t.capacity_unit);

  async function change(accountId: number, code: string, from: number, to: number) {
    if (to === from) return;
    try {
      await api(`/api/admin/games/${ctx.id}/ledger`, {
        body: { accountId, code, delta: to - from, comment: 'Изменено в мощностях', ...(tact.closed_at ? { tactId: tact.id } : {}) },
      });
      setError(undefined);
      cap.reload();
    } catch (e: any) { setError(e.message); }
  }

  return (
    <>
      <div className="row between" style={{ marginBottom: 12 }}>
        {picker}
        <span className="small muted">
          {!tact.closed_at ? 'Расходы компании идут в «Счета» и спишутся при завершении такта.'
            : 'Такт завершён. Изменения записываются в этот такт и пересчитывают его расходы и следующие такты.'}
        </span>
      </div>
      <ErrorText error={error} />
      <div className="table-wrap">
        <table className="calc capacities">
          <thead>
            <tr>
              <th>Компания</th><th>Актив</th><th className="num">Количество</th><th className="num">Расход на 1 шт.</th><th className="num">Расходы</th>
              <th className="num">Мощность 1 шт.</th><th className="num">Мощность</th>{served && <th>Обслужено</th>}<th className="num">Расходы компании</th>
            </tr>
          </thead>
          {rows.map((r, ri) => {
            const list = r.assets.filter((a) => a.end || a.output);
            const span = Math.max(1, list.length);
            const missing = types.filter((t) => !list.some((a) => a.code === t.code));
            const company = (
              <td rowSpan={span}>
                <strong>{r.title}</strong>
                <div className="tiny muted">{r.owner}</div>
                {editable && missing.length > 0 && (
                  <div style={{ marginTop: 8, minWidth: 160 }}>
                    <Select value="" placeholder="+ актив" ariaLabel={`Добавить актив, ${r.title}`} onChange={(code) => code && change(r.accountId, code, 0, 1)}
                      options={missing.map((t) => ({ value: t.code, label: t.title }))} />
                  </div>
                )}
                <button className="btn small" style={{ marginTop: 8 }} onClick={() => setJournal(journal === r.accountId ? undefined : r.accountId)}>
                  {journal === r.accountId ? 'Все компании' : 'Журнал'}
                </button>
              </td>
            );
            const totalCell = (
              <td rowSpan={span} className="num">
                {r.opex ? <strong><Amount value={-r.opex} signed /></strong> : '—'}
                {r.opexText && <div className="tiny muted formula">{r.opexText}</div>}
              </td>
            );
            return (
              <tbody key={r.accountId} className={ri % 2 ? 'alt' : undefined}>
                {list.length === 0 && (
                  <tr>{company}<td colSpan={served ? 7 : 6} className="muted small">Активов нет</td>{totalCell}</tr>
                )}
                {list.map((a, i) => {
                  const t = typeBy.get(a.code);
                  return (
                    <tr key={a.code}>
                      {i === 0 && company}
                      <td>{a.title}</td>
                      <td className="num">{editable ? <Qty value={a.end} label={`${r.title}, ${a.title}`} onSave={(n) => change(r.accountId, a.code, a.end, n)} /> : <strong>{a.end}</strong>}</td>
                      <td className="num cost">{money(t?.opex_per_unit ?? 0)}</td>
                      <td className="num cost-sum">{money(a.end * (t?.opex_per_unit ?? 0))}</td>
                      <td className="num power">{t?.capacity_per_unit ? `${money(t.capacity_per_unit)} ${a.capacityUnit}` : '—'}</td>
                      <td className="num power-sum">{a.capacityUnit ? `${money(a.capacity)} ${a.capacityUnit}` : '—'}</td>
                      {served && (
                        <td>{a.capacityUnit ? <OutputInput ctx={ctx} tactId={tact.id} accountId={r.accountId} cell={a} editable={editable} onSaved={cap.reload} /> : null}</td>
                      )}
                      {i === 0 && totalCell}
                    </tr>
                  );
                })}
              </tbody>
            );
          })}
          <tfoot>
            <tr>
              <td colSpan={served ? 8 : 7}>Итого расходов</td>
              <td className="num"><Amount value={-rows.reduce((s, r) => s + r.opex, 0)} signed /></td>
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
      <input className="cell-input num-input" inputMode="numeric" value={v} aria-label={`Сейчас на счёте, ${title}`}
        onChange={(e) => setV(e.target.value.replace(/[^\d-]/g, ''))} onBlur={save}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
      {error && <div className="tiny error">{error}</div>}
    </>
  );
}

/** Income of the company this tact, typed by the host; saved on leaving the field, credited when the tact ends. */
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
        aria-label={`Доходы, ${row.title}`} onChange={(e) => setV(e.target.value.replace(/\D/g, ''))} onBlur={save}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
      {error && <div className="tiny error">{error}</div>}
    </>
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
function MoneyDialog({ ctx, row, tactId, tactNumber, onClose, onDone }: {
  ctx: Ctx; row: CapRow; tactId?: number; tactNumber: number; onClose: () => void; onDone: () => void;
}) {
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
        await api(`/api/admin/games/${ctx.id}/transfer`, { body: { fromAccountId: row.accountId, toAccountId: Number(to), amount: n, comment, idempotencyKey: key, tactId } });
      } else {
        await api(`/api/admin/games/${ctx.id}/adjust`, { body: { accountId: row.accountId, direction: kind, amount: n, comment, idempotencyKey: key, tactId } });
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
        <p className="small muted" style={{ margin: 0 }}>
          Сейчас на счёте {money(row.balance)}{tactId ? ` · запишется в завершённый такт ${tactNumber}` : ''}
        </p>
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

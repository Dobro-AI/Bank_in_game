import { FormEvent, useEffect, useState } from 'react';
import { api, dateTime, money, useLoad } from '../api';
import { Confirm, Empty, ErrorText, Field, Money } from '../ui';
import type { Ctx } from './GamePage';

interface AssetCell { code: string; title: string; unit: string; start: number; change: number; end: number; capacity: number; capacityUnit: string; output: number }
interface Row {
  accountId: number; title: string; owner: string; balance: number; assets: AssetCell[];
  capacity: Record<string, number>; served: Record<string, number>;
  revenue: number; opex: number; result: number; revenueText: string; opexText: string;
  postedRevenue: number | null; postedOpex: number | null;
}
interface Table { tact: any; types: any[]; rows: Row[]; totals: { revenue: number; opex: number; capacity: Record<string, number>; served: Record<string, number> } }

const REASON: Record<string, string> = { start: 'Старт', purchase: 'Покупка', manual: 'Вручную', aging: 'Новый такт' };
const units = (m: Record<string, number>) => Object.entries(m).map(([u, v]) => `${money(v)} ${u}`).join(', ') || '—';

/** Per-tact capacity sheet: holdings, served output, revenue and OPEX, posted with one button each. */
export function Capacity({ ctx }: { ctx: Ctx }) {
  const [tactId, setTactId] = useState<number>();
  const table = useLoad(() => api<Table>(`/api/admin/games/${ctx.id}/capacity${tactId ? `?tact=${tactId}` : ''}`), [ctx.id, tactId, ctx.tick]);
  const [open, setOpen] = useState<number>();
  const [post, setPost] = useState<'revenue' | 'opex'>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [msg, setMsg] = useState<string>();

  if (ctx.d.game.status === 'draft') return <Empty>Учёт мощностей начнётся после запуска игры</Empty>;
  if (!table.data) return <ErrorText error={table.error} />;
  const t = table.data;
  const editable = ctx.d.can.run && !t.tact.closed_at;
  const pending = (kind: 'revenue' | 'opex') =>
    t.rows.filter((r) => (kind === 'revenue' ? r.postedRevenue : r.postedOpex) === null).reduce((s, r) => s + (kind === 'revenue' ? r.revenue : r.opex), 0);

  async function doPost() {
    setBusy(true);
    setError(undefined);
    try {
      const r = await api(`/api/admin/games/${ctx.id}/capacity/post`, { body: { kind: post } });
      setMsg(`${post === 'revenue' ? 'Выручка начислена' : 'OPEX списан'}: ${r.count} компаний, ${money(r.total)}`);
      setPost(undefined);
      table.reload();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }

  return (
    <>
      <div className="filters">
        <Field label="Такт">
          <select value={tactId ?? ''} onChange={(e) => setTactId(Number(e.target.value) || undefined)}>
            <option value="">Текущий</option>
            {ctx.tacts.map((x) => <option key={x.id} value={x.id}>Такт {x.number}{x.closed_at ? '' : ' (идёт)'}</option>)}
          </select>
        </Field>
        <div className="stat"><span className="muted tiny">Мощность</span><strong>{units(t.totals.capacity)}</strong></div>
        <div className="stat"><span className="muted tiny">Обслужено</span><strong>{units(t.totals.served)}</strong></div>
        <div className="stat"><span className="muted tiny">Выручка / OPEX</span><strong>{money(t.totals.revenue)} / {money(t.totals.opex)}</strong></div>
      </div>

      {editable && (
        <div className="row" style={{ marginBottom: 16 }}>
          <button className="btn primary" disabled={!pending('revenue')} onClick={() => setPost('revenue')}>Начислить выручку {money(pending('revenue'))}</button>
          <button className="btn" disabled={!pending('opex')} onClick={() => setPost('opex')}>Списать OPEX {money(pending('opex'))}</button>
          <span className="small muted">Сначала впишите обслуженные часы и рейсы. Каждая компания проводится один раз за такт.</span>
        </div>
      )}
      {msg && <p className="ok small">{msg}</p>}
      <ErrorText error={error} />

      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Компания</th><th>Активы на конец такта</th><th>Мощность</th><th>Обслужено</th>
              <th className="num">Выручка</th><th className="num">OPEX</th><th className="num">Итог</th><th>Проведено</th><th></th></tr>
          </thead>
          <tbody>
            {t.rows.map((r) => (
              <tr key={r.accountId}>
                <td><strong>{r.title}</strong><div className="tiny muted">{r.owner}</div></td>
                <td>
                  {r.assets.map((a) => (
                    <div key={a.code} className="nowrap">
                      {a.title}: {editable
                        ? <QtyInput key={`${a.code}:${a.end}`} ctx={ctx} accountId={r.accountId} cell={a} onSaved={table.reload} />
                        : <strong>{a.end}</strong>}
                      {a.change ? <span className="muted"> ({a.change > 0 ? '+' : ''}{a.change})</span> : null}
                    </div>
                  ))}
                </td>
                <td className="nowrap">{units(r.capacity)}</td>
                <td>
                  {r.assets.filter((a) => a.capacityUnit && a.end + a.output > 0).map((a) => (
                    <OutputInput key={a.code} ctx={ctx} tactId={t.tact.id} accountId={r.accountId} cell={a} editable={editable} onSaved={table.reload} />
                  ))}
                </td>
                <td className="num" title={r.revenueText}><Money value={r.revenue} /></td>
                <td className="num" title={r.opexText}><Money value={r.opex} /></td>
                <td className="num"><Money value={r.result} /></td>
                <td className="tiny">
                  {r.postedRevenue !== null && <div>выручка {money(r.postedRevenue)}</div>}
                  {r.postedOpex !== null && <div>OPEX {money(r.postedOpex)}</div>}
                </td>
                <td><button className="btn small" onClick={() => setOpen(open === r.accountId ? undefined : r.accountId)}>{open === r.accountId ? 'Скрыть' : 'Активы'}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {t.rows.length === 0 && <Empty>Активов пока нет. Задайте их в настройках или впишите вручную ниже.</Empty>}
      </div>

      <Ledger ctx={ctx} accountId={open} onClose={() => setOpen(undefined)} onChanged={table.reload} />

      {post && (
        <Confirm title={post === 'revenue' ? 'Начислить выручку?' : 'Списать OPEX?'} busy={busy} error={error}
          confirmText={post === 'revenue' ? 'Начислить' : 'Списать'} onCancel={() => setPost(undefined)} onConfirm={doPost}>
          <p className="small">Такт {t.tact.number}. Всего {money(pending(post))}. Расчёт по каждой компании попадёт в комментарий перевода.</p>
          {post === 'opex' && <p className="small muted">Списание может увести счёт в минус.</p>}
        </Confirm>
      )}
    </>
  );
}

/** Holdings typed in directly: the difference goes to the asset journal. */
function QtyInput({ ctx, accountId, cell, onSaved }: { ctx: Ctx; accountId: number; cell: AssetCell; onSaved: () => void }) {
  const [value, setValue] = useState(String(cell.end));
  const [error, setError] = useState<string>();
  async function save() {
    const delta = Number(value || 0) - cell.end;
    if (!delta) return;
    try {
      await api(`/api/admin/games/${ctx.id}/ledger`, { body: { accountId, code: cell.code, delta, comment: 'Изменено в мощностях' } });
      setError(undefined);
      onSaved();
    } catch (e: any) { setError(e.message); }
  }
  return (
    <>
      <input className="cell-input" style={{ width: 64, textAlign: 'right' }} inputMode="numeric" value={value}
        aria-label={`Количество, ${cell.title}`} onChange={(e) => setValue(e.target.value.replace(/\D/g, ''))} onBlur={save}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
      {error && <span className="tiny error"> {error}</span>}
    </>
  );
}

function OutputInput({ ctx, tactId, accountId, cell, editable, onSaved }: {
  ctx: Ctx; tactId: number; accountId: number; cell: AssetCell; editable: boolean; onSaved: () => void;
}) {
  const [value, setValue] = useState(String(cell.output || ''));
  const [error, setError] = useState<string>();
  useEffect(() => setValue(String(cell.output || '')), [cell.output]);
  const over = Number(value) > cell.capacity;
  async function save() {
    if (Number(value || 0) === cell.output) return;
    try {
      await api(`/api/admin/games/${ctx.id}/capacity/output`, { method: 'PUT', body: { tactId, accountId, code: cell.code, amount: Number(value || 0) } });
      setError(undefined);
      onSaved();
    } catch (e: any) { setError(e.message); }
  }
  return (
    <label className="output-input">
      <span className="tiny">{cell.title}</span>
      {editable ? (
        <input className={over ? 'cell-input over' : 'cell-input'} inputMode="numeric" value={value} placeholder="0"
          onChange={(e) => setValue(e.target.value.replace(/\D/g, ''))} onBlur={save}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          aria-label={`Обслужено, ${cell.title}`} />
      ) : <strong>{cell.output}</strong>}
      <span className={over ? 'tiny error' : 'tiny muted'}>из {cell.capacity} {cell.capacityUnit}</span>
      {error && <span className="tiny error">{error}</span>}
    </label>
  );
}

/** Asset journal: everything that came or went. Hosts add, correct or delete rows. */
function Ledger({ ctx, accountId, onClose, onChanged }: { ctx: Ctx; accountId?: number; onClose: () => void; onChanged: () => void }) {
  const rows = useLoad(() => api<any[]>(`/api/admin/games/${ctx.id}/ledger${accountId ? `?account=${accountId}` : ''}`), [ctx.id, accountId, ctx.tick]);
  const companies = ctx.accounts.filter((a) => a.kind !== 'host');
  const [form, setForm] = useState({ accountId: accountId ?? 0, code: '', sign: 1, qty: '', comment: '' });
  const [error, setError] = useState<string>();
  useEffect(() => setForm((f) => ({ ...f, accountId: accountId ?? f.accountId })), [accountId]);
  const editable = ctx.d.can.run;
  const title = accountId ? companies.find((a) => a.id === accountId)?.title : undefined;

  const act = async (fn: () => Promise<unknown>) => {
    setError(undefined);
    try { await fn(); rows.reload(); onChanged(); } catch (e: any) { setError(e.message); }
  };
  async function add(e: FormEvent) {
    e.preventDefault();
    await act(async () => {
      await api(`/api/admin/games/${ctx.id}/ledger`, {
        body: { accountId: form.accountId, code: form.code, delta: form.sign * Number(form.qty), comment: form.comment },
      });
      setForm((f) => ({ ...f, qty: '', comment: '' }));
    });
  }

  return (
    <section className="section">
      <div className="row between">
        <h2 style={{ margin: 0 }}>Журнал активов{title ? `: ${title}` : ''}</h2>
        {accountId && <button className="btn small" onClick={onClose}>Все компании</button>}
      </div>
      {editable && (
        <form className="panel ledger-form" onSubmit={add}>
          <Field label="Компания">
            <select value={form.accountId || ''} onChange={(e) => setForm({ ...form, accountId: Number(e.target.value) })} required>
              <option value="">Выберите…</option>
              {companies.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
            </select>
          </Field>
          <Field label="Актив">
            <select value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} required>
              <option value="">Выберите…</option>
              {ctx.d.assetTypes.map((a) => <option key={a.code} value={a.code}>{a.title}</option>)}
            </select>
          </Field>
          <div className="field">
            <span className="field-label">Пришло / ушло</span>
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <div className="segmented two" role="group" aria-label="Направление">
                <button type="button" aria-pressed={form.sign === 1} onClick={() => setForm({ ...form, sign: 1 })}>Пришло</button>
                <button type="button" aria-pressed={form.sign === -1} onClick={() => setForm({ ...form, sign: -1 })}>Ушло</button>
              </div>
              <input value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value.replace(/\D/g, '') })} inputMode="numeric"
                placeholder="Кол-во" aria-label="Количество" required style={{ width: 96 }} />
            </div>
          </div>
          <Field label="Комментарий"><input value={form.comment} onChange={(e) => setForm({ ...form, comment: e.target.value })} placeholder="Купили у Volvo, сломался…" /></Field>
          <button className="btn primary" disabled={!form.accountId || !form.code || !Number(form.qty)}>Внести</button>
        </form>
      )}
      <ErrorText error={error} />
      <div className="table-wrap">
        <table>
          <thead><tr><th>Дата</th><th>Такт</th><th>Компания</th><th>Актив</th><th className="num">Изменение</th><th>Причина</th><th>Комментарий</th><th></th></tr></thead>
          <tbody>
            {rows.data?.map((l) => <LedgerRow key={`${l.id}:${l.delta}:${l.comment}`} ctx={ctx} l={l} editable={editable} act={act} />)}
          </tbody>
        </table>
        {rows.data?.length === 0 && <Empty>Записей нет</Empty>}
      </div>
    </section>
  );
}

function LedgerRow({ ctx, l, editable, act }: { ctx: Ctx; l: any; editable: boolean; act: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [delta, setDelta] = useState(String(l.delta));
  const [comment, setComment] = useState(l.comment);
  const dirty = delta !== String(l.delta) || comment !== l.comment;
  return (
    <tr>
      <td className="nowrap">{dateTime(l.created_at)}</td>
      <td>{l.tact ?? ''}</td>
      <td>{l.account_title}</td>
      <td>{l.asset_title ?? l.asset_code}</td>
      <td className="num">
        {editable ? <input className="cell-input" style={{ width: 72, textAlign: 'right' }} value={delta} aria-label="Изменение"
          onChange={(e) => setDelta(e.target.value.replace(/[^\d-]/g, ''))} /> : (l.delta > 0 ? `+${l.delta}` : l.delta)}
      </td>
      <td>{REASON[l.reason] ?? l.reason}{l.staff_name ? <div className="tiny muted">{l.staff_name}</div> : null}</td>
      <td>{editable ? <input className="cell-input" value={comment} aria-label="Комментарий" onChange={(e) => setComment(e.target.value)} /> : l.comment}</td>
      <td>
        {editable && (
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <button className="btn small primary" disabled={!dirty}
              onClick={() => act(() => api(`/api/admin/games/${ctx.id}/ledger/${l.id}`, { method: 'PATCH', body: { delta: Number(delta), comment } }))}>Сохранить</button>
            <button className="btn small danger" onClick={() => {
              if (confirm('Удалить запись из журнала активов?')) act(() => api(`/api/admin/games/${ctx.id}/ledger/${l.id}`, { method: 'DELETE' }));
            }}>Удалить</button>
          </div>
        )}
      </td>
    </tr>
  );
}

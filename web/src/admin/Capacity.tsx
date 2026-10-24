import { FormEvent, useEffect, useState } from 'react';
import { api, dateTime, useLoad } from '../api';
import { Empty, ErrorText, Field } from '../ui';
import type { Ctx } from './GamePage';

interface AssetCell { code: string; title: string; capacity: number; capacityUnit: string; output: number }

const REASON: Record<string, string> = { start: 'Старт', purchase: 'Покупка', manual: 'Вручную', aging: 'Новый такт' };

export function OutputInput({ ctx, tactId, accountId, cell, editable, onSaved }: {
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
export function Ledger({ ctx, accountId, onClose, onChanged }: { ctx: Ctx; accountId?: number; onClose: () => void; onChanged: () => void }) {
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

import { useState } from 'react';
import { api } from '../api';
import { ErrorText } from '../ui';
import type { Ctx } from './GamePage';

type Kind = 'text' | 'number' | 'pin' | 'role' | 'roles' | 'bool';
interface Spec { key: string; label: string; kind: Kind }

const ROLE_FIELDS: Spec[] = [
  { key: 'title', label: 'Роль', kind: 'text' },
  { key: 'description', label: 'Описание', kind: 'text' },
  { key: 'start_balance', label: 'Стартовый баланс', kind: 'number' },
  { key: 'preset_first_name', label: 'Имя игрока', kind: 'text' },
  { key: 'preset_last_name', label: 'Фамилия игрока', kind: 'text' },
];
const ACCOUNT_FIELDS: Spec[] = [
  { key: 'title', label: 'Юрлицо', kind: 'text' },
  { key: 'owner_role_id', label: 'Владелец', kind: 'role' },
  { key: 'coowner_role_ids', label: 'Совладельцы', kind: 'roles' },
  { key: 'start_balance', label: 'Стартовый баланс', kind: 'number' },
  { key: 'pin', label: 'PIN', kind: 'pin' },
];
const PRICE_FIELDS: Spec[] = [
  { key: 'title', label: 'Позиция', kind: 'text' },
  { key: 'price', label: 'Цена', kind: 'number' },
  { key: 'active', label: 'Активна', kind: 'bool' },
];

export function Config({ ctx }: { ctx: Ctx }) {
  const { d } = ctx;
  const branch = d.game.kind === 'branch';
  return (
    <div className="stack">
      {branch && (
        <p className="small muted">
          Изменения корневой игры приходят сюда автоматически. Строка, которую вы поменяли здесь, помечается «изменено здесь»,
          и корневые правки её больше не трогают. Стартовые балансы применяются при запуске игры и при занятии роли —
          уже открытые счета они не меняют (для этого есть начисления).
        </p>
      )}
      <Editor ctx={ctx} title="Роли" slug="roles" fields={ROLE_FIELDS} rows={d.roles} />
      <Editor ctx={ctx} title="Стартовые юрлица" slug="start-accounts" fields={ACCOUNT_FIELDS} rows={d.startAccounts} />
      <Editor ctx={ctx} title="Прайс фиксированных платежей" slug="price-items" fields={PRICE_FIELDS} rows={d.priceItems}
        hint="Игрок оплачивает позицию игротехнику; цена подставляется сама, баланс может уйти в минус." />
    </div>
  );
}

const blank = (fields: Spec[]) =>
  Object.fromEntries(fields.map((f) => [f.key, f.kind === 'number' ? 0 : f.kind === 'roles' ? [] : f.kind === 'bool' ? true : f.kind === 'role' ? null : '']));

function Editor({ ctx, title, slug, fields, rows, hint }: { ctx: Ctx; title: string; slug: string; fields: Spec[]; rows: any[]; hint?: string }) {
  const [draft, setDraft] = useState<any>(blank(fields));
  const [error, setError] = useState<string>();
  const editable = ctx.d.can.config;
  const branch = ctx.d.game.kind === 'branch';

  async function add() {
    setError(undefined);
    try {
      await api(`/api/admin/games/${ctx.id}/${slug}`, { body: draft });
      setDraft(blank(fields));
      ctx.reload();
    } catch (e: any) { setError(e.message); }
  }

  return (
    <section className="section">
      <h2>{title}</h2>
      {hint && <p className="small muted">{hint}</p>}
      <ErrorText error={error} />
      <div className="table-wrap">
        <table>
          <thead><tr>{fields.map((f) => <th key={f.key}>{f.label}</th>)}{branch && <th></th>}<th></th></tr></thead>
          <tbody>
            {rows.map((r) => <Row key={`${r.id}:${r.local_modified}:${JSON.stringify(fields.map((f) => r[f.key]))}`} ctx={ctx} slug={slug} fields={fields} row={r} />)}
            {editable && (
              <tr>
                {fields.map((f) => <td key={f.key}><Input ctx={ctx} spec={f} value={draft[f.key]} onChange={(v) => setDraft({ ...draft, [f.key]: v })} /></td>)}
                {branch && <td></td>}
                <td><button className="btn small primary" onClick={add} disabled={!draft.title}>Добавить</button></td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Row({ ctx, slug, fields, row }: { ctx: Ctx; slug: string; fields: Spec[]; row: any }) {
  const [v, setV] = useState<any>(row);
  const [error, setError] = useState<string>();
  const dirty = fields.some((f) => JSON.stringify(v[f.key]) !== JSON.stringify(row[f.key]));
  const editable = ctx.d.can.config;
  const branch = ctx.d.game.kind === 'branch';

  const run = async (fn: () => Promise<unknown>) => {
    setError(undefined);
    try { await fn(); ctx.reload(); } catch (e: any) { setError(e.message); }
  };
  const patch = () => run(() => api(`/api/admin/${slug}/${row.id}`, {
    method: 'PATCH', body: Object.fromEntries(fields.filter((f) => JSON.stringify(v[f.key]) !== JSON.stringify(row[f.key])).map((f) => [f.key, v[f.key]])),
  }));

  return (
    <tr>
      {fields.map((f) => (
        <td key={f.key}>{editable ? <Input ctx={ctx} spec={f} value={v[f.key]} onChange={(x) => setV({ ...v, [f.key]: x })} /> : display(ctx, f, row[f.key])}</td>
      ))}
      {branch && (
        <td>
          {row.source_id === null ? <span className="chip">только здесь</span> : row.local_modified ? <span className="chip warn">изменено здесь</span> : null}
        </td>
      )}
      <td>
        {editable && (
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <button className="btn small primary" disabled={!dirty} onClick={patch}>Сохранить</button>
            <button className="btn small danger" aria-label="Удалить" onClick={() => {
              if (confirm(`Удалить «${row.title}»?`)) run(() => api(`/api/admin/${slug}/${row.id}`, { method: 'DELETE' }));
            }}>Удалить</button>
          </div>
        )}
        <ErrorText error={error} />
      </td>
    </tr>
  );
}

const roleName = (ctx: Ctx, id: number) => ctx.d.roles.find((r) => r.id === id)?.title ?? '—';

function display(ctx: Ctx, f: Spec, value: any) {
  if (f.kind === 'role') return value ? roleName(ctx, value) : '—';
  if (f.kind === 'roles') return (value ?? []).map((id: number) => roleName(ctx, id)).join(', ');
  if (f.kind === 'bool') return value ? 'да' : 'нет';
  return String(value ?? '');
}

function Input({ ctx, spec, value, onChange }: { ctx: Ctx; spec: Spec; value: any; onChange: (v: any) => void }) {
  const label = spec.label;
  switch (spec.kind) {
    case 'number':
      return <input className="cell-input" style={{ width: 120 }} aria-label={label} inputMode="numeric" value={value ?? 0}
        onChange={(e) => onChange(Number(e.target.value.replace(/\D/g, '')) || 0)} />;
    case 'pin':
      return <input className="cell-input code" style={{ width: 80 }} aria-label={label} inputMode="numeric" value={value ?? ''}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 4))} />;
    case 'bool':
      return <input type="checkbox" aria-label={label} checked={!!value} onChange={(e) => onChange(e.target.checked)} />;
    case 'role':
      return (
        <select className="cell-input" aria-label={label} value={value ?? ''} onChange={(e) => onChange(Number(e.target.value) || null)}>
          <option value="">—</option>
          {ctx.d.roles.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
        </select>
      );
    case 'roles':
      return (
        <select className="cell-input" multiple aria-label={label} style={{ minWidth: 160, minHeight: 72 }} value={(value ?? []).map(String)}
          onChange={(e) => onChange([...e.target.selectedOptions].map((o) => Number(o.value)))}>
          {ctx.d.roles.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
        </select>
      );
    default:
      return <input className="cell-input" aria-label={label} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
  }
}

import { useState } from 'react';
import { api } from '../api';
import { ErrorText } from '../ui';
import type { Ctx } from './GamePage';

type Kind = 'text' | 'number' | 'pin' | 'role' | 'roles' | 'bool' | 'asset' | 'assets' | 'ages';
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
  { key: 'assets', label: 'Стартовые активы', kind: 'assets' },
];
const ASSET_FIELDS: Spec[] = [
  { key: 'title', label: 'Актив', kind: 'text' },
  { key: 'unit', label: 'Ед.', kind: 'text' },
  { key: 'capacity_per_unit', label: 'Мощность за ед.', kind: 'number' },
  { key: 'capacity_unit', label: 'Ед. мощности', kind: 'text' },
  { key: 'revenue_per_output', label: 'Выручка за ед. мощности', kind: 'number' },
  { key: 'cost_per_output', label: 'Затраты за ед. мощности', kind: 'number' },
  { key: 'opex_per_unit', label: 'OPEX за такт', kind: 'number' },
  { key: 'income_per_unit', label: 'Доход за такт', kind: 'number' },
  { key: 'ages_to', label: 'В новом такте', kind: 'ages' },
  { key: 'sort', label: 'Порядок', kind: 'number' },
];
const PRICE_FIELDS: Spec[] = [
  { key: 'title', label: 'Позиция', kind: 'text' },
  { key: 'price', label: 'Цена', kind: 'number' },
  { key: 'active', label: 'Активна', kind: 'bool' },
  { key: 'asset_code', label: 'Даёт актив', kind: 'asset' },
  { key: 'asset_qty', label: 'Ед. актива за шт.', kind: 'number' },
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
      {ctx.d.can.super && <GameTitle ctx={ctx} />}
      <Rules ctx={ctx} />
      <Editor ctx={ctx} title="Роли" slug="roles" fields={ROLE_FIELDS} rows={d.roles} />
      <Editor ctx={ctx} title="Активы и мощности" slug="asset-types" fields={ASSET_FIELDS} rows={d.assetTypes}
        hint="Серверы, площадки, грузовики, сотрудники. Мощность за ед. — сколько часов или рейсов даёт одна единица. OPEX списывается за каждую единицу в конце такта, затраты за ед. мощности — за каждый обслуженный час или рейс. «В новом такте» — во что актив превращается при завершении такта (грузовик стареет) или исчезает." />
      <Editor ctx={ctx} title="Стартовые юрлица" slug="start-accounts" fields={ACCOUNT_FIELDS} rows={d.startAccounts} />
      <Editor ctx={ctx} title="Прайс игротехника (CAPEX)" slug="price-items" fields={PRICE_FIELDS} rows={d.priceItems}
        hint="Заготовки при переводе Игротехнику: что покупают, за сколько и в каком количестве. Если позиция даёт актив, он сам добавляется покупателю в учёт мощностей." />
    </div>
  );
}

/** Super host renames the game (players see this name when choosing a game). */
function GameTitle({ ctx }: { ctx: Ctx }) {
  const [title, setTitle] = useState(ctx.d.game.title);
  const [error, setError] = useState<string>();
  async function save() {
    setError(undefined);
    try {
      await api(`/api/admin/games/${ctx.id}`, { method: 'PATCH', body: { title } });
      ctx.reload();
    } catch (e: any) { setError(e.message); }
  }
  return (
    <section className="section stack">
      <h2 style={{ margin: 0 }}>Название игры</h2>
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Название игры" maxLength={200} />
        <button className="btn primary" disabled={!title.trim() || title === ctx.d.game.title} onClick={save}>Сохранить</button>
      </div>
      <ErrorText error={error} />
    </section>
  );
}

/** Free-text rules: shown to hosts and used by the assistant when answering and designing mechanics. */
function Rules({ ctx }: { ctx: Ctx }) {
  const saved = ctx.d.game.rules ?? '';
  const [rules, setRules] = useState(saved);
  const [error, setError] = useState<string>();
  const [ok, setOk] = useState(false);
  const branch = ctx.d.game.kind === 'branch';
  async function save() {
    setError(undefined);
    try {
      await api(`/api/admin/games/${ctx.id}/rules`, { method: 'PATCH', body: { rules } });
      setOk(true);
      ctx.reload();
    } catch (e: any) { setError(e.message); }
  }
  return (
    <section className="section stack">
      <div className="row between">
        <h2 style={{ margin: 0 }}>Правила игры</h2>
        {branch && ctx.d.game.rules_local_modified && <span className="chip warn">изменено здесь</span>}
      </div>
      <p className="small muted">Экономика, налоги, механики. Помощник опирается на этот текст.</p>
      <textarea value={rules} onChange={(e) => { setRules(e.target.value); setOk(false); }} rows={8} readOnly={!ctx.d.can.config}
        aria-label="Правила игры" maxLength={50000} />
      {ctx.d.can.config && (
        <div className="row">
          <button className="btn primary" disabled={rules === saved} onClick={save}>Сохранить правила</button>
          {ok && <span className="ok small">Сохранено</span>}
        </div>
      )}
      <ErrorText error={error} />
    </section>
  );
}

const blank = (fields: Spec[]) =>
  Object.fromEntries(fields.map((f) => [f.key, f.kind === 'number' ? 0 : f.kind === 'roles' ? [] : f.kind === 'bool' ? true : f.kind === 'role' ? null : f.kind === 'assets' ? {} : '']));

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

const assetName = (ctx: Ctx, code: string) => ctx.d.assetTypes.find((a) => a.code === code)?.title ?? code;

function display(ctx: Ctx, f: Spec, value: any) {
  if (f.kind === 'asset') return value ? assetName(ctx, value) : '—';
  if (f.kind === 'ages') return value === 'expire' ? 'исчезает' : value ? assetName(ctx, value) : 'остаётся';
  if (f.kind === 'assets') return Object.entries(value ?? {}).map(([c, q]) => `${assetName(ctx, c)}: ${q}`).join(', ');
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
    case 'asset':
      return (
        <select className="cell-input" aria-label={label} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {ctx.d.assetTypes.map((a) => <option key={a.code} value={a.code}>{a.title}</option>)}
        </select>
      );
    case 'ages':
      return (
        <select className="cell-input" aria-label={label} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
          <option value="">остаётся</option>
          <option value="expire">исчезает</option>
          {ctx.d.assetTypes.map((a) => <option key={a.code} value={a.code}>→ {a.title}</option>)}
        </select>
      );
    case 'assets':
      return (
        <div className="asset-inputs">
          {ctx.d.assetTypes.length === 0 && <span className="muted tiny">Сначала добавьте активы</span>}
          {ctx.d.assetTypes.map((a) => (
            <label key={a.code} className="asset-input">
              <span className="tiny">{a.title}</span>
              <input className="cell-input" inputMode="numeric" value={value?.[a.code] ?? ''} placeholder="0"
                onChange={(e) => onChange({ ...(value ?? {}), [a.code]: Number(e.target.value.replace(/\D/g, '')) || 0 })} />
            </label>
          ))}
        </div>
      );
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

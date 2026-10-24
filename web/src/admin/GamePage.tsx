import { FormEvent, ReactNode, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ACCOUNT_KIND, KIND_LABEL, api, dateTime, useLive, useLoad } from '../api';
import { BoxIcon, BranchIcon, FlagIcon, GearIcon, KeyIcon, SparkIcon, TableIcon, TransferIcon } from '../icons';
import { Select } from '../Select';
import { Confirm, Empty, ErrorText, Field, Money } from '../ui';
import type { Staff } from './AdminApp';
import { Assistant } from './Assistant';
import { Capacities, Money as MoneyPage } from './Calc';
import { Codes } from './Codes';
import { Config } from './Config';
import { AdminShell, NavItem } from './Shell';
import { Sheet } from './Sheet';
import { SheetView } from './SheetView';

export interface GameData {
  game: any; roles: any[]; startAccounts: any[]; priceItems: any[]; assetTypes: any[]; staff: Staff[]; branches: any[];
  can: { config: boolean; run: boolean; super: boolean };
}

type Section = 'money' | 'history' | 'capacity' | 'roles' | 'assistant' | 'rules' | 'settings' | 'branches';

const SECTIONS: Record<Section, { label: string; icon: ReactNode }> = {
  money: { label: 'Деньги', icon: <TableIcon /> },
  history: { label: 'История переводов', icon: <TransferIcon /> },
  capacity: { label: 'Мощности', icon: <BoxIcon /> },
  roles: { label: 'Роли', icon: <KeyIcon /> },
  assistant: { label: 'Помощник', icon: <SparkIcon /> },
  rules: { label: 'Правила игры', icon: <FlagIcon /> },
  settings: { label: 'Настройки', icon: <GearIcon /> },
  branches: { label: 'Ответвления', icon: <BranchIcon /> },
};

/** A game's sections live in the left menu; the section is part of the URL so reloads keep it. */
export function GamePage({ staff, onLogout }: { staff: Staff; onLogout: () => void }) {
  const params = useParams();
  const id = Number(params.id);
  const data = useLoad(() => api<GameData>(`/api/admin/games/${id}`), [id]);
  const accounts = useLoad(() => api<any[]>(`/api/admin/games/${id}/accounts`), [id]);
  const tacts = useLoad(() => api<any[]>(`/api/admin/games/${id}/tacts`), [id]);
  const [tick, setTick] = useState(0);
  useLive(id, () => { data.reload(); accounts.reload(); tacts.reload(); setTick((t) => t + 1); });

  const d = data.data;
  if (!d) return <main className="page"><ErrorText error={data.error} /></main>;
  const isRoot = d.game.kind === 'root';
  // The assistant runs on the admin's own Claude subscription.
  const assistant: Section[] = staff.kind === 'super' ? ['assistant'] : [];
  const sections: Section[] = isRoot
    ? ['rules', 'branches', ...assistant]
    : ['money', 'history', 'capacity', 'roles', ...assistant, 'rules', 'settings'];
  const current = sections.includes(params.section as Section) ? (params.section as Section) : sections[0];
  const ctx = { id, d, accounts: accounts.data ?? [], tacts: tacts.data ?? [], tick, reload: () => { data.reload(); accounts.reload(); tacts.reload(); } };
  const items: NavItem[] = sections.map((k, i) => ({
    to: i === 0 ? `/admin/g/${id}` : `/admin/g/${id}/${k}`, end: i === 0, label: SECTIONS[k].label, icon: SECTIONS[k].icon,
  }));

  return (
    <AdminShell staff={staff} items={items} onLogout={onLogout} back={{ to: '/admin', label: 'Все игры' }}
      title={d.game.title} subtitle={isRoot ? 'Корневая игра' : `Ответвление · ${STATUS[d.game.status]}`}>
      <header className="page-head">
        <div>
          <h1>{SECTIONS[current].label}</h1>
          <p className="muted small">
            {d.game.title}{isRoot ? ' · изменения применяются во всех ответвлениях' : ''}
          </p>
        </div>
        {!isRoot && d.game.status === 'active' && <OpenTact tacts={ctx.tacts} />}
      </header>
      {!isRoot && d.game.status === 'draft' && <LaunchBanner ctx={ctx} />}
      {current === 'money' && <SheetView ctx={ctx} section="money" tabs={['Деньги']} initial="bank"><MoneyPage ctx={ctx} /></SheetView>}
      {current === 'history' && <SheetView ctx={ctx} section="history" tabs={['Переводы']} initial="bank"><Transfers ctx={ctx} /></SheetView>}
      {current === 'capacity' && (
        <SheetView ctx={ctx} section="capacity" tabs={['Мощности', 'Выручка и OPEX', 'Журнал активов']} initial="bank"><Capacities ctx={ctx} /></SheetView>
      )}
      {current === 'roles' && <Codes ctx={ctx} />}
      {current === 'assistant' && <Assistant ctx={ctx} />}
      {current === 'rules' && <Config ctx={ctx} />}
      {current === 'settings' && <><Sheet ctx={ctx} /><section className="section"><StaffTab ctx={ctx} staff={staff} /></section></>}
      {current === 'branches' && <Branches ctx={ctx} />}
    </AdminShell>
  );
}

export type Ctx = { id: number; d: GameData; accounts: any[]; tacts: any[]; tick: number; reload: () => void };

const STATUS: Record<string, string> = { draft: 'не запущена', active: 'идёт', finished: 'завершена' };

function OpenTact({ tacts }: { tacts: any[] }) {
  const open = tacts.find((t) => !t.closed_at);
  return open ? <span className="chip accent">Идёт такт {open.number}</span> : null;
}

function LaunchBanner({ ctx }: { ctx: Ctx }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <div className="banner row between">
      <span>Игра не запущена. Проверьте роли, стартовые юрлица и балансы.</span>
      {ctx.d.can.run ? <button className="btn primary" onClick={() => setConfirm(true)}>Запустить игру</button>
        : <span className="small muted">Запускает ведущий ответвления</span>}
      {confirm && (
        <Confirm title="Запустить игру?" busy={busy} error={error} confirmText="Запустить" onCancel={() => setConfirm(false)}
          onConfirm={async () => {
            setBusy(true);
            try {
              await api(`/api/admin/games/${ctx.id}/launch`, { body: {} });
              setConfirm(false);
              ctx.reload();
            } catch (e: any) { setError(e.message); } finally { setBusy(false); }
          }}>
          Откроется такт 1, стартовые юрлица получат балансы, игроки смогут входить по кодам ролей.
        </Confirm>
      )}
    </div>
  );
}

// ---------- Filters ----------

interface F { tact?: number; role?: number; account?: number }
const qs = (f: F) => new URLSearchParams(Object.entries(f).filter(([, v]) => v).map(([k, v]) => [k, String(v)])).toString();

function Filters({ ctx, f, set, noTactAll }: { ctx: Ctx; f: F; set: (f: F) => void; noTactAll?: boolean }) {
  const roles = ctx.d.roles;
  return (
    <div className="filters">
      <Field label="Такт">
        <select value={f.tact ?? ''} onChange={(e) => set({ ...f, tact: Number(e.target.value) || undefined })}>
          <option value="">{noTactAll ? 'Текущий' : 'Все такты'}</option>
          {ctx.tacts.map((t) => <option key={t.id} value={t.id}>Такт {t.number}{t.closed_at ? '' : ' (идёт)'}</option>)}
        </select>
      </Field>
      <Field label="Игрок">
        <select value={f.role ?? ''} onChange={(e) => set({ ...f, role: Number(e.target.value) || undefined })}>
          <option value="">Все игроки</option>
          {roles.map((r) => <option key={r.id} value={r.id}>{r.players ? `${r.title} (${r.players})` : r.title}</option>)}
        </select>
      </Field>
      <Field label="Счёт">
        <select value={f.account ?? ''} onChange={(e) => set({ ...f, account: Number(e.target.value) || undefined })}>
          <option value="">Все счета</option>
          {ctx.accounts.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
        </select>
      </Field>
      <a className="btn" href={`/api/admin/games/${ctx.id}/export.xlsx?${qs(f)}`}>Скачать Excel</a>
    </div>
  );
}

function Transfers({ ctx }: { ctx: Ctx }) {
  const [f, setF] = useState<F>({});
  const list = useLoad(() => api<any[]>(`/api/admin/games/${ctx.id}/transfers?${qs(f)}`), [ctx.id, qs(f), ctx.tick]);
  const editable = ctx.d.can.run;
  return (
    <>
      <Filters ctx={ctx} f={f} set={setF} />
      <ErrorText error={list.error} />
      <div className="table-wrap">
        <table>
          <thead><tr><th>Дата и время</th><th>Такт</th><th>Тип</th><th>Инициатор</th><th>Отправитель</th><th>Получатель</th><th className="num">Сумма</th><th>Комментарий</th>{editable && <th></th>}</tr></thead>
          <tbody>
            {list.data?.map((t) => editable
              ? <TransferRow key={`${t.id}:${t.amount}:${t.from_account_id}:${t.to_account_id}:${t.comment}`} ctx={ctx} t={t} onSaved={list.reload} />
              : (
                <tr key={t.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{dateTime(t.created_at)}</td><td>{t.tact}</td><td>{KIND_LABEL[t.kind]}</td>
                  <td>{t.initiator}</td><td>{t.from_title}</td><td>{t.to_title}</td>
                  <td className="num"><Money value={t.amount} /></td><td>{t.comment}</td>
                </tr>
              ))}
          </tbody>
        </table>
        {list.data?.length === 0 && <Empty>Переводов нет</Empty>}
      </div>
    </>
  );
}

/** A transfer the host corrects in place: amount, accounts, comment; or removes it. Balances follow. */
function TransferRow({ ctx, t, onSaved }: { ctx: Ctx; t: any; onSaved: () => void }) {
  const [amount, setAmount] = useState(String(t.amount));
  const [from, setFrom] = useState(String(t.from_account_id));
  const [to, setTo] = useState(String(t.to_account_id));
  const [comment, setComment] = useState(t.comment);
  const [del, setDel] = useState(false);
  const [error, setError] = useState<string>();
  // Start capital and revenue/OPEX postings keep their accounts.
  const fixed = t.kind === 'initial' || t.posting;
  const options = ctx.accounts.map((a) => ({ value: String(a.id), label: a.title, group: ACCOUNT_KIND[a.kind] }));
  const dirty = amount !== String(t.amount) || from !== String(t.from_account_id) || to !== String(t.to_account_id) || comment !== t.comment;
  const act = async (fn: () => Promise<unknown>) => {
    setError(undefined);
    try { await fn(); onSaved(); } catch (e: any) { setError(e.message); }
  };
  const save = () => act(() => api(`/api/admin/games/${ctx.id}/transfers/${t.id}`, {
    method: 'PATCH', body: { amount: Number(amount), comment, ...(fixed ? {} : { fromAccountId: Number(from), toAccountId: Number(to) }) },
  }));
  return (
    <tr>
      <td style={{ whiteSpace: 'nowrap' }}>{dateTime(t.created_at)}</td><td>{t.tact}</td><td>{KIND_LABEL[t.kind]}</td>
      <td>{t.initiator}</td>
      <td className="pick">{fixed ? t.from_title : <Select value={from} onChange={setFrom} options={options} ariaLabel="Отправитель" />}</td>
      <td className="pick">{fixed ? t.to_title : <Select value={to} onChange={setTo} options={options} ariaLabel="Получатель" />}</td>
      <td className="num">
        <input className="cell-input num-input" inputMode="numeric" value={amount} aria-label="Сумма"
          onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} />
      </td>
      <td><input className="cell-input" value={comment} aria-label="Комментарий" onChange={(e) => setComment(e.target.value)} /></td>
      <td>
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <button className="btn small primary" disabled={!dirty || !(Number(amount) > 0)} onClick={save}>Сохранить</button>
          <button className="btn small danger" onClick={() => setDel(true)}>Удалить</button>
        </div>
        <ErrorText error={error} />
        {del && (
          <Confirm title="Удалить перевод?" confirmText="Удалить" onCancel={() => setDel(false)}
            onConfirm={() => { setDel(false); act(() => api(`/api/admin/games/${ctx.id}/transfers/${t.id}`, { method: 'DELETE' })); }}>
            {t.from_title} → {t.to_title}, {t.amount}. Деньги вернутся отправителю, итоги тактов пересчитаются.
          </Confirm>
        )}
      </td>
    </tr>
  );
}

function StaffTab({ ctx, staff }: { ctx: Ctx; staff: Staff }) {
  const all = useLoad(() => (staff.kind === 'super' ? api<Staff[]>('/api/admin/staff') : Promise.resolve([])), [staff.kind]);
  const [pick, setPick] = useState<number>();
  const [form, setForm] = useState({ name: '', login: '', password: '' });
  const [error, setError] = useState<string>();
  const canManage = staff.kind === 'super' || ctx.d.can.run;
  const act = async (fn: () => Promise<unknown>) => {
    setError(undefined);
    try { await fn(); ctx.reload(); all.reload(); } catch (e: any) { setError(e.message); }
  };
  const attached = new Set(ctx.d.staff.map((s) => s.id));

  return (
    <div className="grid-2">
      <section>
        <h3>Игротехники этой игры</h3>
        <p className="small muted">Права у всех одинаковые</p>
        <div className="list">
          {ctx.d.staff.map((s) => (
            <div key={s.id} className="list-item">
              <div className="grow"><div className="list-title">{s.name}</div><div className="list-sub">{s.login}</div></div>
              {canManage && s.id !== staff.id && (
                <button className="btn small danger" onClick={() => act(() => api(`/api/admin/games/${ctx.id}/staff/${s.id}`, { method: 'DELETE' }))}>Открепить</button>
              )}
            </div>
          ))}
          {ctx.d.staff.length === 0 && <Empty>Ведущий не назначен</Empty>}
        </div>
      </section>
      {canManage && (
        <section className="stack">
          {staff.kind === 'super' && (
            <div className="panel stack">
              <h3>Прикрепить ведущего</h3>
              <select value={pick ?? ''} onChange={(e) => setPick(Number(e.target.value))}>
                <option value="">Выберите…</option>
                {all.data?.filter((s) => !attached.has(s.id)).map((s) => <option key={s.id} value={s.id}>{s.name} ({s.login})</option>)}
              </select>
              <button className="btn" disabled={!pick} onClick={() => act(() => api(`/api/admin/games/${ctx.id}/staff`, { body: { staffId: pick } }))}>Прикрепить</button>
            </div>
          )}
          <form className="panel stack" onSubmit={(e) => { e.preventDefault(); act(async () => {
            await api(`/api/admin/games/${ctx.id}/staff`, { body: form });
            setForm({ name: '', login: '', password: '' });
          }); }}>
            <h3>Новый сотрудник канцелярии</h3>
            <Field label="Имя"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></Field>
            <Field label="Логин"><input value={form.login} onChange={(e) => setForm({ ...form, login: e.target.value })} required /></Field>
            <Field label="Пароль" hint="Не короче 6 символов"><input type="password" value={form.password} autoComplete="new-password" onChange={(e) => setForm({ ...form, password: e.target.value })} required minLength={6} /></Field>
            <button className="btn primary">Создать и прикрепить</button>
          </form>
          <ErrorText error={error} />
        </section>
      )}
    </div>
  );
}

function Branches({ ctx }: { ctx: Ctx }) {
  const hosts = useLoad(() => api<Staff[]>('/api/admin/staff'), []);
  const [title, setTitle] = useState('');
  const [host, setHost] = useState<number>();
  const [error, setError] = useState<string>();
  async function create(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    try {
      await api(`/api/admin/games/${ctx.id}/branches`, { body: { title, staffIds: host ? [host] : [] } });
      setTitle('');
      ctx.reload();
    } catch (err: any) { setError(err.message); }
  }
  return (
    <div className="grid-2">
      <section>
        <div className="list">
          {ctx.d.branches.map((b) => (
            <Link key={b.id} to={`/admin/g/${b.id}`} className="list-item">
              <div className="grow"><div className="list-title">{b.title}</div><div className="list-sub">Ведущий: {b.hosts || 'не назначен'}</div></div>
              <span className={b.status === 'active' ? 'chip accent' : 'chip'}>{STATUS[b.status]}</span>
            </Link>
          ))}
          {ctx.d.branches.length === 0 && <Empty>Ответвлений пока нет</Empty>}
        </div>
      </section>
      <form className="panel stack" onSubmit={create}>
        <h3>Новое ответвление</h3>
        <p className="small muted">Копия игры со всеми настройками. Деньги, переводы и такты у каждого ответвления свои.</p>
        <Field label="Название"><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={ctx.d.game.title} /></Field>
        <Field label="Ведущий (игротехник)">
          <select value={host ?? ''} onChange={(e) => setHost(Number(e.target.value) || undefined)}>
            <option value="">Назначить позже</option>
            {hosts.data?.filter((s) => s.kind === 'host').map((s) => <option key={s.id} value={s.id}>{s.name} ({s.login})</option>)}
          </select>
        </Field>
        <ErrorText error={error} />
        <button className="btn primary">Создать ответвление</button>
      </form>
    </div>
  );
}

import { FormEvent, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ACCOUNT_KIND, KIND_LABEL, api, dateTime, newKey, useLive, useLoad } from '../api';
import { Confirm, Empty, ErrorText, Field, Money, Tabs } from '../ui';
import type { Staff } from './AdminApp';
import { Config } from './Config';

export interface GameData {
  game: any; roles: any[]; startAccounts: any[]; priceItems: any[]; staff: Staff[]; branches: any[];
  can: { config: boolean; run: boolean; super: boolean };
}

type Tab = 'summary' | 'transfers' | 'people' | 'adjust' | 'tacts' | 'config' | 'staff' | 'branches';

export function GamePage({ staff }: { staff: Staff }) {
  const id = Number(useParams().id);
  const data = useLoad(() => api<GameData>(`/api/admin/games/${id}`), [id]);
  const accounts = useLoad(() => api<any[]>(`/api/admin/games/${id}/accounts`), [id]);
  const tacts = useLoad(() => api<any[]>(`/api/admin/games/${id}/tacts`), [id]);
  const [tab, setTab] = useState<Tab>();
  const [tick, setTick] = useState(0);
  useLive(id, () => { data.reload(); accounts.reload(); tacts.reload(); setTick((t) => t + 1); });

  const d = data.data;
  if (!d) return <ErrorText error={data.error} />;
  const isRoot = d.game.kind === 'root';
  const tabs: [Tab, string][] = isRoot
    ? [['config', 'Настройки'], ['branches', 'Ответвления']]
    : [['summary', 'Сводка'], ['transfers', 'Переводы'], ['people', 'Участники'],
      ...(d.can.run ? [['adjust', 'Начисления'] as [Tab, string]] : []), ['tacts', 'Такты'], ['config', 'Настройки'], ['staff', 'Ведущие']];
  const current = tab && tabs.some(([k]) => k === tab) ? tab : tabs[0][0];
  const ctx = { id, d, accounts: accounts.data ?? [], tacts: tacts.data ?? [], tick, reload: () => { data.reload(); accounts.reload(); tacts.reload(); } };

  return (
    <>
      <Link to="/admin" className="btn link">← Игры</Link>
      <div className="row between">
        <div>
          <h1>{d.game.title}</h1>
          <p className="muted small">
            {isRoot ? 'Корневая игра — изменения применяются во всех ответвлениях' : `Ответвление · ${STATUS[d.game.status]}`}
          </p>
        </div>
        {!isRoot && d.game.status === 'active' && <OpenTact tacts={ctx.tacts} />}
      </div>
      {!isRoot && d.game.status === 'draft' && <LaunchBanner ctx={ctx} />}
      <Tabs tabs={tabs} value={current} onChange={setTab} />
      {current === 'summary' && <Summary ctx={ctx} />}
      {current === 'transfers' && <Transfers ctx={ctx} />}
      {current === 'people' && <People ctx={ctx} />}
      {current === 'adjust' && <Adjust ctx={ctx} />}
      {current === 'tacts' && <Tacts ctx={ctx} />}
      {current === 'config' && <Config ctx={ctx} />}
      {current === 'staff' && <StaffTab ctx={ctx} staff={staff} />}
      {current === 'branches' && <Branches ctx={ctx} />}
    </>
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
          {roles.map((r) => <option key={r.id} value={r.id}>{r.player_id ? `${r.first_name} ${r.last_name} (${r.title})` : r.title}</option>)}
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

function SummaryTable({ ctx, f }: { ctx: Ctx; f: F }) {
  const s = useLoad(() => api<any>(`/api/admin/games/${ctx.id}/summary?${qs(f)}`), [ctx.id, qs(f), ctx.tick]);
  if (!s.data) return <ErrorText error={s.error} />;
  if (!s.data.tact) return <Empty>Игра ещё не запущена</Empty>;
  const rows = s.data.rows as any[];
  const players = rows.filter((r) => r.kind !== 'host');
  const sum = (k: string) => players.reduce((a, r) => a + r[k], 0);
  return (
    <>
      <p className="muted small">Такт {s.data.tact.number} · {s.data.tact.closed_at ? `завершён ${dateTime(s.data.tact.closed_at)}` : 'идёт, данные живые'}</p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Счёт</th><th>Тип</th><th>Владелец</th><th>Совладельцы</th><th className="num">На начало</th><th className="num">Получено</th><th className="num">Отправлено</th><th className="num">На конец</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.accountId}>
                <td>{r.title}</td><td>{ACCOUNT_KIND[r.kind]}</td><td>{r.owner}</td><td>{r.coowners}</td>
                <td className="num"><Money value={r.balanceStart} /></td><td className="num"><Money value={r.received} /></td>
                <td className="num"><Money value={r.sent} /></td><td className="num"><Money value={r.balanceEnd} /></td>
              </tr>
            ))}
          </tbody>
          {!f.role && !f.account && (
            <tfoot>
              <tr><td colSpan={4}>Итого у игроков</td><td className="num"><Money value={sum('balanceStart')} /></td>
                <td className="num"><Money value={sum('received')} /></td><td className="num"><Money value={sum('sent')} /></td>
                <td className="num"><Money value={sum('balanceEnd')} /></td></tr>
            </tfoot>
          )}
        </table>
      </div>
      <h3 className="section">Сколько денег у каждого игрока</h3>
      <p className="muted small">Сумма по счетам, где игрок владелец</p>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Игрок</th><th className="num">Всего</th></tr></thead>
          <tbody>{s.data.totals.map((t: any) => <tr key={t.owner}><td>{t.owner}</td><td className="num"><Money value={t.total} /></td></tr>)}</tbody>
        </table>
      </div>
    </>
  );
}

function Summary({ ctx }: { ctx: Ctx }) {
  const [f, setF] = useState<F>({});
  return (<><Filters ctx={ctx} f={f} set={setF} noTactAll /><SummaryTable ctx={ctx} f={f} /></>);
}

function Transfers({ ctx }: { ctx: Ctx }) {
  const [f, setF] = useState<F>({});
  const list = useLoad(() => api<any[]>(`/api/admin/games/${ctx.id}/transfers?${qs(f)}`), [ctx.id, qs(f), ctx.tick]);
  return (
    <>
      <Filters ctx={ctx} f={f} set={setF} />
      <ErrorText error={list.error} />
      <div className="table-wrap">
        <table>
          <thead><tr><th>Дата и время</th><th>Такт</th><th>Тип</th><th>Инициатор</th><th>Отправитель</th><th>Получатель</th><th className="num">Сумма</th><th>Комментарий</th></tr></thead>
          <tbody>
            {list.data?.map((t) => (
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

function People({ ctx }: { ctx: Ctx }) {
  const [error, setError] = useState<string>();
  const [release, setRelease] = useState<any>();
  const accountsOf = (roleId: number) => ctx.accounts.filter((a) => a.members.some((m: any) => m.roleId === roleId));
  const act = async (fn: () => Promise<unknown>) => {
    setError(undefined);
    try { await fn(); ctx.reload(); } catch (e: any) { setError(e.message); }
  };
  return (
    <>
      <ErrorText error={error} />
      <div className="table-wrap">
        <table>
          <thead><tr><th>Роль</th><th>Код</th><th>Игрок</th><th>Счета</th><th></th></tr></thead>
          <tbody>
            {ctx.d.roles.map((r) => (
              <tr key={r.id}>
                <td>{r.title}</td>
                <td><span className="code">{r.code}</span></td>
                <td>{r.player_id ? `${r.first_name} ${r.last_name}` : <span className="muted">не занята</span>}</td>
                <td>
                  {accountsOf(r.id).map((a) => {
                    const m = a.members.find((x: any) => x.roleId === r.id);
                    return (
                      <div key={a.id} className="row" style={{ gap: 4 }}>
                        <span>{a.title}</span>
                        <span className="chip">{m.member === 'owner' ? 'владелец' : m.pinOk ? 'совладелец' : 'совладелец, без PIN'}</span>
                        <Money value={a.balance} />
                      </div>
                    );
                  })}
                </td>
                <td>
                  {ctx.d.can.config && (
                    <div className="row">
                      <button className="btn small" onClick={() => act(() => api(`/api/admin/roles/${r.id}/code`, { body: {} }))}>Новый код</button>
                      {r.player_id && <button className="btn small danger" onClick={() => setRelease(r)}>Сбросить</button>}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {ctx.d.roles.length === 0 && <Empty>Ролей нет — добавьте их в настройках</Empty>}
      </div>
      {release && (
        <Confirm title="Сбросить привязку роли?" confirmText="Сбросить" onCancel={() => setRelease(undefined)}
          onConfirm={() => { act(() => api(`/api/admin/roles/${release.id}/release`, { body: {} })); setRelease(undefined); }}>
          {release.first_name} {release.last_name} потеряет доступ к роли «{release.title}». Счета роли сохранятся и перейдут тому, кто займёт роль.
        </Confirm>
      )}
    </>
  );
}

function Adjust({ ctx }: { ctx: Ctx }) {
  const [accountId, setAccount] = useState<number>();
  const [direction, setDirection] = useState<'credit' | 'debit'>('credit');
  const [amount, setAmount] = useState('');
  const [comment, setComment] = useState('');
  const [key, setKey] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();
  const players = ctx.accounts.filter((a) => a.kind !== 'host');
  const acc = players.find((a) => a.id === accountId);
  const n = Number(amount);

  async function submit() {
    setBusy(true);
    setError(undefined);
    try {
      await api(`/api/admin/games/${ctx.id}/adjust`, { body: { accountId, direction, amount: n, comment, idempotencyKey: key } });
      setDone(`${direction === 'credit' ? 'Начислено' : 'Списано'} ${n} — ${acc?.title}`);
      setKey(undefined);
      setAmount('');
      setComment('');
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }

  return (
    <form className="panel stack" style={{ maxWidth: 480 }} onSubmit={(e: FormEvent) => { e.preventDefault(); setError(undefined); setKey(newKey()); }}>
      <div className="chips" role="radiogroup" aria-label="Операция">
        <button type="button" className="chip-toggle" aria-pressed={direction === 'credit'} onClick={() => setDirection('credit')}>Начисление</button>
        <button type="button" className="chip-toggle" aria-pressed={direction === 'debit'} onClick={() => setDirection('debit')}>Списание</button>
      </div>
      <Field label="Счёт">
        <select value={accountId ?? ''} onChange={(e) => setAccount(Number(e.target.value))} required>
          <option value="">Выберите…</option>
          <optgroup label="Юрлица">{players.filter((a) => a.kind === 'legal').map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}</optgroup>
          <optgroup label="Физлица">{players.filter((a) => a.kind === 'individual').map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}</optgroup>
        </select>
      </Field>
      <Field label="Сумма"><input value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} inputMode="numeric" required /></Field>
      <Field label="Комментарий"><textarea value={comment} onChange={(e) => setComment(e.target.value)} maxLength={500} /></Field>
      {direction === 'debit' && <p className="small muted">Списание может увести счёт в минус.</p>}
      {done && <p className="ok small">{done}</p>}
      <button className="btn primary" disabled={!accountId || !(n > 0)}>Далее</button>
      {key && (
        <Confirm title={direction === 'credit' ? 'Начислить?' : 'Списать?'} busy={busy} error={error} onCancel={() => setKey(undefined)} onConfirm={submit}>
          <div className="summary-line"><span className="muted">Счёт</span><span>{acc?.title}</span></div>
          <div className="summary-line"><span className="muted">Сейчас</span><Money value={acc?.balance ?? 0} /></div>
          <div className="summary-line"><span className="muted">{direction === 'credit' ? 'Начисление' : 'Списание'}</span><Money value={direction === 'credit' ? n : -n} signed /></div>
        </Confirm>
      )}
    </form>
  );
}

function Tacts({ ctx }: { ctx: Ctx }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [view, setView] = useState<number>();
  const open = ctx.tacts.find((t) => !t.closed_at);
  const closed = ctx.tacts.filter((t) => t.closed_at).reverse();
  const shown = view ?? closed[0]?.id;

  return (
    <>
      {open && ctx.d.can.run && (
        <div className="banner row between">
          <span>Идёт такт {open.number} с {dateTime(open.started_at)}</span>
          <button className="btn primary" onClick={() => setConfirm(true)}>Завершить такт {open.number}</button>
        </div>
      )}
      {confirm && (
        <Confirm title={`Завершить такт ${open?.number}?`} busy={busy} error={error} confirmText="Завершить" onCancel={() => setConfirm(false)}
          onConfirm={async () => {
            setBusy(true);
            try {
              const r = await api(`/api/admin/games/${ctx.id}/close-tact`, { body: {} });
              setConfirm(false);
              setView(r.closed.id);
              ctx.reload();
            } catch (e: any) { setError(e.message); } finally { setBusy(false); }
          }}>
          Балансы зафиксируются в слепке, сразу начнётся такт {(open?.number ?? 0) + 1}. Переводы не останавливаются.
        </Confirm>
      )}
      {closed.length === 0 ? <Empty>Завершённых тактов пока нет</Empty> : (
        <>
          <div className="chips" style={{ marginBottom: 16 }}>
            {closed.map((t) => (
              <button key={t.id} className="chip-toggle" aria-pressed={shown === t.id} onClick={() => setView(t.id)}>Слепок такта {t.number}</button>
            ))}
          </div>
          {shown && <SummaryTable ctx={ctx} f={{ tact: shown }} />}
        </>
      )}
    </>
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
        <h3>Ведущие и канцелярия этой игры</h3>
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

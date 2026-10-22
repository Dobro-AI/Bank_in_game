import { FormEvent, ReactNode, useState } from 'react';
import { Link, Route, Routes, useNavigate } from 'react-router-dom';
import { api, useLoad } from '../api';
import { Empty, ErrorText, Field } from '../ui';
import { BadgeIcon, GridIcon } from '../icons';
import { GamePage } from './GamePage';
import { AdminShell, NavItem } from './Shell';

export interface Staff { id: number; name: string; login: string; kind: 'super' | 'host' }

export function AdminApp() {
  const me = useLoad(() => api<{ staff: Staff | null }>('/api/me'), []);
  if (!me.data) return <main className="page narrow"><ErrorText error={me.error} /></main>;
  const staff = me.data.staff;
  if (!staff) return <div className="bank"><Login onDone={me.reload} /></div>;

  const items: NavItem[] = [
    { to: '/admin', label: staff.kind === 'super' ? 'Игры' : 'Мои игры', icon: <GridIcon />, end: true },
    ...(staff.kind === 'super' ? [{ to: '/admin/staff', label: 'Ведущие', icon: <BadgeIcon /> }] : []),
  ];
  const home = (page: ReactNode) => (
    <AdminShell staff={staff} title="Кабинет ведущего" subtitle="Игровой банк" items={items} onLogout={me.reload}>{page}</AdminShell>
  );

  return (
    <Routes>
      <Route index element={home(<Games staff={staff} />)} />
      <Route path="staff" element={home(<StaffPage />)} />
      <Route path="g/:id/:section?" element={<GamePage staff={staff} onLogout={me.reload} />} />
    </Routes>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await api('/api/staff/login', { body: { login, password } });
      onDone();
    } catch (err: any) {
      setError(err.message);
    }
  }
  return (
    <main className="page narrow center-page">
      <h1>Вход для ведущих</h1>
      <form className="stack" onSubmit={submit}>
        <Field label="Логин"><input value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="username" required /></Field>
        <Field label="Пароль"><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required /></Field>
        <ErrorText error={error} />
        <button className="btn primary block">Войти</button>
        <Link to="/" className="btn link">← На главную</Link>
      </form>
    </main>
  );
}

const STATUS: Record<string, string> = { draft: 'не запущена', active: 'идёт', finished: 'завершена' };

function Games({ staff }: { staff: Staff }) {
  const nav = useNavigate();
  const games = useLoad(() => api<any[]>('/api/admin/games'), []);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string>();
  const roots = (games.data ?? []).filter((g) => g.kind === 'root');
  const branches = (games.data ?? []).filter((g) => g.kind === 'branch');

  async function create(e: FormEvent) {
    e.preventDefault();
    try {
      const g = await api('/api/admin/games', { body: { title } });
      nav(`/admin/g/${g.id}`);
    } catch (err: any) {
      setError(err.message);
    }
  }

  const branchRow = (b: any) => (
    <Link key={b.id} to={`/admin/g/${b.id}`} className="list-item">
      <div className="grow">
        <div className="list-title">{b.title}</div>
        <div className="list-sub">Ведущий: {b.hosts || 'не назначен'}</div>
      </div>
      <span className={b.status === 'active' ? 'chip accent' : 'chip'}>{STATUS[b.status]}</span>
    </Link>
  );

  return (
    <>
      <ErrorText error={games.error} />
      {staff.kind === 'super' ? (
        <>
          <h1>Игры</h1>
          <form className="row section" onSubmit={create}>
            <input className="grow" style={{ width: 'auto' }} placeholder="Название новой игры" value={title} onChange={(e) => setTitle(e.target.value)} required />
            <button className="btn primary">Создать игру</button>
          </form>
          <ErrorText error={error} />
          {roots.map((r) => (
            <section key={r.id} className="section">
              <div className="row between">
                <h2 style={{ margin: 0 }}>{r.title}</h2>
                <Link to={`/admin/g/${r.id}`} className="btn small">Настройки и ответвления</Link>
              </div>
              <div className="list" style={{ marginTop: 12 }}>
                {branches.filter((b) => b.parent_id === r.id).map(branchRow)}
                {!branches.some((b) => b.parent_id === r.id) && <Empty>Ответвлений пока нет</Empty>}
              </div>
            </section>
          ))}
          {roots.length === 0 && games.data && <Empty>Создайте первую игру</Empty>}
        </>
      ) : (
        <>
          <h1>Мои игры</h1>
          <div className="list">
            {branches.map(branchRow)}
            {games.data && branches.length === 0 && <Empty>Вас ещё не прикрепили ни к одной игре</Empty>}
          </div>
        </>
      )}
    </>
  );
}

function StaffPage() {
  const list = useLoad(() => api<Staff[]>('/api/admin/staff'), []);
  const [form, setForm] = useState({ name: '', login: '', password: '' });
  const [error, setError] = useState<string>();
  async function create(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    try {
      await api('/api/admin/staff', { body: form });
      setForm({ name: '', login: '', password: '' });
      list.reload();
    } catch (err: any) {
      setError(err.message);
    }
  }
  return (
    <div className="grid-2">
      <section>
        <h1>Ведущие</h1>
        <div className="list">
          {list.data?.map((s) => (
            <div key={s.id} className="list-item">
              <div className="grow"><div className="list-title">{s.name}</div><div className="list-sub">{s.login}</div></div>
              <span className="chip">{s.kind === 'super' ? 'Супер-ведущий' : 'ведущий'}</span>
            </div>
          ))}
        </div>
      </section>
      <form className="panel stack" onSubmit={create}>
        <h2>Новый ведущий</h2>
        <Field label="Имя"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></Field>
        <Field label="Логин"><input value={form.login} onChange={(e) => setForm({ ...form, login: e.target.value })} required /></Field>
        <Field label="Пароль" hint="Не короче 6 символов"><input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required minLength={6} autoComplete="new-password" /></Field>
        <ErrorText error={error} />
        <button className="btn primary">Создать</button>
      </form>
    </div>
  );
}

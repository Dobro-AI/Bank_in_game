import { useState } from 'react';
import { Link, NavLink, Route, Routes } from 'react-router-dom';
import { ACCOUNT_KIND, api, useLive, useLoad } from '../api';
import { ErrorText, Money } from '../ui';
import { AccountPage, ConnectByPin, NewLegal } from './Accounts';
import { PlayerCapacity } from './Capacity';
import { History, OperationRow } from './History';
import { BoxIcon, BuildingIcon, ChartIcon, ChevronIcon, HistoryIcon, HomeIcon, MoreIcon, PlusIcon, TransferIcon } from '../icons';
import { Join } from './Join';
import { ResultsBoard, type Results } from '../Results';
import { TactClock, TactTimer } from '../TactTimer';
import { telegramLogin } from '../telegram';
import { ScreenHeader } from './Screen';
import { AmountPage, RecipientPicker } from './Transfer';
import { Account, Me, Operation, canSpend } from './types';

export function PlayerApp() {
  // Inside Telegram, log in by the Mini App data first; elsewhere this does nothing.
  const me = useLoad(async () => { await telegramLogin('player'); return api<{ player: Me | null }>('/api/me'); }, []);
  if (!me.data) return <main className="page narrow"><ErrorText error={me.error} /></main>;
  if (!me.data.player) return <div className="bank"><Join onJoined={me.reload} /></div>;
  return <Bank me={me.data.player} onLogout={me.reload} />;
}

const NAV = [
  { to: '/play', label: 'Главная', icon: <HomeIcon />, end: true },
  { to: '/play/transfer', label: 'Переводы', icon: <TransferIcon /> },
  { to: '/play/history', label: 'История', icon: <HistoryIcon /> },
  { to: '/play/capacity', label: 'Мощности', icon: <BoxIcon /> },
  { to: '/play/results', label: 'Итоги', icon: <ChartIcon /> },
  { to: '/play/more', label: 'Ещё', icon: <MoreIcon /> },
];

/** "Итоги тактов" for players: every company's balance after each tact, live. */
function PlayerResults({ tick }: { tick: number }) {
  const r = useLoad(() => api<Results>('/api/player/results'), [tick]);
  return (
    <>
      <ScreenHeader title="Итоги тактов" />
      {r.data ? <ResultsBoard data={r.data} /> : <ErrorText error={r.error} />}
    </>
  );
}

/** App shell: left sidebar on desktop, bottom tab bar on phones. */
function Bank({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const accounts = useLoad(() => api<Account[]>('/api/player/accounts'), []);
  const history = useLoad(() => api<Operation[]>('/api/player/history'), []);
  // The countdown: the server's clock is the reference, so the device clock is corrected by `offset`.
  const tact = useLoad(async () => {
    const r = await api<{ tact: TactClock | null; now: string }>('/api/player/tact');
    return { ...r, offset: new Date(r.now).getTime() - Date.now() };
  }, []);
  const [tick, setTick] = useState(0);
  useLive(me.gameId, () => { accounts.reload(); history.reload(); tact.reload(); setTick((t) => t + 1); });
  // The company comes first: it opens by default and transfers go from it.
  const list = [...(accounts.data ?? [])].sort((a, b) => Number(b.kind === 'legal') - Number(a.kind === 'legal'));
  const ops = history.data ?? [];

  return (
    <div className="bank bank-shell">
      <nav className="bank-nav" aria-label="Разделы">
        <div className="bank-brand">
          <div className="bank-brand-title">{me.gameTitle}</div>
          <div className="bank-brand-sub">{me.firstName} {me.lastName} · {me.roleTitle}</div>
        </div>
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `bank-nav-item${isActive ? ' active' : ''}`}>
            {n.icon}<span>{n.label}</span>
          </NavLink>
        ))}
      </nav>
      <main className="bank-main">
        <TactTimer tact={tact.data?.tact} offset={tact.data?.offset} />
        <ErrorText error={accounts.error} />
        {accounts.data && (
          <Routes>
            <Route index element={<Home me={me} accounts={list} ops={ops} />} />
            <Route path="transfer" element={<RecipientPicker accounts={list} />} />
            <Route path="transfer/:toId" element={<AmountPage accounts={list} />} />
            <Route path="history" element={<History accounts={list} ops={ops} />} />
            <Route path="capacity" element={<PlayerCapacity tick={tick} />} />
            <Route path="results" element={<PlayerResults tick={tick} />} />
            <Route path="more" element={<More me={me} accounts={list} onLogout={onLogout} />} />
            <Route path="more/connect" element={<ConnectByPin accounts={list} reload={accounts.reload} />} />
            <Route path="new" element={<NewLegal me={me} />} />
            <Route path="a/:id" element={<AccountPage accounts={list} ops={ops} me={me} reload={accounts.reload} />} />
          </Routes>
        )}
      </main>
    </div>
  );
}

function Home({ me, accounts, ops }: { me: Me; accounts: Account[]; ops: Operation[] }) {
  const total = accounts.reduce((s, a) => s + a.balance, 0);
  const mine = new Set(accounts.map((a) => a.id));
  return (
    <>
      <header className="home-head">
        <div className="muted small">{me.firstName}, всего на счетах</div>
        <div className="home-total"><Money value={total} /></div>
      </header>

      <div className="quick-actions">
        <Link to="/play/transfer" className="quick"><span className="quick-icon"><TransferIcon /></span>Перевести</Link>
        <Link to="/play/history" className="quick"><span className="quick-icon"><HistoryIcon /></span>История</Link>
        <Link to="/play/new" className="quick"><span className="quick-icon"><PlusIcon /></span>Юрлицо</Link>
      </div>

      <section className="card-list" aria-label="Счета">
        {accounts.map((a) => (
          <Link key={a.id} to={`/play/a/${a.id}`} className="account-card">
            <span className="avatar">{a.kind === 'legal' ? <BuildingIcon /> : me.firstName[0]}</span>
            <span className="grow">
              <span className="account-card-balance"><Money value={a.balance} /></span>
              <span className="account-card-title">{a.title}</span>
            </span>
            <span className="account-card-meta">
              {!canSpend(a) ? <span className="chip warn">нужен PIN</span> : <span className="muted tiny">{ACCOUNT_KIND[a.kind]}</span>}
            </span>
          </Link>
        ))}
      </section>

      <section className="section">
        <div className="row between">
          <h2 className="section-title">Последние операции</h2>
          <Link to="/play/history" className="text-link">Все</Link>
        </div>
        <div className="op-list">
          {ops.slice(0, 5).map((o) => <OperationRow key={o.id} op={o} mine={mine} />)}
          {ops.length === 0 && <p className="empty">Операций пока нет</p>}
        </div>
      </section>
    </>
  );
}

function More({ me, accounts, onLogout }: { me: Me; accounts: Account[]; onLogout: () => void }) {
  const owned = accounts.filter((a) => a.kind === 'legal');
  const row = (to: string, title: string, sub?: string) => (
    <Link to={to} className="settings-row">
      <span className="grow"><span className="settings-title">{title}</span>{sub && <span className="settings-sub">{sub}</span>}</span>
      <ChevronIcon />
    </Link>
  );
  return (
    <>
      <ScreenHeader title="Ещё" />
      <div className="profile">
        <span className="avatar large">{me.firstName[0]}{me.lastName[0]}</span>
        <div>
          <div className="settings-title">{me.firstName} {me.lastName}</div>
          <div className="settings-sub">{me.roleTitle} · {me.gameTitle}</div>
        </div>
      </div>
      <div className="settings-group">
        {row('/play/new', 'Завести новое юрлицо', 'Название, совладельцы, PIN')}
        {row('/play/more/connect', 'Подключить юрлицо по PIN', 'Если владелец сообщил вам PIN')}
      </div>
      {owned.length > 0 && (
        <>
          <h2 className="section-title">Юрлица</h2>
          <div className="settings-group">
            {owned.map((a) => row(`/play/a/${a.id}`, a.title, a.member === 'owner' ? 'Владелец · совладельцы, PIN, передача' : 'Совладелец'))}
          </div>
        </>
      )}
      <div className="settings-group">
        <button className="settings-row danger-text" onClick={async () => { await api('/api/logout', { body: { who: 'player' } }); onLogout(); }}>
          <span className="grow settings-title">Выйти</span>
        </button>
      </div>
    </>
  );
}

import { FormEvent, ReactNode, useMemo, useState } from 'react';
import { Link, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ACCOUNT_KIND, api, dateTime, money, newKey, useLive, useLoad } from '../api';
import { Confirm, Empty, ErrorText, Field, Money } from '../ui';
import { Join } from './Join';

interface Me { playerId: number; roleId: number; gameId: number; firstName: string; lastName: string; roleTitle: string; gameTitle: string }
interface Member { roleId: number; roleTitle: string; playerName: string; member: 'owner' | 'coowner'; pinOk: boolean }
interface Account { id: number; kind: string; title: string; balance: number; member: 'owner' | 'coowner'; pinOk: boolean; members: Member[] }
interface Recipient { id: number; kind: string; title: string }

const canSpend = (a: Account) => a.member === 'owner' || a.pinOk;
const memberName = (m: Member) => (m.playerName ? `${m.playerName} (${m.roleTitle})` : m.roleTitle);

export function PlayerApp() {
  const me = useLoad(() => api<{ player: Me | null }>('/api/me'), []);
  if (!me.data) return <main className="page narrow"><ErrorText error={me.error} /></main>;
  if (!me.data.player) return <Join onJoined={me.reload} />;
  return <Cabinet me={me.data.player} onLogout={me.reload} />;
}

function Cabinet({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const accounts = useLoad(() => api<Account[]>('/api/player/accounts'), []);
  useLive(me.gameId, accounts.reload);
  const list = accounts.data ?? [];

  return (
    <>
      <header className="topbar">
        <Link to="/play" className="title grow" style={{ color: 'inherit', textDecoration: 'none' }}>{me.gameTitle}</Link>
        <span className="small muted">{me.firstName} {me.lastName} · {me.roleTitle}</span>
      </header>
      <main className="page narrow">
        <ErrorText error={accounts.error} />
        {accounts.data && <Routes>
          <Route index element={<Home accounts={list} />} />
          <Route path="a/:id" element={<AccountPage accounts={list} me={me} reload={accounts.reload} />} />
          <Route path="send" element={<Send accounts={list} />} />
          <Route path="pay" element={<Pay accounts={list} />} />
          <Route path="new" element={<NewLegal me={me} />} />
          <Route path="settings" element={<Settings accounts={list} reload={accounts.reload} onLogout={onLogout} />} />
        </Routes>}
      </main>
    </>
  );
}

function Home({ accounts }: { accounts: Account[] }) {
  return (
    <>
      <h1>Мои счета</h1>
      <div className="list">
        {accounts.map((a) => (
          <Link key={a.id} to={`/play/a/${a.id}`} className="list-item">
            <div className="grow">
              <div className="list-title">{a.title}</div>
              <div className="list-sub">
                {ACCOUNT_KIND[a.kind]}{a.member === 'coowner' ? ' · совладелец' : ''}
              </div>
            </div>
            {!canSpend(a) && <span className="chip warn">нужен PIN</span>}
            <Money value={a.balance} />
          </Link>
        ))}
        {accounts.length === 0 && <Empty>Счетов пока нет</Empty>}
      </div>
      <div className="stack section">
        <Link to="/play/send" className="btn primary block">Перевести</Link>
        <Link to="/play/pay" className="btn block">Оплатить по прайсу</Link>
        <Link to="/play/new" className="btn block">Завести новое юрлицо</Link>
        <Link to="/play/settings" className="btn link">Настройки</Link>
      </div>
    </>
  );
}

function Back({ to = '/play', children = '← Мои счета' }: { to?: string; children?: ReactNode }) {
  return <Link to={to} className="btn link">{children}</Link>;
}

function AccountPage({ accounts, me, reload }: { accounts: Account[]; me: Me; reload: () => void }) {
  const id = Number(useParams().id);
  const acc = accounts.find((a) => a.id === id);
  const history = useLoad(() => api<any[]>(`/api/player/accounts/${id}/history`), [id, acc?.balance]);
  if (!acc) return <><Back /><Empty>Счёт не найден</Empty></>;
  const isOwnerLegal = acc.kind === 'legal' && acc.member === 'owner';

  return (
    <>
      <Back />
      <p className="muted small">{ACCOUNT_KIND[acc.kind]}</p>
      <h1>{acc.title}</h1>
      <div className="balance-big"><Money value={acc.balance} /></div>
      {canSpend(acc) && (
        <Link to={`/play/send?from=${acc.id}`} className="btn primary block section">Перевести с этого счёта</Link>
      )}
      {!canSpend(acc) && <PinConfirm account={acc} onDone={reload} />}

      {acc.kind === 'legal' && (
        <section className="section">
          <h3>Участники</h3>
          <div className="list">
            {acc.members.map((m) => (
              <div key={m.roleId} className="list-item">
                <div className="grow">{memberName(m)}</div>
                <span className={m.member === 'owner' ? 'chip accent' : 'chip'}>{m.member === 'owner' ? 'владелец' : 'совладелец'}</span>
                {m.member === 'coowner' && !m.pinOk && <span className="chip warn">без PIN</span>}
              </div>
            ))}
          </div>
        </section>
      )}
      {isOwnerLegal && <OwnerTools account={acc} me={me} reload={reload} />}

      <section className="section">
        <h3>История операций</h3>
        <div className="list">
          {history.data?.map((t) => {
            const incoming = t.to_account_id === acc.id;
            return (
              <div key={t.id} className="list-item">
                <div className="grow">
                  <div className="list-title">{incoming ? t.from_title : t.to_title}</div>
                  <div className="list-sub">
                    {dateTime(t.created_at)} · такт {t.tact}{t.comment ? ` · ${t.comment}` : ''}
                  </div>
                  {t.initiator && <div className="tiny muted">{t.initiator}</div>}
                </div>
                <Money value={incoming ? t.amount : -t.amount} signed />
              </div>
            );
          })}
          {history.data?.length === 0 && <Empty>Операций пока нет</Empty>}
        </div>
      </section>
    </>
  );
}

function PinConfirm({ account, onDone }: { account: Account; onDone: () => void }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string>();
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await api(`/api/player/accounts/${account.id}/pin-confirm`, { body: { pin } });
      onDone();
    } catch (err: any) {
      setError(err.message);
    }
  }
  return (
    <form className="panel stack section" onSubmit={submit}>
      <p className="small">Вы совладелец. Чтобы переводить с этого счёта, один раз введите его PIN.</p>
      <Field label="PIN счёта">
        <input value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))} inputMode="numeric" className="code" required />
      </Field>
      <ErrorText error={error} />
      <button className="btn primary" disabled={pin.length !== 4}>Подтвердить</button>
    </form>
  );
}

function RolePicker({ selected, onToggle, exclude }: { selected: number[]; onToggle: (id: number) => void; exclude: number }) {
  const roles = useLoad(() => api<{ id: number; title: string; playerName: string | null }[]>('/api/player/roles'), []);
  return (
    <div className="chips">
      {roles.data?.filter((r) => r.id !== exclude).map((r) => (
        <button type="button" key={r.id} className="chip-toggle" aria-pressed={selected.includes(r.id)} onClick={() => onToggle(r.id)}>
          {r.playerName ? `${r.playerName} (${r.title})` : r.title}
        </button>
      ))}
    </div>
  );
}

function OwnerTools({ account, me, reload }: { account: Account; me: Me; reload: () => void }) {
  const nav = useNavigate();
  const [co, setCo] = useState(account.members.filter((m) => m.member === 'coowner').map((m) => m.roleId));
  const [pin, setPin] = useState('');
  const [newOwner, setNewOwner] = useState<number>();
  const [confirmOwner, setConfirmOwner] = useState(false);
  const [msg, setMsg] = useState<string>();
  const [error, setError] = useState<string>();
  const roles = useLoad(() => api<{ id: number; title: string; playerName: string | null }[]>('/api/player/roles'), []);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setError(undefined);
    setMsg(undefined);
    try {
      await fn();
      setMsg(ok);
      reload();
    } catch (e: any) {
      setError(e.message);
    }
  };

  return (
    <section className="section stack">
      <h3>Управление юрлицом</h3>
      <div className="panel stack">
        <Field label="Совладельцы"><RolePicker selected={co} exclude={me.roleId}
          onToggle={(id) => setCo((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))} /></Field>
        <button className="btn" onClick={() => run(() => api(`/api/player/accounts/${account.id}/coowners`, { body: { roleIds: co } }), 'Состав совладельцев сохранён')}>
          Сохранить совладельцев
        </button>
      </div>
      <div className="panel stack">
        <Field label="Новый PIN"><input value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))} inputMode="numeric" className="code" /></Field>
        <button className="btn" disabled={pin.length !== 4}
          onClick={() => run(() => api(`/api/player/accounts/${account.id}/pin`, { body: { pin } }), 'PIN изменён')}>Сменить PIN</button>
      </div>
      <div className="panel stack">
        <Field label="Передать юрлицо" hint="Новый владелец получает счёт сразу, вы теряете доступ">
          <select value={newOwner ?? ''} onChange={(e) => setNewOwner(Number(e.target.value) || undefined)}>
            <option value="">Кому…</option>
            {roles.data?.filter((r) => r.id !== me.roleId).map((r) => (
              <option key={r.id} value={r.id}>{r.playerName ? `${r.playerName} (${r.title})` : r.title}</option>
            ))}
          </select>
        </Field>
        <button className="btn danger" disabled={!newOwner} onClick={() => setConfirmOwner(true)}>Передать</button>
      </div>
      {msg && <p className="ok small">{msg}</p>}
      <ErrorText error={error} />
      {confirmOwner && (
        <Confirm title="Передать юрлицо?" confirmText="Передать" onCancel={() => setConfirmOwner(false)}
          onConfirm={() => run(async () => {
            await api(`/api/player/accounts/${account.id}/owner`, { body: { roleId: newOwner } });
            nav('/play');
          }, 'Юрлицо передано')}>
          «{account.title}» перейдёт к другому игроку. Вернуть его сможет только новый владелец.
        </Confirm>
      )}
    </section>
  );
}

/** Groups recipients: game master, legal entities, individuals (agreed order). */
function RecipientSelect({ value, onChange, exclude }: { value?: number; onChange: (id: number) => void; exclude?: number }) {
  const list = useLoad(() => api<Recipient[]>('/api/player/recipients'), []);
  const items = (list.data ?? []).filter((r) => r.id !== exclude);
  const group = (kind: string) => items.filter((r) => r.kind === kind);
  return (
    <select value={value ?? ''} onChange={(e) => onChange(Number(e.target.value))} required>
      <option value="">Выберите получателя…</option>
      {group('host').map((r) => <option key={r.id} value={r.id}>Игротехник (ведущий)</option>)}
      <optgroup label="Юрлица">{group('legal').map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}</optgroup>
      <optgroup label="Физлица">{group('individual').map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}</optgroup>
    </select>
  );
}

function useRecipientTitle(id?: number) {
  const list = useLoad(() => api<Recipient[]>('/api/player/recipients'), []);
  const r = list.data?.find((x) => x.id === id);
  return r ? (r.kind === 'host' ? 'Игротехник' : r.title) : '';
}

function Send({ accounts }: { accounts: Account[] }) {
  const [params] = useSearchParams();
  const spendable = accounts.filter(canSpend);
  const [picked, setFrom] = useState<number | undefined>(Number(params.get('from')) || undefined);
  // Accounts may arrive after the first render, so fall back to the first spendable one.
  const from = picked ?? spendable[0]?.id;
  const [to, setTo] = useState<number>();
  const [amount, setAmount] = useState('');
  const [comment, setComment] = useState('');
  const [confirm, setConfirm] = useState<{ key: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);
  const fromAcc = accounts.find((a) => a.id === from);
  const toTitle = useRecipientTitle(to);
  const n = Number(amount);
  const formError = !amount ? '' : !Number.isInteger(n) || n <= 0 ? 'Сумма — целое число больше нуля'
    : fromAcc && n > fromAcc.balance ? 'Недостаточно средств' : '';

  async function send() {
    setBusy(true);
    setError(undefined);
    try {
      // The same key is reused on retry, so a lost response or a second tap never charges twice.
      await api('/api/player/transfers', { body: { fromAccountId: from, toAccountId: to, amount: n, comment, idempotencyKey: confirm!.key } });
      setDone(true);
      setConfirm(undefined);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="stack">
        <h1>Перевод выполнен</h1>
        <p><Money value={n} /> → {toTitle}</p>
        <Link to="/play" className="btn primary block">К счетам</Link>
        <button className="btn block" onClick={() => { setDone(false); setAmount(''); setComment(''); setTo(undefined); }}>Ещё перевод</button>
      </div>
    );
  }

  return (
    <>
      <Back />
      <h1>Перевод</h1>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); setError(undefined); setConfirm({ key: newKey() }); }}>
        <Field label="Со счёта">
          <select value={from ?? ''} onChange={(e) => setFrom(Number(e.target.value))} required>
            {spendable.map((a) => <option key={a.id} value={a.id}>{a.title} — {money(a.balance)}</option>)}
          </select>
        </Field>
        <Field label="Получатель"><RecipientSelect value={to} onChange={setTo} exclude={from} /></Field>
        <Field label="Сумма">
          <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))} inputMode="numeric" required />
        </Field>
        <Field label="Комментарий" hint="Необязательно"><textarea value={comment} onChange={(e) => setComment(e.target.value)} maxLength={500} /></Field>
        <ErrorText error={formError} />
        <button className="btn primary block" disabled={!from || !to || !amount || !!formError}>Далее</button>
      </form>
      {confirm && (
        <Confirm title="Подтвердите перевод" busy={busy} error={error} onCancel={() => setConfirm(undefined)} onConfirm={send} confirmText="Перевести">
          <div className="summary-line"><span className="muted">Откуда</span><span>{fromAcc?.title}</span></div>
          <div className="summary-line"><span className="muted">Куда</span><span>{toTitle}</span></div>
          <div className="summary-line"><span className="muted">Сумма</span><Money value={n} /></div>
          {comment && <div className="summary-line"><span className="muted">Комментарий</span><span>{comment}</span></div>}
        </Confirm>
      )}
    </>
  );
}

function Pay({ accounts }: { accounts: Account[] }) {
  const spendable = accounts.filter(canSpend);
  const items = useLoad(() => api<{ id: number; title: string; price: number }[]>('/api/player/price-items'), []);
  const [picked, setFrom] = useState<number>();
  const from = picked ?? spendable[0]?.id;
  const [item, setItem] = useState<{ id: number; title: string; price: number }>();
  const [key, setKey] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();
  const fromAcc = accounts.find((a) => a.id === from);

  async function pay() {
    setBusy(true);
    setError(undefined);
    try {
      await api('/api/player/pay-fixed', { body: { fromAccountId: from, priceItemId: item!.id, idempotencyKey: key } });
      setDone(item!.title);
      setItem(undefined);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Back />
      <h1>Оплата по прайсу</h1>
      <p className="muted small">Деньги уходят игротехнику. Свободную сумму можно перевести через «Перевести».</p>
      {done && <p className="ok">Оплачено: {done}</p>}
      <Field label="Со счёта">
        <select value={from ?? ''} onChange={(e) => setFrom(Number(e.target.value))}>
          {spendable.map((a) => <option key={a.id} value={a.id}>{a.title} — {money(a.balance)}</option>)}
        </select>
      </Field>
      <div className="list section">
        {items.data?.map((i) => (
          <button key={i.id} className="list-item" disabled={!from} onClick={() => { setItem(i); setKey(newKey()); setError(undefined); }}>
            <div className="grow list-title">{i.title}</div>
            <Money value={i.price} />
          </button>
        ))}
        {items.data?.length === 0 && <Empty>Ведущий ещё не заполнил прайс</Empty>}
      </div>
      {item && (
        <Confirm title="Подтвердите оплату" busy={busy} error={error} onCancel={() => setItem(undefined)} onConfirm={pay} confirmText="Оплатить">
          <div className="summary-line"><span className="muted">Позиция</span><span>{item.title}</span></div>
          <div className="summary-line"><span className="muted">Со счёта</span><span>{fromAcc?.title}</span></div>
          <div className="summary-line"><span className="muted">Сумма</span><Money value={item.price} /></div>
          {fromAcc && fromAcc.balance < item.price && <p className="small muted">После оплаты баланс станет отрицательным.</p>}
        </Confirm>
      )}
    </>
  );
}

function NewLegal({ me }: { me: Me }) {
  const nav = useNavigate();
  const [title, setTitle] = useState('');
  const [co, setCo] = useState<number[]>([]);
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const mismatch = pin2.length === 4 && pin !== pin2;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api<{ id: number }>('/api/player/legal', { body: { title, coownerRoleIds: co, pin } });
      nav(`/play/a/${r.id}`);
    } catch (err: any) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <>
      <Back />
      <h1>Новое юрлицо</h1>
      <form className="stack" onSubmit={submit}>
        <Field label="Название"><input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} /></Field>
        <Field label="Владелец"><span>{me.firstName} {me.lastName} ({me.roleTitle})</span></Field>
        <Field label="Совладельцы" hint="Увидят счёт сразу; переводить смогут после ввода PIN">
          <RolePicker selected={co} exclude={me.roleId} onToggle={(id) => setCo((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))} />
        </Field>
        <Field label="Придумайте PIN" hint="4 цифры — сообщите их совладельцам">
          <input value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))} inputMode="numeric" className="code" required />
        </Field>
        <Field label="Повторите PIN">
          <input value={pin2} onChange={(e) => setPin2(e.target.value.replace(/\D/g, '').slice(0, 4))} inputMode="numeric" className="code" required />
        </Field>
        <ErrorText error={mismatch ? 'PIN не совпадает' : error} />
        <button className="btn primary block" disabled={busy || !title || pin.length !== 4 || pin !== pin2}>Создать</button>
      </form>
    </>
  );
}

function Settings({ accounts, reload, onLogout }: { accounts: Account[]; reload: () => void; onLogout: () => void }) {
  const recipients = useLoad(() => api<Recipient[]>('/api/player/recipients'), []);
  const mine = useMemo(() => new Set(accounts.map((a) => a.id)), [accounts]);
  const [acc, setAcc] = useState<number>();
  const [pin, setPin] = useState('');
  const [msg, setMsg] = useState<string>();
  const [error, setError] = useState<string>();

  async function connect(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    try {
      await api(`/api/player/accounts/${acc}/pin-confirm`, { body: { pin } });
      setMsg('Счёт подключён');
      setPin('');
      reload();
    } catch (err: any) {
      setError(err.message);
    }
  }

  return (
    <>
      <Back />
      <h1>Настройки</h1>
      <form className="panel stack" onSubmit={connect}>
        <h3>Подключить юрлицо по PIN</h3>
        <p className="small muted">Если владелец сообщил вам PIN, вы станете совладельцем.</p>
        <Field label="Юрлицо">
          <select value={acc ?? ''} onChange={(e) => setAcc(Number(e.target.value))} required>
            <option value="">Выберите…</option>
            {recipients.data?.filter((r) => r.kind === 'legal' && !mine.has(r.id)).map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
          </select>
        </Field>
        <Field label="PIN"><input value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))} inputMode="numeric" className="code" required /></Field>
        {msg && <p className="ok small">{msg}</p>}
        <ErrorText error={error} />
        <button className="btn primary" disabled={!acc || pin.length !== 4}>Подключить</button>
      </form>
      <button className="btn block section" onClick={async () => { await api('/api/logout', { body: { who: 'player' } }); onLogout(); }}>
        Выйти
      </button>
    </>
  );
}

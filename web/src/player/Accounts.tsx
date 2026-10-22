import { FormEvent, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ACCOUNT_KIND, api, useLoad } from '../api';
import { Confirm, ErrorText, Field, Money } from '../ui';
import { OperationRow } from './History';
import { TransferIcon } from './icons';
import { ScreenHeader } from './Screen';
import { Account, Me, Operation, Recipient, canSpend, memberName } from './types';

type RoleOption = { id: number; title: string; playerName: string | null };
const useRoles = () => useLoad(() => api<RoleOption[]>('/api/player/roles'), []);
const roleLabel = (r: RoleOption) => (r.playerName ? `${r.playerName} (${r.title})` : r.title);
const digits4 = (v: string) => v.replace(/\D/g, '').slice(0, 4);

export function AccountPage({ accounts, ops, me, reload }: { accounts: Account[]; ops: Operation[]; me: Me; reload: () => void }) {
  const id = Number(useParams().id);
  const acc = accounts.find((a) => a.id === id);
  if (!acc) return <><ScreenHeader title="Счёт" back="/play" /><p className="empty">Счёт не найден</p></>;
  const history = ops.filter((o) => o.from_account_id === id || o.to_account_id === id);

  return (
    <>
      <ScreenHeader title={acc.title} back={true} />
      <div className="account-hero">
        <span className="muted small">{ACCOUNT_KIND[acc.kind]}{acc.member === 'coowner' ? ' · вы совладелец' : ''}</span>
        <div className="home-total"><Money value={acc.balance} /></div>
        {canSpend(acc) && (
          <Link to="/play/transfer" className="quick inline"><span className="quick-icon"><TransferIcon /></span>Перевести</Link>
        )}
      </div>
      {!canSpend(acc) && <PinConfirm account={acc} onDone={reload} />}

      {acc.kind === 'legal' && (
        <section className="section">
          <h2 className="section-title">Участники</h2>
          <div className="settings-group">
            {acc.members.map((m) => (
              <div key={m.roleId} className="settings-row">
                <span className="grow settings-title">{memberName(m)}</span>
                <span className={m.member === 'owner' ? 'chip accent' : 'chip'}>{m.member === 'owner' ? 'владелец' : 'совладелец'}</span>
                {m.member === 'coowner' && !m.pinOk && <span className="chip warn">без PIN</span>}
              </div>
            ))}
          </div>
        </section>
      )}
      {acc.kind === 'legal' && acc.member === 'owner' && <OwnerTools account={acc} me={me} reload={reload} />}

      <section className="section">
        <h2 className="section-title">Операции по счёту</h2>
        <div className="op-list">
          {history.map((o) => <OperationRow key={o.id} op={o} mine={new Set([id])} accountId={id} />)}
          {history.length === 0 && <p className="empty">Операций пока нет</p>}
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
    <form className="sheet stack" onSubmit={submit}>
      <p className="small">Вы совладелец. Чтобы переводить с этого счёта, один раз введите его PIN.</p>
      <Field label="PIN счёта"><input value={pin} onChange={(e) => setPin(digits4(e.target.value))} inputMode="numeric" className="code" required /></Field>
      <ErrorText error={error} />
      <button className="btn primary" disabled={pin.length !== 4}>Подтвердить</button>
    </form>
  );
}

function RolePicker({ selected, onToggle, exclude }: { selected: number[]; onToggle: (id: number) => void; exclude: number }) {
  const roles = useRoles();
  return (
    <div className="chips">
      {roles.data?.filter((r) => r.id !== exclude).map((r) => (
        <button type="button" key={r.id} className="chip-toggle" aria-pressed={selected.includes(r.id)} onClick={() => onToggle(r.id)}>
          {roleLabel(r)}
        </button>
      ))}
    </div>
  );
}

const toggle = (id: number) => (s: number[]) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]);

function OwnerTools({ account, me, reload }: { account: Account; me: Me; reload: () => void }) {
  const nav = useNavigate();
  const roles = useRoles();
  const [co, setCo] = useState(account.members.filter((m) => m.member === 'coowner').map((m) => m.roleId));
  const [pin, setPin] = useState('');
  const [newOwner, setNewOwner] = useState<number>();
  const [confirmOwner, setConfirmOwner] = useState(false);
  const [msg, setMsg] = useState<string>();
  const [error, setError] = useState<string>();

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
      <h2 className="section-title">Управление юрлицом</h2>
      <div className="sheet stack">
        <Field label="Совладельцы"><RolePicker selected={co} exclude={me.roleId} onToggle={(id) => setCo(toggle(id))} /></Field>
        <button className="btn" onClick={() => run(() => api(`/api/player/accounts/${account.id}/coowners`, { body: { roleIds: co } }), 'Состав совладельцев сохранён')}>
          Сохранить совладельцев
        </button>
      </div>
      <div className="sheet stack">
        <Field label="Новый PIN"><input value={pin} onChange={(e) => setPin(digits4(e.target.value))} inputMode="numeric" className="code" /></Field>
        <button className="btn" disabled={pin.length !== 4}
          onClick={() => run(() => api(`/api/player/accounts/${account.id}/pin`, { body: { pin } }), 'PIN изменён')}>Сменить PIN</button>
      </div>
      <div className="sheet stack">
        <Field label="Передать юрлицо" hint="Новый владелец получает счёт сразу, вы теряете доступ">
          <select value={newOwner ?? ''} onChange={(e) => setNewOwner(Number(e.target.value) || undefined)}>
            <option value="">Кому…</option>
            {roles.data?.filter((r) => r.id !== me.roleId).map((r) => <option key={r.id} value={r.id}>{roleLabel(r)}</option>)}
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

export function NewLegal({ me }: { me: Me }) {
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
      <ScreenHeader title="Новое юрлицо" back={true} />
      <form className="stack" onSubmit={submit}>
        <Field label="Название"><input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} /></Field>
        <Field label="Владелец"><span>{me.firstName} {me.lastName} ({me.roleTitle})</span></Field>
        <Field label="Совладельцы" hint="Увидят счёт сразу; переводить смогут после ввода PIN">
          <RolePicker selected={co} exclude={me.roleId} onToggle={(id) => setCo(toggle(id))} />
        </Field>
        <Field label="Придумайте PIN" hint="4 цифры — сообщите их совладельцам">
          <input value={pin} onChange={(e) => setPin(digits4(e.target.value))} inputMode="numeric" className="code" required />
        </Field>
        <Field label="Повторите PIN">
          <input value={pin2} onChange={(e) => setPin2(digits4(e.target.value))} inputMode="numeric" className="code" required />
        </Field>
        <ErrorText error={mismatch ? 'PIN не совпадает' : error} />
        <button className="btn primary block" disabled={busy || !title || pin.length !== 4 || pin !== pin2}>Создать юрлицо</button>
      </form>
    </>
  );
}

export function ConnectByPin({ accounts, reload }: { accounts: Account[]; reload: () => void }) {
  const recipients = useLoad(() => api<Recipient[]>('/api/player/recipients'), []);
  const mine = useMemo(() => new Set(accounts.filter(canSpend).map((a) => a.id)), [accounts]);
  const [acc, setAcc] = useState<number>();
  const [pin, setPin] = useState('');
  const [msg, setMsg] = useState<string>();
  const [error, setError] = useState<string>();

  async function connect(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    try {
      await api(`/api/player/accounts/${acc}/pin-confirm`, { body: { pin } });
      setMsg('Юрлицо подключено');
      setPin('');
      reload();
    } catch (err: any) {
      setError(err.message);
    }
  }

  return (
    <>
      <ScreenHeader title="Подключить юрлицо" back="/play/more" />
      <form className="stack" onSubmit={connect}>
        <p className="small muted">Если владелец сообщил вам PIN, вы станете совладельцем и сможете переводить с этого счёта.</p>
        <Field label="Юрлицо">
          <select value={acc ?? ''} onChange={(e) => setAcc(Number(e.target.value))} required>
            <option value="">Выберите…</option>
            {recipients.data?.filter((r) => r.kind === 'legal' && !mine.has(r.id)).map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
          </select>
        </Field>
        <Field label="PIN"><input value={pin} onChange={(e) => setPin(digits4(e.target.value))} inputMode="numeric" className="code" required /></Field>
        {msg && <p className="ok small">{msg}</p>}
        <ErrorText error={error} />
        <button className="btn primary block" disabled={!acc || pin.length !== 4}>Подключить</button>
      </form>
    </>
  );
}

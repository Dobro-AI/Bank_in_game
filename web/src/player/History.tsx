import { useState } from 'react';
import { KIND_LABEL } from '../api';
import { Money } from '../ui';
import { ScreenHeader } from './Screen';
import { Account, Operation, initials } from './types';

const dayLabel = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Сегодня';
  if (d.toDateString() === yesterday.toDateString()) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
};
const time = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

/** One operation from the player's point of view: counterpart, sign, purpose. */
export function OperationRow({ op, mine, accountId }: { op: Operation; mine: Set<number>; accountId?: number }) {
  const fromMine = accountId ? op.from_account_id === accountId : mine.has(op.from_account_id);
  const toMine = accountId ? op.to_account_id === accountId : mine.has(op.to_account_id);
  const internal = fromMine && toMine;
  const incoming = toMine && !fromMine;
  // Income and expenses of a tact read as such, not as a transfer from the game master.
  const [head, ...details] = op.posting ? op.comment.split(': ') : [];
  const counterpart = op.posting ? head : internal ? `${op.from_title} → ${op.to_title}` : incoming ? op.from_title : op.to_title;
  const purpose = op.posting ? details.join(': ') || KIND_LABEL[op.kind] : op.comment || KIND_LABEL[op.kind];
  return (
    <div className="op-row">
      <span className="avatar small">{initials(incoming ? op.from_title : op.to_title)}</span>
      <span className="grow op-text">
        <span className="op-title">{counterpart}</span>
        <span className="op-sub">{purpose} · {time(op.created_at)} · такт {op.tact}</span>
      </span>
      <span className={incoming ? 'op-amount in' : 'op-amount'}>
        {internal ? <Money value={op.amount} /> : <Money value={incoming ? op.amount : -op.amount} signed />}
      </span>
    </div>
  );
}

type Dir = 'all' | 'in' | 'out';

export function History({ accounts, ops }: { accounts: Account[]; ops: Operation[] }) {
  const [account, setAccount] = useState<number>();
  const [dir, setDir] = useState<Dir>('all');
  const mine = new Set(accounts.map((a) => a.id));
  const scope = account ? new Set([account]) : mine;

  const filtered = ops.filter((o) => {
    const out = scope.has(o.from_account_id);
    const inc = scope.has(o.to_account_id);
    if (!out && !inc) return false;
    return dir === 'all' || (dir === 'in' ? inc && !out : out && !inc);
  });
  const groups = new Map<string, Operation[]>();
  for (const o of filtered) groups.set(dayLabel(o.created_at), [...(groups.get(dayLabel(o.created_at)) ?? []), o]);
  const sum = (pred: (o: Operation) => boolean) => filtered.filter(pred).reduce((s, o) => s + o.amount, 0);
  const received = sum((o) => scope.has(o.to_account_id) && !scope.has(o.from_account_id));
  const sent = sum((o) => scope.has(o.from_account_id) && !scope.has(o.to_account_id));

  return (
    <>
      <ScreenHeader title="История" />
      <div className="chip-scroll" role="group" aria-label="Счёт">
        <button className="chip-toggle" aria-pressed={!account} onClick={() => setAccount(undefined)}>Все счета</button>
        {accounts.map((a) => (
          <button key={a.id} className="chip-toggle" aria-pressed={account === a.id} onClick={() => setAccount(a.id)}>{a.title}</button>
        ))}
      </div>
      <div className="segmented" role="group" aria-label="Направление">
        {([['all', 'Все'], ['in', 'Пополнения'], ['out', 'Траты']] as [Dir, string][]).map(([k, l]) => (
          <button key={k} aria-pressed={dir === k} onClick={() => setDir(k)}>{l}</button>
        ))}
      </div>
      <div className="history-totals">
        <div><span className="muted tiny">Пополнения</span><Money value={received} /></div>
        <div><span className="muted tiny">Траты</span><Money value={sent} /></div>
      </div>
      {[...groups].map(([day, list]) => (
        <section key={day}>
          <h2 className="day-title">{day}</h2>
          <div className="op-list">
            {list.map((o) => <OperationRow key={o.id} op={o} mine={mine} accountId={account} />)}
          </div>
        </section>
      ))}
      {filtered.length === 0 && <p className="empty">Операций нет</p>}
    </>
  );
}

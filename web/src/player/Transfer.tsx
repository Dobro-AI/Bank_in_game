import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, money, newKey, useLoad } from '../api';
import { Confirm, Money } from '../ui';
import { Select } from '../Select';
import { BuildingIcon, CheckIcon, SearchIcon } from '../icons';
import { ScreenHeader } from './Screen';
import { Account, PriceItem, Recipient, canSpend, initials, recipientTitle } from './types';

const useRecipients = () => useLoad(() => api<Recipient[]>('/api/player/recipients'), []);

/** Step 1: who to send to. Game master first, then legal entities, then individuals. */
export function RecipientPicker({ accounts }: { accounts: Account[] }) {
  const list = useRecipients();
  const [q, setQ] = useState('');
  const mine = new Set(accounts.map((a) => a.id));
  const items = (list.data ?? []).filter((r) => recipientTitle(r).toLowerCase().includes(q.trim().toLowerCase()));
  const groups: [string, Recipient[]][] = [
    ['Ведущий', items.filter((r) => r.kind === 'host')],
    ['Юрлица', items.filter((r) => r.kind === 'legal')],
    ['Физлица', items.filter((r) => r.kind === 'individual')],
  ];

  return (
    <>
      <ScreenHeader title="Кому перевести" />
      <label className="search">
        <SearchIcon />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Название или имя" aria-label="Поиск получателя" />
      </label>
      {groups.filter(([, g]) => g.length).map(([title, g]) => (
        <section key={title}>
          <h2 className="day-title">{title}</h2>
          <div className="op-list">
            {g.map((r) => (
              <Link key={r.id} to={`/play/transfer/${r.id}`} className="op-row link-row">
                <span className={r.kind === 'host' ? 'avatar small accent' : 'avatar small'}>
                  {r.kind === 'legal' ? <BuildingIcon /> : initials(recipientTitle(r))}
                </span>
                <span className="grow op-text">
                  <span className="op-title">{recipientTitle(r)}</span>
                  {(r.kind === 'host' || mine.has(r.id)) && (
                    <span className="op-sub">{r.kind === 'host' ? 'Перевод ведущему игры' : 'Ваш счёт'}</span>
                  )}
                </span>
              </Link>
            ))}
          </div>
        </section>
      ))}
      {list.data && items.length === 0 && <p className="empty">Никого не нашли</p>}
    </>
  );
}

/** Horizontally scrollable account cards; the centred card is the source account. */
function AccountCarousel({ accounts, index, onChange }: { accounts: Account[]; index: number; onChange: (i: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const select = (i: number) => {
    const el = ref.current?.children[i] as HTMLElement | undefined;
    el?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    onChange(i);
  };
  const onScroll = () => {
    const el = ref.current;
    if (!el || !el.children.length) return;
    const card = (el.children[0] as HTMLElement).offsetWidth + 12;
    const i = Math.min(accounts.length - 1, Math.max(0, Math.round(el.scrollLeft / card)));
    if (i !== index) onChange(i);
  };
  return (
    <div className="carousel-wrap">
      <div className="carousel" ref={ref} onScroll={onScroll} role="listbox" aria-label="Счёт списания">
        {accounts.map((a, i) => (
          <button key={a.id} type="button" role="option" aria-selected={i === index}
            className={i === index ? 'source-card active' : 'source-card'} onClick={() => select(i)}>
            <span className="muted tiny">{a.kind === 'legal' ? 'Юрлицо' : 'Личный счёт'}</span>
            <span className="source-title">{a.title}</span>
            <span className="source-balance"><Money value={a.balance} /></span>
          </button>
        ))}
      </div>
      {accounts.length > 1 && (
        <div className="dots" aria-hidden="true">
          {accounts.map((a, i) => <span key={a.id} className={i === index ? 'dot active' : 'dot'} />)}
        </div>
      )}
    </div>
  );
}

/** Step 2: amount, comment, optional preset "what for / how many / at what price". */
export function AmountPage({ accounts }: { accounts: Account[] }) {
  const toId = Number(useParams().toId);
  const recipients = useRecipients();
  const prices = useLoad(() => api<PriceItem[]>('/api/player/price-items'), []);
  const recipient = recipients.data?.find((r) => r.id === toId);
  const sources = useMemo(() => accounts.filter((a) => canSpend(a) && a.id !== toId), [accounts, toId]);
  const [index, setIndex] = useState(0);
  const [amount, setAmount] = useState('');
  const [comment, setComment] = useState('');
  const [presetId, setPresetId] = useState<number>();
  const [qty, setQty] = useState(1);
  const [confirmKey, setConfirmKey] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<number>();

  useEffect(() => { if (index >= sources.length) setIndex(0); }, [sources.length, index]);
  const from = sources[index];
  const preset = prices.data?.find((p) => p.id === presetId);
  const total = preset ? preset.price * qty : Number(amount);
  const toHost = recipient?.kind === 'host';
  // Fixed-price payments to the game master may go below zero; regular transfers may not.
  const allowNegative = !!preset && toHost;
  const formError = !total ? '' : !Number.isInteger(total) || total <= 0 ? 'Сумма — целое число больше нуля'
    : from && total > from.balance && !allowNegative ? 'Недостаточно средств' : '';
  const purpose = preset ? `${preset.title}${qty > 1 ? ` × ${qty}` : ''}` : '';

  async function send() {
    setBusy(true);
    setError(undefined);
    try {
      if (allowNegative) {
        await api('/api/player/pay-fixed', { body: { fromAccountId: from.id, priceItemId: preset!.id, quantity: qty, comment, idempotencyKey: confirmKey } });
      } else {
        await api('/api/player/transfers', {
          body: { fromAccountId: from.id, toAccountId: toId, amount: total, idempotencyKey: confirmKey,
            comment: [purpose, comment.trim()].filter(Boolean).join(' — ') },
        });
      }
      setDone(total);
      setConfirmKey(undefined);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (done !== undefined) {
    return (
      <div className="success">
        <span className="success-icon"><CheckIcon /></span>
        <h1>Перевод выполнен</h1>
        <div className="home-total"><Money value={done} /></div>
        <p className="muted">{recipient && recipientTitle(recipient)}</p>
        <div className="stack" style={{ width: '100%' }}>
          <Link to="/play" className="btn primary block">Готово</Link>
          <Link to="/play/history" className="btn block">В историю</Link>
        </div>
      </div>
    );
  }

  if (recipients.data && !recipient) return <><ScreenHeader title="Перевод" back="/play/transfer" /><p className="empty">Получатель не найден</p></>;

  return (
    <>
      <ScreenHeader title={recipient ? recipientTitle(recipient) : 'Перевод'} back="/play/transfer" />
      {sources.length === 0 ? <p className="empty">Нет счетов, с которых можно переводить</p> : (
        <form className="amount-form" onSubmit={(e: FormEvent) => { e.preventDefault(); setError(undefined); setConfirmKey(newKey()); }}>
          <AccountCarousel accounts={sources} index={index} onChange={setIndex} />

          <label className="amount-field">
            <span className="muted small">Сумма</span>
            <input value={preset ? String(total) : amount} readOnly={!!preset} inputMode="numeric" placeholder="0" aria-label="Сумма перевода"
              onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} />
            <span className={formError ? 'error small' : 'muted small'}>
              {formError || (from ? `Доступно ${money(from.balance)}` : '')}
            </span>
          </label>

          <label className="field">
            <span className="field-label">Комментарий</span>
            <textarea value={comment} onChange={(e) => setComment(e.target.value)} maxLength={500} rows={2} placeholder="Сообщение получателю" />
          </label>

          {!!prices.data?.length && (
            <div className="field">
              <span className="field-label">За что</span>
              <Select value={presetId ? String(presetId) : ''} ariaLabel="За что" placeholder="Своя сумма"
                onChange={(v) => { setPresetId(Number(v) || undefined); setQty(1); }}
                options={[{ value: '', label: 'Своя сумма' }, ...prices.data.map((p) => ({ value: String(p.id), label: p.title, sub: `${money(p.price)} за шт.` }))]} />
              {preset && (
                <div className="preset-row">
                  <div className="stepper" role="group" aria-label="Количество">
                    <button type="button" aria-label="Меньше" disabled={qty <= 1} onClick={() => setQty((q) => q - 1)}>−</button>
                    <span aria-live="polite">{qty} шт.</span>
                    <button type="button" aria-label="Больше" disabled={qty >= 1000} onClick={() => setQty((q) => q + 1)}>+</button>
                  </div>
                  <span className="muted small">{money(preset.price)} × {qty} = <strong>{money(total)}</strong></span>
                </div>
              )}
              {allowNegative && from && total > from.balance && <span className="field-hint">Оплата по прайсу: баланс может уйти в минус</span>}
            </div>
          )}

          <div className="sticky-action">
            <button className="btn primary block" disabled={!from || !total || !!formError}>
              {total ? `Перевести ${money(total)}` : 'Перевести'}
            </button>
          </div>
        </form>
      )}
      {confirmKey && from && recipient && (
        <Confirm title="Подтвердите перевод" busy={busy} error={error} onCancel={() => setConfirmKey(undefined)} onConfirm={send} confirmText="Перевести">
          <div className="summary-line"><span className="muted">Откуда</span><span>{from.title}</span></div>
          <div className="summary-line"><span className="muted">Кому</span><span>{recipientTitle(recipient)}</span></div>
          {purpose && <div className="summary-line"><span className="muted">За что</span><span>{purpose}</span></div>}
          <div className="summary-line"><span className="muted">Сумма</span><Money value={total} /></div>
          {comment.trim() && <div className="summary-line"><span className="muted">Комментарий</span><span>{comment.trim()}</span></div>}
        </Confirm>
      )}
      {!confirmKey && error && <p className="error">{error}</p>}
    </>
  );
}

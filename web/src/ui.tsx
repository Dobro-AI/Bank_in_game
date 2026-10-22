import { ReactNode, useEffect, useRef } from 'react';

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function ErrorText({ error }: { error?: string }) {
  return error ? <p className="error" role="alert">{error}</p> : null;
}

export function Money({ value, signed }: { value: number; signed?: boolean }) {
  const text = new Intl.NumberFormat('ru-RU').format(Math.abs(value));
  const sign = value < 0 ? '−' : signed && value > 0 ? '+' : '';
  return <span className={`money${value < 0 ? ' negative' : ''}`}>{sign}{text}</span>;
}

/** Modal confirmation; the confirm button disables while busy so a double tap sends once. */
export function Confirm({ title, children, busy, error, onConfirm, onCancel, confirmText = 'Подтвердить' }: {
  title: string; children: ReactNode; busy?: boolean; error?: string;
  onConfirm: () => void; onCancel: () => void; confirmText?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return (
    <dialog ref={ref} className="modal" onCancel={(e) => { e.preventDefault(); if (!busy) onCancel(); }} aria-labelledby="confirm-title">
      <h2 id="confirm-title">{title}</h2>
      <div className="modal-body">{children}</div>
      <ErrorText error={error} />
      <div className="row end">
        <button className="btn" onClick={onCancel} disabled={busy}>Отмена</button>
        <button className="btn primary" onClick={onConfirm} disabled={busy} aria-busy={busy}>
          {busy ? 'Отправляем…' : confirmText}
        </button>
      </div>
    </dialog>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: [T, string][]; value: T; onChange: (v: T) => void }) {
  return (
    <nav className="tabs" role="tablist">
      {tabs.map(([k, label]) => (
        <button key={k} role="tab" aria-selected={value === k} className={value === k ? 'tab active' : 'tab'} onClick={() => onChange(k)}>
          {label}
        </button>
      ))}
    </nav>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

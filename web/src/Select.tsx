import { KeyboardEvent, useEffect, useId, useRef, useState } from 'react';

export interface Option { value: string; label: string; sub?: string; group?: string; disabled?: boolean }

/**
 * Drop-down that stays exactly as wide as its field: long names wrap, a second line holds the
 * description. Native <select> popups size to the longest option and spill out of the form.
 */
export function Select({ value, onChange, options, placeholder = 'Выберите…', ariaLabel, id }: {
  value: string; onChange: (v: string) => void; options: Option[]; placeholder?: string; ariaLabel?: string; id?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const root = useRef<HTMLDivElement>(null);
  const listId = useId();
  const selected = options.find((o) => o.value === value);
  const enabled = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | TouchEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('touchstart', close);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('touchstart', close); };
  }, [open]);

  useEffect(() => {
    if (open) root.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  function show() {
    setOpen(true);
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
  }
  function pick(i: number) {
    if (options[i]?.disabled) return;
    onChange(options[i].value);
    setOpen(false);
  }
  function onKey(e: KeyboardEvent) {
    if (!open && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); show(); return; }
    if (!open) return;
    const pos = enabled.indexOf(active);
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(enabled[Math.min(enabled.length - 1, pos + 1)] ?? active); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive(enabled[Math.max(0, pos - 1)] ?? active); }
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (active >= 0) pick(active); }
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
    if (e.key === 'Tab') setOpen(false);
  }

  return (
    <div className={`dd${open ? ' open' : ''}`} ref={root}>
      <button type="button" id={id} className="dd-button" aria-haspopup="listbox" aria-expanded={open} aria-controls={listId}
        aria-label={ariaLabel} onClick={() => (open ? setOpen(false) : show())} onKeyDown={onKey}>
        {selected ? (
          <span className="dd-value"><span className="dd-label">{selected.label}</span>{selected.sub && <span className="dd-sub">{selected.sub}</span>}</span>
        ) : <span className="dd-placeholder">{placeholder}</span>}
        <svg className="dd-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open && (
        <ul className="dd-list" role="listbox" id={listId}>
          {options.map((o, i) => (
            <li key={o.value} data-i={i}>
              {o.group && o.group !== options[i - 1]?.group && <div className="dd-group">{o.group}</div>}
              <div role="option" aria-selected={o.value === value} aria-disabled={o.disabled}
                className={`dd-option${i === active ? ' active' : ''}${o.disabled ? ' disabled' : ''}`}
                onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(i)}>
                <span className="dd-label">{o.label}</span>
                {o.sub && <span className="dd-sub">{o.sub}</span>}
              </div>
            </li>
          ))}
          {options.length === 0 && <li className="dd-empty">Пусто</li>}
        </ul>
      )}
    </div>
  );
}

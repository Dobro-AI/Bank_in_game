import { Fragment, ReactNode, useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { api } from '../api';
import { BackIcon, ChevronIcon, LogoutIcon } from '../icons';
import type { Staff } from './AdminApp';

/** `main` — everyday work, `assistant` — set apart, `minor` — settings-like, quieter. */
export interface NavItem { to: string; label: string; icon: ReactNode; end?: boolean; group?: 'main' | 'assistant' | 'minor' }

const COLLAPSED = 'adminNavCollapsed';

/** Host cabinet layout: left menu on desktop, a scrollable menu strip on top on phones. */
export function AdminShell({ staff, title, subtitle, back, items, onLogout, children }: {
  staff: Staff; title: string; subtitle?: string; back?: { to: string; label: string };
  items: NavItem[]; onLogout: () => void; children: ReactNode;
}) {
  const navRef = useRef<HTMLElement>(null);
  const { pathname } = useLocation();
  // On desktop the menu folds to icons; the choice is remembered on this device.
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem(COLLAPSED) === '1'; } catch { return false; } });
  const toggle = () => {
    setCollapsed((c) => {
      try { localStorage.setItem(COLLAPSED, c ? '0' : '1'); } catch { /* per-device convenience only */ }
      return !c;
    });
  };
  // On phones the menu is a horizontal strip: keep the current section visible.
  useEffect(() => {
    navRef.current?.querySelector('.active')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [pathname]);

  async function logout() {
    await api('/api/logout', { body: { who: 'staff' } });
    onLogout();
  }
  return (
    <div className={`bank bank-shell admin${collapsed ? ' nav-collapsed' : ''}`}>
      <nav ref={navRef} className="bank-nav" aria-label="Разделы кабинета">
        <button type="button" className="nav-collapse" onClick={toggle} aria-expanded={!collapsed}
          aria-label={collapsed ? 'Развернуть меню' : 'Свернуть меню'} title={collapsed ? 'Развернуть меню' : 'Свернуть меню'}>
          <ChevronIcon />
        </button>
        {back && <Link to={back.to} className="bank-nav-item back-link" title={back.label}><BackIcon /><span>{back.label}</span></Link>}
        <div className="bank-brand">
          <div className="bank-brand-title">{title}</div>
          {subtitle && <div className="bank-brand-sub">{subtitle}</div>}
        </div>
        {items.map((n, i) => (
          <Fragment key={n.to}>
            {i > 0 && (n.group ?? 'main') !== (items[i - 1].group ?? 'main') && <div className="nav-sep" role="separator" />}
            <NavLink to={n.to} end={n.end} title={n.label}
              className={({ isActive }) => `bank-nav-item${n.group && n.group !== 'main' ? ` nav-${n.group}` : ''}${isActive ? ' active' : ''}`}>
              {n.icon}<span>{n.label}</span>
            </NavLink>
          </Fragment>
        ))}
        <div className="nav-footer">
          <div className="bank-brand-sub">{staff.name} · {staff.kind === 'super' ? 'игротехник, админ' : 'игротехник'}</div>
          <button className="bank-nav-item" onClick={logout} title="Выйти"><LogoutIcon /><span>Выйти</span></button>
        </div>
      </nav>
      <main className="bank-main wide">{children}</main>
    </div>
  );
}

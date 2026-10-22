import { ReactNode, useEffect, useRef } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { api } from '../api';
import { BackIcon, LogoutIcon } from '../icons';
import type { Staff } from './AdminApp';

export interface NavItem { to: string; label: string; icon: ReactNode; end?: boolean }

/** Host cabinet layout: left menu on desktop, a scrollable menu strip on top on phones. */
export function AdminShell({ staff, title, subtitle, back, items, onLogout, children }: {
  staff: Staff; title: string; subtitle?: string; back?: { to: string; label: string };
  items: NavItem[]; onLogout: () => void; children: ReactNode;
}) {
  const navRef = useRef<HTMLElement>(null);
  const { pathname } = useLocation();
  // On phones the menu is a horizontal strip: keep the current section visible.
  useEffect(() => {
    navRef.current?.querySelector('.active')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [pathname]);

  async function logout() {
    await api('/api/logout', { body: { who: 'staff' } });
    onLogout();
  }
  return (
    <div className="bank bank-shell admin">
      <nav ref={navRef} className="bank-nav" aria-label="Разделы кабинета">
        {back && <Link to={back.to} className="bank-nav-item back-link"><BackIcon /><span>{back.label}</span></Link>}
        <div className="bank-brand">
          <div className="bank-brand-title">{title}</div>
          {subtitle && <div className="bank-brand-sub">{subtitle}</div>}
        </div>
        {items.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `bank-nav-item${isActive ? ' active' : ''}`}>
            {n.icon}<span>{n.label}</span>
          </NavLink>
        ))}
        <div className="nav-footer">
          <div className="bank-brand-sub">{staff.name}{staff.kind === 'super' ? ' · Супер-ведущий' : ''}</div>
          <button className="bank-nav-item" onClick={logout}><LogoutIcon /><span>Выйти</span></button>
        </div>
      </nav>
      <main className="bank-main wide">{children}</main>
    </div>
  );
}

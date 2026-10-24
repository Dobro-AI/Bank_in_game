import { ReactNode, useState } from 'react';
import { api, useLoad } from '../api';
import type { Ctx } from './GamePage';

interface Status { view: { sheetId: string; gids: Record<string, number> } }

// v2: the Google sheet became the default; earlier saved choices are ignored once.
const KEY = 'sheetView2:';
const load = (section: string, fallback: 'google' | 'bank') => {
  try { return (localStorage.getItem(KEY + section) as 'google' | 'bank' | null) ?? fallback; } catch { return fallback; }
};

/**
 * A section shows the matching tab of the game's Google sheet (filled by the bank about a second
 * after every operation; Google refreshes the open tab by itself), or the bank's own table.
 */
export function SheetView({ ctx, section, tabs, initial = 'google', children }: {
  ctx: Ctx; section: string; tabs: string[]; initial?: 'google' | 'bank'; children: ReactNode;
}) {
  const status = useLoad(() => api<Status>(`/api/admin/games/${ctx.id}/sheet`), [ctx.id]);
  const [mode, setMode] = useState<'google' | 'bank'>(() => load(section, initial));
  const [tab, setTab] = useState(tabs[0]);
  // Each game master sees their own copy of the sheet; without one the bank's table is shown.
  const s = status.data?.view;
  if (!s?.sheetId) return <>{children}</>;

  const choose = (m: 'google' | 'bank') => {
    setMode(m);
    try { localStorage.setItem(KEY + section, m); } catch { /* per-viewer convenience only */ }
  };
  const gid = s.gids?.[tab];
  const url = `https://docs.google.com/spreadsheets/d/${s.sheetId}/edit${gid !== undefined ? `?gid=${gid}#gid=${gid}` : ''}`;

  return (
    <>
      <div className="row between" style={{ marginBottom: 12 }}>
        <div className="segmented two" role="group" aria-label="Вид" style={{ maxWidth: 360 }}>
          <button type="button" aria-pressed={mode === 'google'} onClick={() => choose('google')}>Google-таблица</button>
          <button type="button" aria-pressed={mode === 'bank'} onClick={() => choose('bank')}>Таблица банка</button>
        </div>
        {mode === 'google' && <a className="btn small" href={url} target="_blank" rel="noreferrer">Открыть в Google</a>}
      </div>
      {mode === 'bank' ? children : (
        <>
          {tabs.length > 1 && (
            <div className="chip-scroll" role="group" aria-label="Лист">
              {tabs.map((t) => <button key={t} className="chip-toggle" aria-pressed={tab === t} onClick={() => setTab(t)}>{t}</button>)}
            </div>
          )}
          <iframe key={url} className="sheet-frame" src={url} title={`Google-таблица: ${tab}`} />
          <p className="small muted">
            Лист обновляется сам через пару секунд после каждой операции. Если таблица не открылась — войдите в Google
            под аккаунтом, которому открыта папка с таблицами.
          </p>
        </>
      )}
    </>
  );
}

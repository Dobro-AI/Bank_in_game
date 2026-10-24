import { useEffect, useState } from 'react';
import { api } from '../api';
import { Confirm, Empty, ErrorText } from '../ui';
import type { Ctx } from './GamePage';

/** Role codes of the game: set a code by hand, draw a new one, copy them all to hand out. */
export function Codes({ ctx }: { ctx: Ctx }) {
  const roles = ctx.d.roles;
  const [copied, setCopied] = useState(false);
  const [renewAll, setRenewAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const editable = ctx.d.can.config;
  const text = `${ctx.d.game.title}\n${roles.map((r) => `${r.title} — ${r.code}`).join('\n')}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Не удалось скопировать — выделите коды в поле ниже');
    }
  }

  async function renew() {
    setBusy(true);
    setError(undefined);
    try {
      for (const r of roles) await api(`/api/admin/roles/${r.id}/code`, { body: {} });
      setRenewAll(false);
      ctx.reload();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }

  if (!roles.length) return <Empty>Ролей нет — добавьте их в настройках</Empty>;

  return (
    <div className="stack">
      <div className="row">
        <button className="btn primary" onClick={copy}>{copied ? 'Скопировано' : 'Скопировать все коды'}</button>
        {editable && <button className="btn" onClick={() => setRenewAll(true)}>Новые коды всем ролям</button>}
        <span className="small muted">Код вводит каждый игрок роли. В одну роль может войти сколько угодно человек.</span>
      </div>
      <ErrorText error={error} />
      <div className="table-wrap">
        <table>
          <thead><tr><th>Роль</th><th>Код</th><th>Кто вошёл</th><th></th></tr></thead>
          <tbody>
            {roles.map((r) => <CodeRow key={`${r.id}:${r.code}`} ctx={ctx} role={r} editable={editable} />)}
          </tbody>
        </table>
      </div>
      <textarea className="codes-text" readOnly value={text} rows={Math.min(roles.length + 2, 16)} aria-label="Все коды текстом"
        onFocus={(e) => e.currentTarget.select()} />
      {renewAll && (
        <Confirm title="Новые коды всем ролям?" busy={busy} error={error} confirmText="Сменить" onCancel={() => setRenewAll(false)} onConfirm={renew}>
          Старые коды перестанут работать. Уже вошедшие игроки останутся в игре.
        </Confirm>
      )}
    </div>
  );
}

function CodeRow({ ctx, role, editable }: { ctx: Ctx; role: any; editable: boolean }) {
  const [code, setCode] = useState(role.code ?? '');
  const [error, setError] = useState<string>();
  const [release, setRelease] = useState(false);
  useEffect(() => setCode(role.code ?? ''), [role.code]);

  const save = async (value?: string) => {
    setError(undefined);
    try {
      await api(`/api/admin/roles/${role.id}/code`, { body: value === undefined ? {} : { code: value } });
      ctx.reload();
    } catch (e: any) { setError(e.message); }
  };

  return (
    <tr>
      <td><strong>{role.title}</strong>{role.description && <div className="tiny muted">{role.description}</div>}</td>
      <td>
        {editable ? (
          <input className="cell-input code" style={{ width: 88 }} inputMode="numeric" value={code} aria-label={`Код роли ${role.title}`}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 4))}
            onKeyDown={(e) => { if (e.key === 'Enter' && code.length === 4 && code !== role.code) save(code); }} />
        ) : <span className="code">{role.code}</span>}
        <ErrorText error={error} />
      </td>
      <td className="small">{role.players || <span className="muted">пока никто</span>}</td>
      <td>
        {editable && (
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <button className="btn small primary" disabled={code.length !== 4 || code === role.code} onClick={() => save(code)}>Сохранить</button>
            <button className="btn small" onClick={() => save()}>Случайный</button>
            {role.player_count > 0 && <button className="btn small danger" onClick={() => setRelease(true)}>Отключить игроков</button>}
          </div>
        )}
        {release && (
          <Confirm title="Отключить всех игроков роли?" confirmText="Отключить" error={error} onCancel={() => setRelease(false)}
            onConfirm={async () => {
              try { await api(`/api/admin/roles/${role.id}/release`, { body: {} }); setRelease(false); ctx.reload(); } catch (e: any) { setError(e.message); }
            }}>
            {role.players} — потеряют доступ к роли «{role.title}». Счета роли сохранятся: войти снова можно по коду.
          </Confirm>
        )}
      </td>
    </tr>
  );
}

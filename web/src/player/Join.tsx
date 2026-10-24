import { FormEvent, useMemo, useState } from 'react';
import { api, useLoad } from '../api';
import { ErrorText, Field } from '../ui';
import { Select } from '../Select';
import { telegramInitData } from '../telegram';

interface Game { id: number; title: string; hosts: string; team: string }
interface Role { id: number; title: string; description: string; presetFirstName: string; presetLastName: string; taken: boolean }
interface GameRoles { game: Game; roles: Role[] }

/** Roles of every game open to players right now (usually one game at a time). */
async function openRoles(): Promise<GameRoles[]> {
  const games = await api<Game[]>('/api/public/games');
  return Promise.all(games.map(async (game) => ({ game, roles: await api<Role[]>(`/api/public/games/${game.id}/roles`) })));
}

/**
 * One screen: name, role, 4-digit role code and, last, whose group the player is in. Every team of
 * game masters runs its own copy of the game with its own codes; the first team is the default.
 */
export function Join({ onJoined }: { onJoined: () => void }) {
  const data = useLoad(openRoles, []);
  const [name, setName] = useState('');
  const [pick, setPick] = useState('');
  const [team, setTeam] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const groups = data.data ?? [];
  const games = new Set(groups.map((g) => g.game.title));
  const teamOf = (g: Game) => (games.size > 1 ? `${g.team} · ${g.title}` : g.team || g.title);
  const current = groups.find((g) => String(g.game.id) === team) ?? groups[0];
  // Roles are the same in every team's copy of a game: the role is picked by title.
  const chosen = useMemo(() => {
    const role = current?.roles.find((r) => r.title === pick);
    return current && role ? { game: current.game, role } : null;
  }, [pick, current]);

  const words = name.trim().split(/\s+/).filter(Boolean);

  function choose(value: string) {
    setPick(value);
    setError(undefined);
    // A role prepared by the host may already carry the player's name.
    const role = current?.roles.find((r) => r.title === value);
    if (role && !name.trim() && role.presetFirstName) setName(`${role.presetFirstName} ${role.presetLastName}`.trim());
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!chosen) return;
    setBusy(true);
    setError(undefined);
    try {
      await api('/api/player/join', {
        body: {
          gameId: chosen.game.id, roleId: chosen.role.id, code, initData: telegramInitData(),
          firstName: words[0] ?? '', lastName: words.slice(1).join(' '),
        },
      });
      onJoined();
    } catch (err: any) {
      setError(err.message);
      setBusy(false);
    }
  }

  if (data.data && !groups.length) {
    return (
      <main className="page narrow center-page">
        <h1>Игровой банк</h1>
        <p className="muted">Сейчас нет открытых игр. Дождитесь, пока игротехник откроет игру.</p>
      </main>
    );
  }

  // Roles are never blocked: a whole team may sign in to one role with the same code.
  const options = (current?.roles ?? []).map((r) => ({ value: r.title, label: r.title, sub: r.description || undefined }));
  const teams = groups.map((g) => ({ value: String(g.game.id), label: teamOf(g.game) }));

  return (
    <main className="page narrow center-page">
      <h1>Игровой банк</h1>
      <p className="muted">{games.size === 1 ? [...games][0] : 'Войдите в игру'}</p>
      <ErrorText error={data.error} />
      <form className="stack" onSubmit={submit}>
        <Field label="Как вас зовут">
          <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" placeholder="Имя" required />
        </Field>
        <div className="field">
          <span className="field-label" id="role-label">Роль</span>
          <Select value={pick} onChange={choose} options={options} placeholder="Выберите роль" ariaLabel="Роль" />
        </div>
        <Field label="Код роли" hint="4 цифры, их выдаёт игротехник">
          <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 4))}
            inputMode="numeric" pattern="\d{4}" required autoComplete="one-time-code" className="code" />
        </Field>
        {teams.length > 1 && (
          <div className="field">
            <span className="field-label">У какого игротехника вы играете</span>
            <Select value={String(current?.game.id ?? '')} onChange={(v) => { setTeam(v); setError(undefined); }} options={teams} ariaLabel="Игротехник" />
          </div>
        )}
        <ErrorText error={error} />
        <button className="btn primary block" disabled={busy || !chosen || code.length !== 4 || !words.length}>
          {busy ? 'Проверяем…' : 'Войти'}
        </button>
      </form>
    </main>
  );
}

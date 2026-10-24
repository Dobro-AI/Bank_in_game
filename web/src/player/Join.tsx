import { FormEvent, useMemo, useState } from 'react';
import { api, useLoad } from '../api';
import { ErrorText, Field } from '../ui';
import { Select } from '../Select';
import { telegramInitData } from '../telegram';

interface Game { id: number; title: string; hosts: string }
interface Role { id: number; title: string; description: string; presetFirstName: string; presetLastName: string; taken: boolean }
interface GameRoles { game: Game; roles: Role[] }

/** Roles of every game open to players right now (usually one game at a time). */
async function openRoles(): Promise<GameRoles[]> {
  const games = await api<Game[]>('/api/public/games');
  return Promise.all(games.map(async (game) => ({ game, roles: await api<Role[]>(`/api/public/games/${game.id}/roles`) })));
}

/** One screen: name and surname, role, 4-digit role code. Any number of people may join one role. */
export function Join({ onJoined }: { onJoined: () => void }) {
  const data = useLoad(openRoles, []);
  const [name, setName] = useState('');
  const [pick, setPick] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const groups = data.data ?? [];
  const single = groups.length === 1 ? groups[0].game : null;
  const chosen = useMemo(() => {
    const [gameId, roleId] = pick.split(':').map(Number);
    const g = groups.find((x) => x.game.id === gameId);
    const role = g?.roles.find((r) => r.id === roleId);
    return g && role ? { game: g.game, role } : null;
  }, [pick, groups]);

  const words = name.trim().split(/\s+/).filter(Boolean);

  function choose(value: string) {
    setPick(value);
    setError(undefined);
    // A role prepared by the host may already carry the player's name.
    const [gameId, roleId] = value.split(':').map(Number);
    const role = groups.find((x) => x.game.id === gameId)?.roles.find((r) => r.id === roleId);
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
  const options = groups.flatMap((g) => g.roles.map((r) => ({
    value: `${g.game.id}:${r.id}`, label: r.title, sub: r.description || undefined, group: single ? undefined : g.game.title,
  })));

  return (
    <main className="page narrow center-page">
      <h1>Игровой банк</h1>
      <p className="muted">{single ? single.title : 'Войдите в игру'}</p>
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
        <ErrorText error={error} />
        <button className="btn primary block" disabled={busy || !chosen || code.length !== 4 || !words.length}>
          {busy ? 'Проверяем…' : 'Войти'}
        </button>
      </form>
    </main>
  );
}

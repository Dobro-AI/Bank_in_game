import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useLoad } from '../api';
import { Empty, ErrorText, Field } from '../ui';

interface Game { id: number; title: string; hosts: string }
interface Role { id: number; title: string; description: string; presetFirstName: string; presetLastName: string; taken: boolean }

/** First entry: game and host → role → name → 4-digit role code. A taken role re-enters by code only. */
export function Join({ onJoined }: { onJoined: () => void }) {
  const [game, setGame] = useState<Game>();
  const [role, setRole] = useState<Role>();
  const games = useLoad(() => api<Game[]>('/api/public/games'), []);
  const roles = useLoad(() => (game ? api<Role[]>(`/api/public/games/${game.id}/roles`) : Promise.resolve([])), [game?.id]);

  if (!game) {
    return (
      <main className="page narrow">
        <Link to="/" className="btn link">← Назад</Link>
        <h1>Выберите игру</h1>
        <p className="muted">Игра и её ведущий</p>
        <ErrorText error={games.error} />
        <div className="list">
          {games.data?.map((g) => (
            <button key={g.id} className="list-item" onClick={() => setGame(g)}>
              <div className="grow">
                <div className="list-title">{g.title}</div>
                <div className="list-sub">Ведущий: {g.hosts || '—'}</div>
              </div>
              <span aria-hidden>›</span>
            </button>
          ))}
          {games.data?.length === 0 && <Empty>Сейчас нет запущенных игр</Empty>}
        </div>
      </main>
    );
  }

  if (!role) {
    return (
      <main className="page narrow">
        <button className="btn link" onClick={() => setGame(undefined)}>← Другая игра</button>
        <h1>{game.title}</h1>
        <p className="muted">Выберите свою роль. Если роль уже ваша — войдите по коду.</p>
        <ErrorText error={roles.error} />
        <div className="list">
          {roles.data?.map((r) => (
            <button key={r.id} className="list-item" onClick={() => setRole(r)}>
              <div className="grow">
                <div className="list-title">{r.title}</div>
                {r.description && <div className="list-sub">{r.description}</div>}
              </div>
              {r.taken && <span className="chip">занята</span>}
              <span aria-hidden>›</span>
            </button>
          ))}
          {roles.data?.length === 0 && <Empty>Ведущий ещё не добавил роли</Empty>}
        </div>
      </main>
    );
  }

  return <RoleForm game={game} role={role} onBack={() => setRole(undefined)} onJoined={onJoined} />;
}

function RoleForm({ game, role, onBack, onJoined }: { game: Game; role: Role; onBack: () => void; onJoined: () => void }) {
  const [firstName, setFirst] = useState(role.presetFirstName);
  const [lastName, setLast] = useState(role.presetLastName);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api('/api/player/join', { body: { gameId: game.id, roleId: role.id, firstName, lastName, code } });
      onJoined();
    } catch (err: any) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <main className="page narrow">
      <button className="btn link" onClick={onBack}>← Другая роль</button>
      <h1>{role.title}</h1>
      <p className="muted">{game.title}</p>
      <form className="stack" onSubmit={submit}>
        {!role.taken && (
          <>
            <Field label="Имя"><input value={firstName} onChange={(e) => setFirst(e.target.value)} required autoComplete="given-name" /></Field>
            <Field label="Фамилия"><input value={lastName} onChange={(e) => setLast(e.target.value)} required autoComplete="family-name" /></Field>
          </>
        )}
        <Field label="Код роли" hint="4 цифры, их выдаёт ведущий">
          <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 4))}
            inputMode="numeric" pattern="\d{4}" required autoComplete="one-time-code" className="code" />
        </Field>
        <ErrorText error={error} />
        <button className="btn primary block" disabled={busy || code.length !== 4}>{busy ? 'Проверяем…' : 'Войти'}</button>
      </form>
    </main>
  );
}

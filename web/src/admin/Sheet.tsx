import { FormEvent, useEffect, useState } from 'react';
import { api, dateTime, useLoad } from '../api';
import { ErrorText, Field } from '../ui';
import type { Ctx } from './GamePage';

interface Status { sheetId: string; syncedAt: string | null; error: string; serviceEmail: string | null; baseFolderId: string; gameFolderId: string; oauthConfigured: boolean; googleUser: string | null }

/** Live mirror of the game in Google Sheets, embedded in the cabinet. */
export function Sheet({ ctx }: { ctx: Ctx }) {
  const status = useLoad(() => api<Status>(`/api/admin/games/${ctx.id}/sheet`), [ctx.id, ctx.tick]);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const s = status.data;
  useEffect(() => { if (s && !link) setLink(s.sheetId ? `https://docs.google.com/spreadsheets/d/${s.sheetId}/edit` : ''); }, [s?.sheetId]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api(`/api/admin/games/${ctx.id}/sheet`, { method: 'PUT', body: { sheet: link } });
      status.reload();
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  }
  async function create() {
    setBusy(true);
    setError(undefined);
    try {
      await api(`/api/admin/games/${ctx.id}/sheet/create`, { body: {} });
      status.reload();
    } catch (err: any) { setError(err.message); status.reload(); } finally { setBusy(false); }
  }
  async function sync() {
    setBusy(true);
    await api(`/api/admin/games/${ctx.id}/sheet/sync`, { body: {} }).catch((e) => setError(e.message));
    status.reload();
    setBusy(false);
  }

  if (!s) return <ErrorText error={status.error} />;
  const url = s.sheetId ? `https://docs.google.com/spreadsheets/d/${s.sheetId}/edit` : '';

  return (
    <div className="stack">
      {!s.serviceEmail && (
        <div className="banner">
          Google не подключён на сервере. Нужен технический аккаунт Google: администратор сервера задаёт его ключ
          в переменной <code>GOOGLE_SERVICE_ACCOUNT_JSON</code> (инструкция в README).
        </div>
      )}
      {ctx.d.can.super && <GoogleAccount s={s} gameId={ctx.id} onChanged={status.reload} />}
      {ctx.d.can.super && <BaseFolder current={s.baseFolderId} onSaved={status.reload} />}
      {!s.sheetId && s.baseFolderId && ctx.d.can.config && ctx.d.game.kind === 'branch' && (
        <div className="panel row between">
          <span className="small">
            {s.googleUser
              ? 'Банк создаст таблицу в подпапке этой игры от имени подключённого Google-аккаунта и сразу её заполнит.'
              : 'Банк создаст подпапку этой игры. Без входа через Google таблицу в ней создаёте вы — доступ для банка откроется сам, останется вставить ссылку.'}
          </span>
          <button className="btn primary" disabled={busy} onClick={create}>
            {busy ? 'Создаём…' : s.googleUser ? 'Создать таблицу в папке' : 'Создать подпапку игры'}
          </button>
        </div>
      )}
      {s.gameFolderId && (
        <a className="small" href={`https://drive.google.com/drive/folders/${s.gameFolderId}`} target="_blank" rel="noreferrer">Подпапка игры на Google Диске</a>
      )}
      <form className="panel stack" onSubmit={save}>
        <p className="small" style={{ margin: 0 }}>
          1. Создайте пустую Google-таблицу (в подпапке игры доступ откроется сам). 2. Если таблица в другом месте — «Настройки доступа» → добавьте
          {' '}<strong>{s.serviceEmail ?? 'технического аккаунта'}</strong> с правом «Редактор». 3. Вставьте ссылку сюда — банк переложит таблицу в подпапку игры.
          Банк сам заполнит листы «Переводы», «Сводка», «Мощности», «Выручка и OPEX», «Журнал активов» и будет обновлять их через несколько секунд после каждой операции.
        </p>
        <Field label="Ссылка на Google-таблицу">
          <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" readOnly={!ctx.d.can.config} />
        </Field>
        <div className="row">
          {ctx.d.can.config && <button className="btn primary" disabled={busy}>Подключить</button>}
          {s.sheetId && <button type="button" className="btn" disabled={busy} onClick={sync}>Обновить сейчас</button>}
          {url && <a className="btn" href={url} target="_blank" rel="noreferrer">Открыть в Google</a>}
          <span className="small muted">
            {s.syncedAt ? `Обновлено ${dateTime(s.syncedAt)}` : s.sheetId ? 'Ещё не обновлялась' : ''}
          </span>
        </div>
        <ErrorText error={error || s.error} />
      </form>
      {url && (
        <iframe className="sheet-frame" src={`${url}?rm=minimal`} title="Google-таблица игры" />
      )}
      <p className="small muted">
        Таблица — зеркало банка: правки, внесённые прямо в Google, при следующем обновлении перезапишутся.
        Исправлять приход и расход активов нужно в разделе «Мощности».
      </p>
    </div>
  );
}

/** Super host: the shared Drive folder; spreadsheets go to subfolders named after root games. */
function BaseFolder({ current, onSaved }: { current: string; onSaved: () => void }) {
  const [link, setLink] = useState(current ? `https://drive.google.com/drive/folders/${current}` : '');
  const [error, setError] = useState<string>();
  const [ok, setOk] = useState(false);
  async function save(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    try {
      await api('/api/admin/drive-folder', { method: 'PUT', body: { folder: link } });
      setOk(true);
      onSaved();
    } catch (err: any) { setError(err.message); }
  }
  return (
    <form className="panel stack" onSubmit={save}>
      <Field label="Общая папка для таблиц всех игр" hint="Внутри появятся подпапки по играм. Папку нужно открыть техническому аккаунту как редактору.">
        <input value={link} onChange={(e) => { setLink(e.target.value); setOk(false); }} placeholder="https://drive.google.com/drive/folders/…" />
      </Field>
      <div className="row">
        <button className="btn">Сохранить папку</button>
        {ok && <span className="ok small">Сохранено</span>}
      </div>
      <ErrorText error={error} />
    </form>
  );
}

/** Super host: connect their Google account so the bank can create spreadsheets in their Drive. */
function GoogleAccount({ s, gameId, onChanged }: { s: Status; gameId: number; onChanged: () => void }) {
  const [error, setError] = useState<string>();
  if (!s.oauthConfigured) {
    return (
      <div className="panel small">
        Вход через Google не настроен на сервере: нужен OAuth-клиент в <code>secrets/google-oauth-client.json</code> (инструкция в README).
      </div>
    );
  }
  return (
    <div className="panel row between">
      <span className="small">
        {s.googleUser ? <>Таблицы создаются от имени <strong>{s.googleUser}</strong>.</> : 'Войдите через Google, чтобы банк сам создавал таблицы в вашем Диске.'}
      </span>
      {s.googleUser ? (
        <button className="btn" onClick={async () => {
          try { await api('/api/admin/google/disconnect', { body: {} }); onChanged(); } catch (e: any) { setError(e.message); }
        }}>Отключить</button>
      ) : (
        <a className="btn primary" href={`/api/admin/google/connect?back=${encodeURIComponent(`/admin/g/${gameId}/sheet`)}`}>Войти через Google</a>
      )}
      <ErrorText error={error} />
    </div>
  );
}

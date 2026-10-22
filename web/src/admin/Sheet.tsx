import { FormEvent, useEffect, useState } from 'react';
import { api, dateTime, useLoad } from '../api';
import { ErrorText, Field } from '../ui';
import type { Ctx } from './GamePage';

interface Status { sheetId: string; syncedAt: string | null; error: string; serviceEmail: string | null }

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
      <form className="panel stack" onSubmit={save}>
        <p className="small" style={{ margin: 0 }}>
          1. Создайте пустую Google-таблицу. 2. Нажмите «Настройки доступа» и откройте её для
          {' '}<strong>{s.serviceEmail ?? 'технического аккаунта'}</strong> с правом «Редактор». 3. Вставьте ссылку сюда.
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

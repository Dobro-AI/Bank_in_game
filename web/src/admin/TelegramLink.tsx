import { useState } from 'react';
import { api, useLoad } from '../api';
import { ErrorText } from '../ui';

/** Connect the host's Telegram to the host bot with a one-time link (no password in the chat). */
export function TelegramLink() {
  const status = useLoad(() => api<{ botUsername: string | null; linked: boolean }>('/api/admin/telegram'), []);
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState<string>();
  const s = status.data;
  if (!s?.botUsername) return null;

  async function link() {
    setError(undefined);
    try {
      const r = await api<{ url: string }>('/api/admin/telegram/link', { body: {} });
      setUrl(r.url);
      window.open(r.url, '_blank', 'noopener');
    } catch (e: any) { setError(e.message); }
  }

  return (
    <div className="panel row between" style={{ marginBottom: 16 }}>
      <span className="small">
        {s.linked ? <>Telegram подключён: бот <strong>@{s.botUsername}</strong>.</>
          : <>Бот ведущего в Telegram <strong>@{s.botUsername}</strong>: сводка, начисления, такты и помощник по фото платёжек.</>}
        {url && <> Если Telegram не открылся: <a href={url} target="_blank" rel="noreferrer">{url}</a> (ссылка действует 15 минут).</>}
      </span>
      <button className={s.linked ? 'btn' : 'btn primary'} onClick={link}>{s.linked ? 'Подключить другой Telegram' : 'Подключить Telegram'}</button>
      <ErrorText error={error} />
    </div>
  );
}

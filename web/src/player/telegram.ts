// Telegram Mini App: Telegram opens the page with #tgWebAppData=<initData>. The server verifies
// it with the bot token and logs the linked player in; Join links a new player to the Telegram user.
const KEY = 'tgInitData';

export function telegramInitData(): string | null {
  try {
    const fromHash = new URLSearchParams(location.hash.slice(1)).get('tgWebAppData');
    if (fromHash) sessionStorage.setItem(KEY, fromHash);
    return fromHash ?? sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export async function telegramLogin() {
  const initData = telegramInitData();
  if (!initData) return;
  await fetch('/api/telegram/webapp-login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ initData }),
  }).catch(() => {});
}

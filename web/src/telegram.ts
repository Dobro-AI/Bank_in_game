// Telegram Mini App. Telegram opens the page with #tgWebAppData=<initData>; the server verifies it
// with the bot token and logs the linked player (or host) in. The page itself is the same web
// cabinet — here we only make Telegram show it full height in the same colours.
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

let uiReady = false;

/** Loads Telegram's script only inside Telegram, then expands the app and matches its colours. */
function setUpTelegramUi() {
  if (uiReady || !telegramInitData()) return;
  uiReady = true;
  const script = document.createElement('script');
  script.src = 'https://telegram.org/js/telegram-web-app.js';
  script.onload = () => {
    const app = (window as any).Telegram?.WebApp;
    if (!app) return;
    app.ready();
    app.expand();
    // Same look as the web version, whatever theme the Telegram client uses.
    app.setHeaderColor?.('#ffffff');
    app.setBackgroundColor?.('#f5f5f5');
    app.setBottomBarColor?.('#ffffff');
    // Scrolling lists must not pull the Mini App closed.
    app.disableVerticalSwipes?.();
  };
  document.head.appendChild(script);
}

export async function telegramLogin(who: 'player' | 'host') {
  const initData = telegramInitData();
  if (!initData) return;
  setUpTelegramUi();
  await fetch(who === 'player' ? '/api/telegram/webapp-login' : '/api/telegram/host-webapp-login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ initData }),
  }).catch(() => {});
}

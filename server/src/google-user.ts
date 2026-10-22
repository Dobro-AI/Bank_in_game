import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { AppError, Db } from './db.js';

/**
 * "Войти через Google": the super host connects their own Google account once, and the bank
 * creates folders and spreadsheets on their behalf (files live in their Drive and storage).
 * The service account still writes the data; files inside the shared folder are open to it.
 */

const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/drive'];

interface ClientConfig { client_id: string; client_secret: string }

function clientConfig(): ClientConfig | null {
  if (process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET) {
    return { client_id: process.env.GOOGLE_OAUTH_CLIENT_ID, client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET };
  }
  const file = process.env.GOOGLE_OAUTH_CLIENT_FILE;
  if (!file || !existsSync(file)) return null;
  const json = JSON.parse(readFileSync(file, 'utf8'));
  const c = json.web ?? json.installed;
  return c?.client_id && c?.client_secret ? c : null;
}

export const oauthConfigured = () => !!clientConfig();

function client(redirectUri?: string) {
  const c = clientConfig();
  if (!c) throw new AppError('Вход через Google не настроен: нет OAuth-клиента на сервере (GOOGLE_OAUTH_CLIENT_FILE)', 503);
  return new OAuth2Client({ clientId: c.client_id, clientSecret: c.client_secret, redirectUri });
}

// Pending sign-ins: state → where to return. Short-lived, in memory.
const pending = new Map<string, { returnTo: string; redirectUri: string; until: number }>();

export function authUrl(redirectUri: string, returnTo: string) {
  const state = randomBytes(16).toString('hex');
  pending.set(state, { returnTo, redirectUri, until: Date.now() + 10 * 60_000 });
  return client(redirectUri).generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES, state, include_granted_scopes: true });
}

async function setSetting(db: Db, key: string, value: string) {
  await db.query('insert into app_setting (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value', [key, value]);
}
async function getSetting(db: Db, key: string) {
  const [r] = await db.query('select value from app_setting where key = $1', [key]);
  return (r?.value as string) ?? '';
}

export async function finishAuth(db: Db, code: string, state: string) {
  const p = pending.get(state);
  pending.delete(state);
  if (!p || p.until < Date.now()) throw new AppError('Вход через Google устарел, начните заново');
  const c = client(p.redirectUri);
  const { tokens } = await c.getToken(code);
  if (!tokens.refresh_token) throw new AppError('Google не выдал постоянный доступ. Отключите банк в настройках аккаунта Google и войдите заново');
  let email = '';
  if (tokens.id_token) {
    const ticket = await c.verifyIdToken({ idToken: tokens.id_token, audience: clientConfig()!.client_id });
    email = ticket.getPayload()?.email ?? '';
  }
  await setSetting(db, 'google_user_refresh', tokens.refresh_token);
  await setSetting(db, 'google_user_email', email);
  return p.returnTo;
}

export async function connectedEmail(db: Db) {
  return (await getSetting(db, 'google_user_refresh')) ? (await getSetting(db, 'google_user_email')) || 'подключён' : null;
}

export async function disconnect(db: Db) {
  const token = await getSetting(db, 'google_user_refresh');
  if (token && clientConfig()) await client().revokeToken(token).catch(() => {});
  await setSetting(db, 'google_user_refresh', '');
  await setSetting(db, 'google_user_email', '');
}

/** An API client acting as the connected Google user, or null if nobody is connected. */
export async function userClient(db: Db) {
  const token = await getSetting(db, 'google_user_refresh');
  if (!token || !clientConfig()) return null;
  const c = client();
  c.setCredentials({ refresh_token: token });
  return c;
}

import { createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';

export function hashSecret(secret: string): string {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(secret, salt, 32).toString('hex')}`;
}

export function verifySecret(secret: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const actual = scryptSync(secret, salt, 32);
  const expected = Buffer.from(hash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function newToken() {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: tokenHash(token) };
}

export function tokenHash(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export function newRoleCode() {
  return String(randomInt(0, 10000)).padStart(4, '0');
}

export const isFourDigits = (v: unknown): v is string => typeof v === 'string' && /^\d{4}$/.test(v);

/** Fixed-window attempt limiter for 4-digit codes, which are trivially brute-forced otherwise. */
export class AttemptLimiter {
  private hits = new Map<string, { count: number; until: number }>();
  constructor(private max = 5, private windowMs = 60_000) {}

  check(key: string): boolean {
    const now = Date.now();
    const h = this.hits.get(key);
    if (!h || h.until < now) {
      this.hits.set(key, { count: 1, until: now + this.windowMs });
      return true;
    }
    h.count++;
    return h.count <= this.max;
  }
}

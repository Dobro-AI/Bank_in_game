import { Db } from './db.js';
import { hashSecret } from './security.js';

/** Creates the first Super host from env on an empty database. */
export async function ensureSuper(db: Db, login?: string, password?: string) {
  const [any] = await db.query("select 1 from staff where kind = 'super' limit 1");
  if (any) return false;
  if (!login || !password) throw new Error('Задайте SUPER_LOGIN и SUPER_PASSWORD для первого админа');
  await db.query("insert into staff (name, login, password_hash, kind) values ('Админ', $1, $2, 'super')",
    [login, hashSecret(password)]);
  return true;
}

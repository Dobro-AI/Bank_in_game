import { buildApp } from './app.js';
import { ensureSuper } from './bootstrap.js';
import { openDb } from './db.js';

const db = await openDb({ url: process.env.DATABASE_URL, dataDir: process.env.PGLITE_DIR ?? './data' });
if (await ensureSuper(db, process.env.SUPER_LOGIN, process.env.SUPER_PASSWORD)) {
  console.log(`Создан Супер-ведущий: ${process.env.SUPER_LOGIN}`);
}
const app = buildApp(db, { secureCookies: process.env.SECURE_COOKIES === '1' });
const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: process.env.HOST ?? '0.0.0.0' });
console.log(`Банк запущен: http://localhost:${port}`);

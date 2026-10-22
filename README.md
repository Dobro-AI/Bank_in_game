# Bank in Game

Простой игровой банк для ролевых игр и игр живого действия: виртуальные деньги, роли, юрлица, переводы, такты. Без реальных платежей, карт и кредитов.

Интерфейсы:
- веб-кабинет игрока (телефон и ПК);
- Telegram-бот и Telegram Mini App;
- веб-кабинет Супер-ведущего (игры, шаблоны, ответвления) и ведущего / канцелярии с таблицами переводов, сводкой по тактам и синхронизацией с Google Sheets.

Все интерфейсы работают с одной базой, поэтому балансы и переводы везде одинаковые.

## Статус

Этап 1 готов: сервер, база, веб-кабинеты игрока, ведущего и Супер-ведущего, такты, выгрузка в Excel.
Дальше: Telegram-бот и Mini App (этап 2), синхронизация с Google Sheets (этап 3).
Архитектура, модель данных и согласованные правила — в [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Стек

Node.js + TypeScript (Fastify), PostgreSQL, React + Vite. Для локального запуска и тестов используется
встроенный PostgreSQL (PGlite) — ставить базу не нужно.

## Запуск локально

Нужен Node.js 20+.

```bash
npm install
npm run seed:demo   # демо-игра «Город N»: super/super123, host/host123, коды ролей печатаются в консоль
npm run dev         # сервер http://localhost:3000, веб http://localhost:5173
```

Тесты: `npm test`.

## Продакшен

```bash
npm run build
DATABASE_URL=postgres://... SUPER_LOGIN=... SUPER_PASSWORD=... SECURE_COOKIES=1 npm start
```

| Переменная | Значение |
|---|---|
| `DATABASE_URL` | PostgreSQL; если не задана — локальный PGlite в `PGLITE_DIR` (по умолчанию `./data`) |
| `SUPER_LOGIN`, `SUPER_PASSWORD` | первый Супер-ведущий, создаётся при пустой базе |
| `PORT` | порт, по умолчанию 3000 |
| `SECURE_COOKIES=1` | включить при работе по HTTPS |
| `ANTHROPIC_API_KEY` | ключ Claude API для ИИ-помощника ведущего |
| `OPENAI_API_KEY` | необязательно: расшифровка загруженных и записанных голосовых (Claude не принимает аудио); без ключа работает только диктовка в браузере |
| `STT_MODEL` | модель расшифровки, по умолчанию `whisper-1` |

## Как устроено

- Все деньги двигаются только через одну функцию перевода (`server/src/transfers.ts`): транзакция,
  блокировка счетов, проверка баланса, уникальный ключ операции против двойного списания.
- Корневая игра описывает роли, стартовые балансы, юрлица и прайс; ответвления наследуют изменения корня,
  пока ведущий не изменил строку у себя.
- Балансы в кабинетах обновляются сами (Server-Sent Events).
- ИИ-помощник ведущего (`server/src/assistant.ts`, модель Claude Opus 5.5): у каждого ведущего свой чат по каждой игре.
  Читает данные игры через инструменты (счета, роли, переводы, сводка такта, статистика, правила и прайс),
  разбирает фото бумажек и готовит операции, которые проводятся только после подтверждения ведущего,
  помогает придумывать механики с расчётом CAPEX / OPEX / эффекта.

## Референсы

- [GoldenThrust/Virtual-Bank](https://github.com/GoldenThrust/Virtual-Bank)
- [dawidolko/NeoBank-Platform-Nuxt](https://github.com/dawidolko/NeoBank-Platform-Nuxt)
- [aliamir007/Banking-System](https://github.com/aliamir007/Banking-System)
- [ramyaaprasath/Basic-Banking-System](https://github.com/ramyaaprasath/Basic-Banking-System)
- [ThakurAmanKumar/Online-Banking-System-php](https://github.com/ThakurAmanKumar/Online-Banking-System-php)

Из них берём только общие идеи (счета, переводы, админка). Игровые правила реализуются отдельно.

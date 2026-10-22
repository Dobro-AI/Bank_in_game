# Bank in Game

Простой игровой банк для ролевых игр и игр живого действия: виртуальные деньги, роли, юрлица, переводы, такты. Без реальных платежей, карт и кредитов.

Интерфейсы:
- веб-кабинет игрока (телефон и ПК);
- Telegram-бот и Telegram Mini App;
- веб-кабинет ведущего / канцелярии с таблицами переводов, сводкой по тактам и синхронизацией с Google Sheets.

Все интерфейсы работают с одной базой, поэтому балансы и переводы везде одинаковые.

## Статус

Этап проектирования. Архитектура, экраны, модель данных и открытые вопросы — в [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Планируемый стек

Node.js + TypeScript (Fastify), PostgreSQL, React + Vite (веб и Mini App), grammY (бот), Google Sheets API.

## Референсы

- [GoldenThrust/Virtual-Bank](https://github.com/GoldenThrust/Virtual-Bank)
- [dawidolko/NeoBank-Platform-Nuxt](https://github.com/dawidolko/NeoBank-Platform-Nuxt)
- [aliamir007/Banking-System](https://github.com/aliamir007/Banking-System)
- [ramyaaprasath/Basic-Banking-System](https://github.com/ramyaaprasath/Basic-Banking-System)
- [ThakurAmanKumar/Online-Banking-System-php](https://github.com/ThakurAmanKumar/Online-Banking-System-php)

Из них берём только общие идеи (счета, переводы, админка). Игровые правила реализуются отдельно.

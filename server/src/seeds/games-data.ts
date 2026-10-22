// Two ready games from the organizers' materials (ИГРЫ/Развлечения, ИГРЫ/Еврологистика).
// Numbers follow the game boards (плацдармы); where a board is silent, the role cards.

export interface AssetDef {
  key: string; title: string; unit?: string; capacity?: number; capacityUnit?: string;
  revenue?: number; cost?: number; opex?: number; income?: number; agesTo?: string;
}
export interface RoleDef { company: string; position: string; balance: number; assets?: Record<string, number> }
export interface PriceDef { title: string; price: number; asset?: string; qty?: number }
export interface GameDef { title: string; currency: string; rules: string; assets: AssetDef[]; roles: RoleDef[]; prices: PriceDef[] }

export const RAZVLECHENIYA: GameDef = {
  title: 'Развлечения: офлайн против онлайна',
  currency: 'у.е.',
  assets: [
    { key: 'server', title: 'Сервер', capacity: 30, capacityUnit: 'ч', revenue: 1, opex: 10 },
    { key: 'venue', title: 'Офлайн-площадка', capacity: 10, capacityUnit: 'ч', revenue: 4, opex: 20 },
    { key: 'content', title: 'Контент', unit: 'ед.' },
    { key: 'studio', title: 'Студия (расходы производителя)', opex: 60 },
    { key: 'production', title: 'Мощность производства контента', unit: 'ед./такт', capacity: 1, capacityUnit: 'ед. контента' },
    { key: 'ai', title: 'ИИ-генерация контента (1 такт)', capacity: 15, capacityUnit: 'ед. контента', agesTo: 'expire' },
    { key: 'server_plus', title: 'Сервер +10 ч (технология)', capacity: 40, capacityUnit: 'ч', revenue: 1, opex: 10 },
    { key: 'venue_eco', title: 'Площадка −5 у.е. (технология)', capacity: 10, capacityUnit: 'ч', revenue: 4, opex: 15 },
    { key: 'vr', title: 'VR-комплекс (1 сервер + 1 площадка)', capacity: 20, capacityUnit: 'ч', revenue: 6, opex: 30 },
    { key: 'ar', title: 'AR-сервер', capacity: 30, capacityUnit: 'ч', revenue: 2, opex: 10 },
    { key: 'holo', title: 'Голографическое шоу (3 сервера + 1 площадка)', capacity: 30, capacityUnit: 'ч', revenue: 5, opex: 50 },
  ],
  roles: [
    { company: 'Сбербанк', position: 'Генеральный директор банка', balance: 200 },
    { company: 'Минцифры России', position: 'Регулятор', balance: 100 },
    { company: 'Tool-kit.Tech', position: 'Генеральный директор технологической компании', balance: 30 },
    { company: 'Art Pictures', position: 'Производитель контента', balance: 25, assets: { studio: 1, production: 25 } },
    { company: 'EA', position: 'Производитель контента', balance: 20, assets: { studio: 1, production: 20 } },
    { company: 'Кинопоиск', position: 'Онлайн-площадка', balance: 20, assets: { server: 2 } },
    { company: 'Steam', position: 'Онлайн-площадка', balance: 20, assets: { server: 3 } },
    { company: 'IVI', position: 'Онлайн-площадка', balance: 15, assets: { server: 2 } },
    { company: 'LaserLand', position: 'Офлайн-площадка', balance: 65, assets: { venue: 3 } },
    { company: 'Каро', position: 'Офлайн-площадка (сеть кинотеатров)', balance: 60, assets: { venue: 5 } },
    { company: 'Brooklyn Bowl', position: 'Офлайн-площадка', balance: 55, assets: { venue: 4 } },
  ],
  prices: [
    { title: 'Сервер', price: 40, asset: 'server', qty: 1 },
    { title: 'Офлайн-площадка', price: 55, asset: 'venue', qty: 1 },
    { title: 'ИИ-генерация контента (+15 ед. на 1 такт)', price: 50, asset: 'ai', qty: 1 },
    { title: 'Реклама: себестоимость 1 часа', price: 1 },
    { title: 'Внедрение «+10 ч к серверу»', price: 30 },
    { title: 'Внедрение «−5 у.е. на площадку»', price: 25 },
    { title: 'Доработка прототипа VR', price: 40 },
    { title: 'Внедрение VR', price: 30 },
    { title: 'Доработка прототипа AR', price: 60 },
    { title: 'Внедрение AR', price: 25 },
    { title: 'Доработка голографического шоу', price: 70 },
    { title: 'Внедрение голографического шоу', price: 20 },
    { title: 'Разработка новой технологии', price: 100 },
  ],
  rules: `Рынок времени клиентов — 300 часов, рынок маркетинга — 100 часов (по плацдарму).
Онлайн: 1 сервер = 30 ч в такт, нужно 2 ед. контента, обслуживание 10 у.е./такт, 1 час = 1 у.е. Новый сервер у Игротехника — 40 у.е.
Офлайн: 1 площадка = 10 ч в такт, нужна 1 ед. контента, обслуживание 20 у.е./такт, 1 час = 4 у.е. Новая площадка — 55 у.е.
Для выхода офлайн-площадки в онлайн: сервер у Игротехника 40 у.е. и лицензия Минцифры 30 у.е.
Контент продают производители (Art Pictures, EA) по 4–6 у.е. за единицу. Расходы производителя — 60 у.е./такт. ИИ-генерация у Игротехника: +15 ед. контента на 1 такт за 50 у.е.
Реклама: онлайн-площадка тратит 1 ед. мощности сервера и 1 у.е. на привлечение 1 часа с рынка маркетинга; реклама — не более 25% трафика. Привлечённые часы переходят в рынок времени на следующий такт (всего 400 часов).
Минцифры: штраф за превышение доли рекламы 10–15 у.е.; комиссия (Минцифры + представитель онлайн + представитель офлайн) решает большинством. Мероприятие на 150 ч в фиджитал-формате: подрядчики в 1 такте, проведение во 2 такте, 3 у.е. Минцифры за каждый час.
Tool-kit.Tech: «+10 ч к серверу» (внедрение 30), «−5 у.е. на площадку» (внедрение 25); прототипы VR (доработка 40, внедрение 30; 1 сервер + 1 площадка, 20 ч, 6 у.е./ч), AR (доработка 60, внедрение 25; чек 2 у.е./ч), голографическое шоу (доработка 70, внедрение 20; 3 сервера + 1 площадка, 30 ч, 5 у.е./ч). Новая технология — 100 у.е. Перевод мощностей под технологию необратим.
Сбербанк: 200 у.е.; в 1 такте кредит не более 50% счёта, ставка от 21%.
В конце такта: начислить выручку за обслуженные часы, списать обслуживание серверов и площадок и расходы производителей контента, пересчитать рынок времени.
Все сделки оформляются письменно и сдаются Игротехнику.`,
};

const truckFleet = { truck1: 5, truck2: 5, truck3: 5, truck4: 5 };
const retail = { staff: 150, stores: 100, dc: 10 };
const carrier = { staff: 100, ...truckFleet };

export const EVROLOGISTIKA: GameDef = {
  title: 'Еврологистика — глядя в будущее',
  currency: '€',
  assets: [
    { key: 'staff', title: 'Сотрудники', unit: 'чел.', opex: 1 },
    { key: 'truck1', title: 'Грузовик 1 год', capacity: 1, capacityUnit: 'рейс', revenue: 3, cost: 5, agesTo: 'truck2' },
    { key: 'truck2', title: 'Грузовик 2 года', capacity: 1, capacityUnit: 'рейс', revenue: 3, cost: 5, agesTo: 'truck3' },
    { key: 'truck3', title: 'Грузовик 3 года', capacity: 1, capacityUnit: 'рейс', revenue: 3, cost: 5, agesTo: 'truck4' },
    { key: 'truck4', title: 'Грузовик 4 года (не возит в ЕС)' },
    { key: 'tesla', title: 'Автономный грузовик Tesla', capacity: 1, capacityUnit: 'рейс', revenue: 3, cost: 5 },
    { key: 'volvo_stock', title: 'Грузовики Volvo на складе' },
    { key: 'stores', title: 'Торговые точки' },
    { key: 'dc', title: 'Распределительные центры' },
    { key: 'retail_credit', title: 'Розничное кредитование', income: 50 },
    { key: 'unemployed', title: 'Безработные', unit: 'чел.' },
  ],
  roles: [
    { company: 'Carrefour', position: 'Директор по развитию (продукты питания)', balance: 350, assets: retail },
    { company: 'Inditex', position: 'Директор по развитию (одежда)', balance: 350, assets: retail },
    { company: 'Girteka', position: 'Управляющий собственник (грузоперевозчик)', balance: 20, assets: carrier },
    { company: 'Soncotra', position: 'Управляющий собственник (грузоперевозчик)', balance: 20, assets: carrier },
    { company: 'Kreiss', position: 'Управляющий собственник (грузоперевозчик)', balance: 20, assets: carrier },
    { company: 'Volvo', position: 'Управляющий европейским подразделением', balance: 50, assets: { staff: 60 } },
    { company: 'Tesla', position: 'Управляющий европейским офисом продаж', balance: 10 },
    { company: 'Google', position: 'Управляющий европейским офисом', balance: 5 },
    { company: 'HSBC', position: 'Председатель банка', balance: 300, assets: { staff: 30, retail_credit: 1 } },
    { company: 'ITUC', position: 'Глава Международной конфедерации профсоюзов', balance: 5, assets: { unemployed: 100 } },
    { company: 'European Commission', position: 'Председатель Комиссии по технологическому развитию', balance: 0 },
  ],
  prices: [
    { title: 'Проект решения в Комиссию', price: 5 },
    { title: 'Комплектующие на 1 грузовик (Volvo)', price: 1, asset: 'volvo_stock', qty: 1 },
    { title: 'Отчисление в головной офис Tesla за 1 грузовик', price: 5 },
    { title: 'Разработка технологии в головном офисе Tesla', price: 100 },
    { title: 'Себестоимость линии на 10 автономных грузовиков (Google)', price: 70 },
    { title: 'Установка автономного РЦ (Google)', price: 10 },
    { title: 'Установка робота-продавца в торговую точку (Google)', price: 2 },
  ],
  rules: `Грузоотправители (Carrefour, Inditex): 100 ед. товара = 20 рейсов в такт. Бюджет на логистику: такт 1 — 200 €, такт 2 — 190 €, такт 3 — 180 €. Бюджет на оплату труда: 150 / 140 / 130 €. Зарплата — минимум 1 € на человека в такт.
Грузоперевозчики (Girteka, Soncotra, Kreiss): по 20 грузовиков (по 5 штук возрастом 1, 2, 3 и 4 года), 100 сотрудников. 1 грузовик = 1 рейс в такт, 5 водителей. Себестоимость рейса 10 €, из них 5 € — зарплата (зарплата 1 € платится всем сотрудникам каждый такт). Заказы с биржи дают +3 € за рейс. Грузовики старше 3 лет не возят в ЕС, каждый такт треть парка нужно обновлять.
Продажа б/у грузовиков Игротехнику: 1 год — 5 €, 2 года — 4 €, 3 года — 3 €, 4 года — 2 € (Игротехник начисляет деньги и списывает грузовик в разделе «Мощности»).
Volvo: грузовик 5 €; на 1 грузовик — 1 € комплектующих и 3 работника; владельцы субсидируют не более 50% зарплаты. Tesla: грузовик 10 € без водителя; с каждого проданного 5 € в головной офис; поставки 10 / 20 / 30 грузовиков по тактам; разработка в головном офисе 100 €, не более 1 в такт.
Google: нужно 2 технологии за 3 такта, на каждую — 70 €. Автономный грузовик (линия на 10 грузовиков, −5 € с рейса, себестоимость 70 €), автономный РЦ (−5 сотрудников, 10 € за РЦ), робот-продавец (−1 сотрудник, 2 € за точку); цена для клиентов договорная.
HSBC: 300 €, 30 сотрудников, розничное кредитование +50 € в такт.
ITUC: 100 безработных; при 200 безработных — забастовка на 1 предприятии в такт по приказу главы.
Комиссия по технологическому развитию ЕС: заседание в конце такта; проект решения — 5 €; председатель вносит 2 проекта и блокирует до 2 проектов за такт; голосов столько, сколько работников (ITUC голосует безработными).
Все сделки оформляются на бумаге, подписываются сторонами и сдаются Игротехнику — только после этого считаются случившимися.`,
};

export const GAMES = [RAZVLECHENIYA, EVROLOGISTIKA];

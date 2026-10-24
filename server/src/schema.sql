-- Idempotent schema: applied on every start.

create table if not exists staff (
  id serial primary key,
  name text not null,
  login text not null unique,
  password_hash text not null,
  kind text not null check (kind in ('super', 'host')),
  created_at timestamptz not null default now()
);

-- kind=root: template described by the super host; kind=branch: a playable copy run by a host.
create table if not exists game (
  id serial primary key,
  title text not null,
  kind text not null check (kind in ('root', 'branch')),
  parent_id int references game(id) on delete cascade,
  status text not null default 'draft' check (status in ('draft', 'active', 'finished')),
  created_at timestamptz not null default now()
);

create table if not exists game_staff (
  game_id int not null references game(id) on delete cascade,
  staff_id int not null references staff(id) on delete cascade,
  primary key (game_id, staff_id)
);

-- Config rows (role, start_account, price_item) are inherited: a branch row points to its
-- root row via source_id. local_modified=true means the branch edited it and root edits no longer apply.
create table if not exists role (
  id serial primary key,
  game_id int not null references game(id) on delete cascade,
  source_id int references role(id) on delete set null,
  local_modified boolean not null default false,
  title text not null,
  description text not null default '',
  start_balance bigint not null default 0,
  preset_first_name text not null default '',
  preset_last_name text not null default '',
  code text
);

create table if not exists start_account (
  id serial primary key,
  game_id int not null references game(id) on delete cascade,
  source_id int references start_account(id) on delete set null,
  local_modified boolean not null default false,
  title text not null,
  owner_role_id int references role(id) on delete set null,
  coowner_role_ids int[] not null default '{}',
  start_balance bigint not null default 0,
  pin text not null default ''
);

create table if not exists price_item (
  id serial primary key,
  game_id int not null references game(id) on delete cascade,
  source_id int references price_item(id) on delete set null,
  local_modified boolean not null default false,
  title text not null,
  price bigint not null check (price > 0),
  active boolean not null default true
);

create table if not exists player (
  id serial primary key,
  game_id int not null references game(id) on delete cascade,
  role_id int not null unique references role(id) on delete cascade,
  first_name text not null,
  last_name text not null,
  created_at timestamptz not null default now()
);

create table if not exists session (
  token_hash text primary key,
  staff_id int references staff(id) on delete cascade,
  player_id int references player(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- kind=host: the game-master account ("Игротехник"); unlimited, may be negative.
create table if not exists account (
  id serial primary key,
  game_id int not null references game(id) on delete cascade,
  kind text not null check (kind in ('host', 'individual', 'legal')),
  title text not null,
  balance bigint not null default 0,
  pin_hash text,
  start_account_id int references start_account(id) on delete set null,
  created_at timestamptz not null default now()
);

-- Membership is by role: whoever plays the role has the access.
create table if not exists account_member (
  account_id int not null references account(id) on delete cascade,
  role_id int not null references role(id) on delete cascade,
  member text not null check (member in ('owner', 'coowner')),
  pin_ok boolean not null default false,
  primary key (account_id, role_id)
);

create table if not exists tact (
  id serial primary key,
  game_id int not null references game(id) on delete cascade,
  number int not null,
  started_at timestamptz not null default now(),
  closed_at timestamptz,
  unique (game_id, number)
);

create table if not exists transfer (
  id serial primary key,
  game_id int not null references game(id) on delete cascade,
  tact_id int not null references tact(id),
  kind text not null check (kind in ('player', 'to_host', 'fixed_price', 'host_credit', 'host_debit', 'initial')),
  from_account_id int not null references account(id),
  to_account_id int not null references account(id),
  amount bigint not null check (amount > 0),
  price_item_id int references price_item(id) on delete set null,
  comment text not null default '',
  initiator_player_id int references player(id) on delete set null,
  initiator_staff_id int references staff(id) on delete set null,
  idempotency_key text unique,
  created_at timestamptz not null default now(),
  check (from_account_id <> to_account_id)
);
create index if not exists transfer_game_idx on transfer (game_id, tact_id);

create table if not exists tact_snapshot (
  tact_id int not null references tact(id) on delete cascade,
  account_id int not null references account(id) on delete cascade,
  balance_start bigint not null,
  received bigint not null,
  sent bigint not null,
  balance_end bigint not null,
  owners text not null default '',
  primary key (tact_id, account_id)
);

create table if not exists account_event (
  id serial primary key,
  account_id int not null references account(id) on delete cascade,
  type text not null,
  actor text not null default '',
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);

-- Free-text game rules for hosts and the assistant; inherited from the root like other config.
alter table game add column if not exists rules text not null default '';
alter table game add column if not exists rules_local_modified boolean not null default false;

-- AI assistant: each staff member has their own threads per game (not shared with other hosts).
create table if not exists assistant_thread (
  id serial primary key,
  game_id int not null references game(id) on delete cascade,
  staff_id int not null references staff(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Claude Code session the thread continues when the assistant runs through the CLI (subscription).
alter table assistant_thread add column if not exists cli_session text;

-- Append-only API transcript: `api` is the exact message sent to Claude (replayed unchanged);
-- `text`/`visible` are what the chat UI shows.
create table if not exists assistant_message (
  id serial primary key,
  thread_id int not null references assistant_thread(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  api jsonb not null,
  text text not null default '',
  has_image boolean not null default false,
  visible boolean not null default true,
  created_at timestamptz not null default now()
);

-- Operations the assistant recognised (e.g. from a photo of a paper slip); money moves only
-- after the host confirms.
create table if not exists assistant_proposal (
  id serial primary key,
  thread_id int not null references assistant_thread(id) on delete cascade,
  game_id int not null references game(id) on delete cascade,
  kind text not null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'done', 'rejected')),
  transfer_id int references transfer(id),
  created_at timestamptz not null default now()
);
-- The assistant also proposes edits of "Счета", "Переводы" and "Мощности"; the kind is checked in code.
alter table assistant_proposal drop constraint if exists assistant_proposal_kind_check;

-- ---------- Assets and capacities (servers, venues, trucks, staff...) ----------

-- Inherited config like roles. `code` is stable across root and branches, so other rows
-- (start assets, price items) refer to an asset type by code, not by id.
create table if not exists asset_type (
  id serial primary key,
  game_id int not null references game(id) on delete cascade,
  source_id int references asset_type(id) on delete set null,
  local_modified boolean not null default false,
  code text not null,
  title text not null,
  unit text not null default 'шт.',
  capacity_per_unit int not null default 0,
  capacity_unit text not null default '',
  opex_per_unit int not null default 0,
  income_per_unit int not null default 0,
  revenue_per_output int not null default 0,
  cost_per_output int not null default 0,
  ages_to text not null default '',
  sort int not null default 0,
  unique (game_id, code)
);

-- Start assets of a start legal entity, {asset_code: quantity}.
alter table start_account add column if not exists assets jsonb not null default '{}';
-- A price item may add assets to the buyer: asset_qty units of asset_code per item bought.
alter table price_item add column if not exists asset_code text not null default '';
alter table price_item add column if not exists asset_qty int not null default 0;

-- Every change of holdings is a row; holdings = sum(delta). Hosts may add, edit and delete rows.
create table if not exists asset_ledger (
  id serial primary key,
  game_id int not null references game(id) on delete cascade,
  account_id int not null references account(id) on delete cascade,
  asset_code text not null,
  delta int not null,
  tact_id int references tact(id) on delete set null,
  reason text not null check (reason in ('start', 'purchase', 'manual', 'aging')),
  transfer_id int references transfer(id) on delete set null,
  comment text not null default '',
  staff_id int references staff(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists asset_ledger_game_idx on asset_ledger (game_id, account_id);

-- Output served in a tact (hours on the market, trips...), entered by the host.
create table if not exists tact_output (
  tact_id int not null references tact(id) on delete cascade,
  account_id int not null references account(id) on delete cascade,
  asset_code text not null,
  amount int not null check (amount >= 0),
  primary key (tact_id, account_id, asset_code)
);

-- Revenue / OPEX already posted for a tact, so the button never charges twice.
create table if not exists tact_posting (
  tact_id int not null references tact(id) on delete cascade,
  account_id int not null references account(id) on delete cascade,
  kind text not null check (kind in ('revenue', 'opex')),
  amount bigint not null,
  transfer_id int references transfer(id) on delete set null,
  primary key (tact_id, account_id, kind)
);

-- Google Sheets mirror of the branch.
alter table game add column if not exists sheet_id text not null default '';
alter table game add column if not exists sheet_synced_at timestamptz;
alter table game add column if not exists sheet_error text not null default '';

-- Instance-wide settings (e.g. the Google Drive folder for game spreadsheets).
create table if not exists app_setting (key text primary key, value text not null default '');
alter table game add column if not exists drive_folder_id text not null default '';

-- Telegram users linked to players (bot and Mini App). The latest link is the active game.
create table if not exists telegram_link (
  telegram_id bigint not null,
  player_id int not null references player(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (telegram_id, player_id)
);

-- Host bot: a Telegram chat linked to a staff account, with the game chosen in that chat.
create table if not exists staff_telegram (
  telegram_id bigint primary key,
  staff_id int not null references staff(id) on delete cascade,
  game_id int references game(id) on delete set null,
  notify boolean not null default true,
  created_at timestamptz not null default now()
);

-- One-time codes from the cabinet that link a Telegram chat to a staff account (t.me/<bot>?start=<code>).
create table if not exists staff_link_code (
  code text primary key,
  staff_id int not null references staff(id) on delete cascade,
  expires_at timestamptz not null
);

-- Whether players can see and join the game now (e.g. morning game open, afternoon game closed).
alter table game add column if not exists visible boolean not null default true;

-- Several people may play one role (a team of one company): one player row per person.
alter table player drop constraint if exists player_role_id_key;
create index if not exists player_role_idx on player (role_id);

-- Google sheet tab ids by title, so the cabinet can show each tab and the sync skips a lookup.
alter table game add column if not exists sheet_gids jsonb not null default '{}';

-- Transfers the bank refused (not enough money, no access to the account...), with the reason:
-- the sheet lists them next to accepted transfers, like the organisers' "База".
create table if not exists transfer_attempt (
  id serial primary key,
  game_id int not null references game(id) on delete cascade,
  tact_id int references tact(id) on delete set null,
  kind text not null,
  from_account_id int references account(id) on delete set null,
  to_account_id int references account(id) on delete set null,
  amount bigint,
  comment text not null default '',
  initiator_player_id int references player(id) on delete set null,
  initiator_staff_id int references staff(id) on delete set null,
  reason text not null,
  created_at timestamptz not null default now()
);
create index if not exists transfer_attempt_game_idx on transfer_attempt (game_id);

-- A tact is begun by the game master ("Начать такт") and may have a countdown. Tacts that existed
-- before count as begun; the next tact, created when one ends, waits for "Начать такт".
alter table tact add column if not exists begun_at timestamptz default now();
alter table tact add column if not exists ends_at timestamptz;

-- Each game master may have their own copy of the game's Google sheet (the admin's is game.sheet_id);
-- the bank writes the same sheets into every one of them.
create table if not exists staff_sheet (
  game_id int not null references game(id) on delete cascade,
  staff_id int not null references staff(id) on delete cascade,
  sheet_id text not null,
  sheet_gids jsonb not null default '{}',
  synced_at timestamptz,
  error text not null default '',
  primary key (game_id, staff_id)
);

-- Teams of game masters: every team runs its own branch of a game (own players, codes, money);
-- the label is what a player picks at sign-in ("Павел Зайцев и Степан Лушпей").
alter table game add column if not exists team text not null default '';

-- What the bank last wrote into each editable cell of a sheet ("row:col" → [meaning, value]): a value
-- that differs on the next read is a game master's edit made right in Google, applied to the bank.
create table if not exists sheet_state (
  sheet_id text not null,
  title text not null,
  cells jsonb not null default '{}',
  primary key (sheet_id, title)
);

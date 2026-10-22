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

-- Core schema. Plain Postgres, no Supabase-specific objects, so it can be
-- tested against any Postgres 15+.
--
-- Money is always integer cents. The bank balance is never stored: it is
-- sum(bank_ledger.delta_cents), full stop.

create type ledger_kind as enum ('craving', 'trade_debit', 'trade_credit', 'adjust');
create type trade_side as enum ('buy', 'sell');
create type trade_status as enum ('queued', 'cancelled', 'submitted', 'filled', 'rejected');

create table settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

create table cravings (
  id             uuid primary key default gen_random_uuid(),
  occurred_at    timestamptz not null default now(),
  beaten         boolean not null,
  credited_cents integer not null default 0 check (credited_cents >= 0),
  note           text check (note is null or char_length(note) <= 500)
);
create index cravings_occurred_at_idx on cravings (occurred_at);

create table bank_ledger (
  id          uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  delta_cents integer not null check (delta_cents <> 0),
  kind        ledger_kind not null,
  ref_id      uuid
);
create index bank_ledger_occurred_at_idx on bank_ledger (occurred_at);
create index bank_ledger_ref_id_idx on bank_ledger (ref_id);

create table trade_requests (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  symbol          text not null check (symbol ~ '^[A-Z][A-Z0-9.]{0,9}$'),
  side            trade_side not null,
  -- Buys: the exact tier requested. Sells: an estimate at request time.
  notional_cents  integer check (notional_cents is null or notional_cents > 0),
  -- Sells only: shares to sell, fixed at submit time.
  qty             numeric check (qty is null or qty > 0),
  execute_after   timestamptz not null,
  status          trade_status not null default 'queued',
  alpaca_order_id text,
  submitted_at    timestamptz,
  filled_at       timestamptz,
  fill_price      numeric,
  fill_qty        numeric,
  reason          text,
  -- Hard ceiling and floor live in the database too, not only in the API.
  constraint buy_notional_bounds check (
    side = 'sell' or (notional_cents between 2000 and 20000)
  )
);
create index trade_requests_status_idx on trade_requests (status, execute_after);
create index trade_requests_created_at_idx on trade_requests (created_at desc);

-- Positions opened by this app. Quantity and cost come from our own fills;
-- market prices come from Alpaca at read time.
create table positions (
  symbol        text primary key,
  qty           numeric not null check (qty > 0),
  avg_cost      numeric not null check (avg_cost >= 0),
  first_fill_at timestamptz not null,
  updated_at    timestamptz not null default now()
);

create table snapshots (
  day             date primary key,
  bank_cents      integer not null,
  portfolio_cents integer not null,
  burned_cents    integer not null
);

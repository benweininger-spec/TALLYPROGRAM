-- v2: the X-effect calendar and the could-have-been (ghost) portfolio.
--
-- Every day since the quit date is clean or smoked. A day settles at local
-- midnight: a clean day's amount goes to the bank (a 'day' ledger entry), a
-- smoked day's amount becomes a ghost lot, bought at that day's close of the
-- benchmark ETF. Correcting a past day moves its amount between the two, so
--   sum(bank 'day' entries) + sum(ghost lot cents) = sum(settled day cents)
-- always holds.

alter type ledger_kind add value if not exists 'day';

create type day_state as enum ('clean', 'smoked');
create type day_source as enum ('auto', 'edit');

create table days (
  day        date primary key,
  state      day_state not null,
  source     day_source not null default 'auto',
  -- Set when the day settles. Null while it is still today (pencilled in).
  cents      integer check (cents is null or cents > 0),
  settled_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint days_settled_has_cents check ((settled_at is null) = (cents is null))
);

alter table bank_ledger add column day date;
create index bank_ledger_day_idx on bank_ledger (day);

create table ghost_lots (
  day        date primary key,
  cents      integer not null check (cents > 0),
  benchmark  text not null check (benchmark ~ '^[A-Z][A-Z0-9.]{0,9}$'),
  -- Null until that day's close is known; valued at cost meanwhile.
  shares     numeric check (shares is null or shares > 0),
  price      numeric check (price is null or price > 0),
  created_at timestamptz not null default now()
);

-- Closing price per calendar day. Weekends and holidays carry the last close.
create table price_closes (
  symbol text not null check (symbol ~ '^[A-Z][A-Z0-9.]{0,9}$'),
  day    date not null,
  close  numeric not null check (close > 0),
  primary key (symbol, day)
);

alter table snapshots add column ghost_cents integer not null default 0;

alter table public.days         enable row level security;
alter table public.ghost_lots   enable row level security;
alter table public.price_closes enable row level security;

create policy owner_read on public.days         for select to authenticated using (public.is_owner());
create policy owner_read on public.ghost_lots   for select to authenticated using (public.is_owner());
create policy owner_read on public.price_closes for select to authenticated using (public.is_owner());

revoke insert, update, delete, truncate on public.days, public.ghost_lots, public.price_closes
from anon, authenticated;

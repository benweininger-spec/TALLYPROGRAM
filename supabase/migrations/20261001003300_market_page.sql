-- The Market Page: one edition per day, written by Claude from Alpaca data
-- and kept so the paper has a morgue. The reader's universe of tickers lives
-- in settings (key 'market_universe'); the edition records the one it used.

create table editions (
  day          date primary key,
  content      jsonb not null,      -- validated edition: headline, deck, report, rungs, closing_note
  universe     jsonb not null,      -- the universe in force when it was written
  model        text not null,
  generated_at timestamptz not null default now(),
  -- Null when the edition went out clean; a reason when the day's draft was
  -- spiked and the page ran a fallback.
  spiked       text
);

alter table public.editions enable row level security;
create policy owner_read on public.editions for select to authenticated using (public.is_owner());
revoke insert, update, delete, truncate on public.editions from anon, authenticated;

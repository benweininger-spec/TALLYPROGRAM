-- Supabase-specific: lock the project to exactly one person.
--
-- 1. private.app_config holds the one allowed email. Set it once, before the
--    first login:
--      insert into private.app_config (allowed_email) values ('you@example.com');
-- 2. A trigger on auth.users refuses to create or rename any account to a
--    different email, so nobody else can ever sign up.
-- 3. Every app table has RLS on. The owner may read. Nobody may write through
--    the Supabase API at all: writes happen only in the server functions,
--    which connect as the database owner and enforce the trading rules.

create schema if not exists private;
revoke all on schema private from public;

create table if not exists private.app_config (
  id            boolean primary key default true check (id),
  allowed_email text not null check (allowed_email = lower(allowed_email) and allowed_email like '%@%')
);

create or replace function private.allowed_email()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select allowed_email from private.app_config where id
$$;

-- Callable from RLS policies by signed-in users. Returns only a boolean.
create or replace function public.is_owner()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(lower(auth.jwt() ->> 'email') = private.allowed_email(), false)
$$;
revoke all on function public.is_owner() from public;
grant execute on function public.is_owner() to authenticated;

create or replace function private.enforce_single_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  allowed text := private.allowed_email();
begin
  if allowed is null then
    raise exception 'Set private.app_config.allowed_email before signing in';
  end if;
  if new.email is null or lower(new.email) <> allowed then
    raise exception 'Sign-ups are closed';
  end if;
  return new;
end
$$;

drop trigger if exists enforce_single_user on auth.users;
create trigger enforce_single_user
  before insert or update of email on auth.users
  for each row execute function private.enforce_single_user();

alter table public.settings       enable row level security;
alter table public.cravings       enable row level security;
alter table public.bank_ledger    enable row level security;
alter table public.trade_requests enable row level security;
alter table public.positions      enable row level security;
alter table public.snapshots      enable row level security;

create policy owner_read on public.settings       for select to authenticated using (public.is_owner());
create policy owner_read on public.cravings       for select to authenticated using (public.is_owner());
create policy owner_read on public.bank_ledger    for select to authenticated using (public.is_owner());
create policy owner_read on public.trade_requests for select to authenticated using (public.is_owner());
create policy owner_read on public.positions      for select to authenticated using (public.is_owner());
create policy owner_read on public.snapshots      for select to authenticated using (public.is_owner());

-- No insert, update, or delete policies exist, so anon and authenticated
-- cannot write. Belt and braces: take the privileges away too.
revoke insert, update, delete, truncate on
  public.settings, public.cravings, public.bank_ledger,
  public.trade_requests, public.positions, public.snapshots
from anon, authenticated;

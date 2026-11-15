-- VINTO database. Already applied to the Supabase project "vinto" on 15 Nov 2026.
-- Kept here as a record. To set up a fresh project: SQL Editor > New query > paste > Run.
-- Safe to run again: it only creates what is missing.
--
-- Who can see what
--   sms_signups, contact_messages : nobody on the website. Only you, in the Supabase dashboard,
--                                   and the site's server functions (which hold the secret key).
--   profiles                      : each signed-in customer can see and edit their own row only.

-- 1. Everyone who signs up for texts ------------------------------------------------------------
create table if not exists public.sms_signups (
  id            bigint generated always as identity primary key,
  created_at    timestamptz not null default now(),
  phone         text        not null unique,          -- +614XXXXXXXX
  country       text        not null,                 -- AU or NZ
  consent       boolean     not null default true,
  consent_text  text,                                 -- the exact wording they agreed to
  source        text,                                 -- popup or footer
  page          text,
  ip_hash       text,                                 -- scrambled, used only to limit abuse
  user_agent    text,
  sms_status    text        not null default 'pending',   -- pending, sent or failed
  sms_sid       text,                                 -- Twilio's id for the text
  sms_error     text,
  sent_at       timestamptz
);
create index if not exists sms_signups_created_at_idx on public.sms_signups (created_at desc);
create index if not exists sms_signups_ip_idx on public.sms_signups (ip_hash, created_at desc);
alter table public.sms_signups enable row level security;         -- no policies = no access from the website
revoke all on public.sms_signups from anon, authenticated;
grant all on public.sms_signups to service_role;

-- 2. Messages sent through the contact form ----------------------------------------------------
create table if not exists public.contact_messages (
  id            bigint generated always as identity primary key,
  created_at    timestamptz not null default now(),
  name          text        not null,
  email         text        not null,
  message       text        not null,
  ip_hash       text,
  email_status  text        not null default 'pending'    -- pending, sent or failed
);
create index if not exists contact_messages_created_at_idx on public.contact_messages (created_at desc);
alter table public.contact_messages enable row level security;
revoke all on public.contact_messages from anon, authenticated;
grant all on public.contact_messages to service_role;

-- 3. Customer accounts: saved details -----------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text,
  full_name   text,
  phone       text,
  size        text check (size is null or size in ('S', 'M', 'L', 'XL')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.profiles enable row level security;
revoke all on public.profiles from anon;
grant select, insert, update on public.profiles to authenticated;
grant all on public.profiles to service_role;

drop policy if exists "Customers read their own profile" on public.profiles;
create policy "Customers read their own profile" on public.profiles
  for select to authenticated using ((select auth.uid()) = id);
drop policy if exists "Customers create their own profile" on public.profiles;
create policy "Customers create their own profile" on public.profiles
  for insert to authenticated with check ((select auth.uid()) = id);
drop policy if exists "Customers update their own profile" on public.profiles;
create policy "Customers update their own profile" on public.profiles
  for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

-- A profile row is made automatically whenever someone signs up (email, Google, Apple...).
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'))
  on conflict (id) do nothing;
  return new;
end;
$$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

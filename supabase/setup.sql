-- =====================================================================
-- Sales CRM: database setup for Supabase
-- Run this ONCE in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run
-- =====================================================================

-- ---------- Tables ----------

-- Emails the admin has approved. Only these emails can get an account.
create table if not exists public.allowed_users (
  email      text primary key,
  full_name  text,
  role       text not null default 'employee' check (role in ('admin', 'employee')),
  created_at timestamptz not null default now()
);

-- One row per login (created automatically when a user account is created)
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text not null,
  full_name  text,
  role       text not null default 'employee' check (role in ('admin', 'employee')),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- Clients / leads (mirrors the team's Excel sheet)
create table if not exists public.leads (
  id               bigint generated always as identity primary key,
  client_name      text not null,
  location         text,
  email            text,
  contact          text,
  remark           text,
  status           text not null default 'New',
  pms              boolean not null default false,
  aif              boolean not null default false,
  mf               boolean not null default false,
  products_pitched text,
  last_connected   date,
  next_action      text,
  next_connect     date,
  assigned_to      uuid default auth.uid() references public.profiles(id) on delete set null,
  created_by       uuid default auth.uid() references public.profiles(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists leads_assigned_to_idx on public.leads(assigned_to);
create index if not exists leads_next_connect_idx on public.leads(next_connect);

-- Call / meeting / note history per client
create table if not exists public.activities (
  id         bigint generated always as identity primary key,
  lead_id    bigint not null references public.leads(id) on delete cascade,
  user_id    uuid default auth.uid() references public.profiles(id) on delete set null,
  type       text not null,
  note       text,
  created_at timestamptz not null default now()
);
create index if not exists activities_lead_idx on public.activities(lead_id);
create index if not exists activities_created_idx on public.activities(created_at);

-- ---------- Helper functions ----------

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin' and active);
$$;

create or replace function public.is_active_user() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active);
$$;

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists leads_touch on public.leads;
create trigger leads_touch before update on public.leads
  for each row execute function public.touch_updated_at();

-- When a login is created: allow it only if the admin approved the email, then create its profile
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  a public.allowed_users;
begin
  select * into a from public.allowed_users where email = lower(new.email);
  if not found then
    raise exception 'This email is not authorised. Ask your admin to create your account.';
  end if;
  insert into public.profiles (id, email, full_name, role)
  values (new.id, lower(new.email), coalesce(a.full_name, new.email), a.role);
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- Row Level Security ----------
alter table public.allowed_users enable row level security;
alter table public.profiles      enable row level security;
alter table public.leads         enable row level security;
alter table public.activities    enable row level security;

-- allowed_users: admin only
drop policy if exists allowed_admin on public.allowed_users;
create policy allowed_admin on public.allowed_users
  for all using (public.is_admin()) with check (public.is_admin());

-- profiles: any active user can see the team list (for names); only admin can change them
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select using (id = auth.uid() or public.is_active_user());
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
  for update using (public.is_admin()) with check (public.is_admin());

-- leads: admin sees all; employees only their assigned clients
drop policy if exists leads_select on public.leads;
create policy leads_select on public.leads
  for select using (public.is_active_user() and (public.is_admin() or assigned_to = auth.uid()));
drop policy if exists leads_insert on public.leads;
create policy leads_insert on public.leads
  for insert with check (public.is_active_user() and (public.is_admin() or assigned_to = auth.uid()));
drop policy if exists leads_update on public.leads;
create policy leads_update on public.leads
  for update using (public.is_active_user() and (public.is_admin() or assigned_to = auth.uid()))
  with check (public.is_admin() or assigned_to = auth.uid());
drop policy if exists leads_delete on public.leads;
create policy leads_delete on public.leads
  for delete using (public.is_admin());

-- activities: visible/insertable for clients you can access
drop policy if exists activities_select on public.activities;
create policy activities_select on public.activities
  for select using (
    public.is_active_user() and (
      public.is_admin() or
      exists (select 1 from public.leads l where l.id = lead_id and l.assigned_to = auth.uid())
    )
  );
drop policy if exists activities_insert on public.activities;
create policy activities_insert on public.activities
  for insert with check (
    user_id = auth.uid() and public.is_active_user() and (
      public.is_admin() or
      exists (select 1 from public.leads l where l.id = lead_id and l.assigned_to = auth.uid())
    )
  );

-- ---------- First admin ----------
-- EDIT the email and name below to YOUR details before running.
-- Then create your login in: Authentication -> Users -> Add user (tick "Auto Confirm User").
insert into public.allowed_users (email, full_name, role)
values (lower('YOUR_EMAIL@example.com'), 'Your Name', 'admin')
on conflict (email) do update set role = 'admin';

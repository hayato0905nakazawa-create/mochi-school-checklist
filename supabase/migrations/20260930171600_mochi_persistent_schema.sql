create extension if not exists pgcrypto;

create table if not exists public.mochi_users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  pin_salt text not null,
  pin_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.mochi_sessions (
  token_hash text primary key,
  user_id uuid not null references public.mochi_users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists mochi_sessions_user_idx
  on public.mochi_sessions(user_id);
create index if not exists mochi_sessions_exp_idx
  on public.mochi_sessions(expires_at);
create table if not exists public.mochi_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.mochi_users(id) on delete cascade,
  text text not null,
  task_date date not null,
  task_time time not null,
  done boolean not null default false,
  notified_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists mochi_tasks_user_date_idx
  on public.mochi_tasks(user_id, task_date);
create index if not exists mochi_tasks_due_idx
  on public.mochi_tasks(task_date, task_time)
  where done = false and notified_at is null;

create table if not exists public.mochi_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.mochi_users(id) on delete cascade,
  endpoint text not null unique,
  subscription jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists mochi_subscriptions_user_idx
  on public.mochi_subscriptions(user_id);

alter table public.mochi_users enable row level security;
alter table public.mochi_sessions enable row level security;
alter table public.mochi_tasks enable row level security;
alter table public.mochi_subscriptions enable row level security;

revoke all on table public.mochi_users from anon, authenticated;
revoke all on table public.mochi_sessions from anon, authenticated;
revoke all on table public.mochi_tasks from anon, authenticated;
revoke all on table public.mochi_subscriptions from anon, authenticated;

grant all on table public.mochi_users to service_role;
grant all on table public.mochi_sessions to service_role;
grant all on table public.mochi_tasks to service_role;
grant all on table public.mochi_subscriptions to service_role;

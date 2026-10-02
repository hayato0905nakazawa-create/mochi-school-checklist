create table if not exists public.mochi_preferences (
  user_id uuid primary key references public.mochi_users(id) on delete cascade,
  reminder_interval_minutes integer not null default 5
    check (reminder_interval_minutes between 1 and 1440),
  quiet_enabled boolean not null default false,
  quiet_start time not null default '22:00',
  quiet_end time not null default '06:00',
  updated_at timestamptz not null default now()
);

insert into public.mochi_preferences (user_id)
select id from public.mochi_users
on conflict (user_id) do nothing;

alter table public.mochi_preferences enable row level security;
revoke all on table public.mochi_preferences from anon, authenticated;
grant all on table public.mochi_preferences to service_role;

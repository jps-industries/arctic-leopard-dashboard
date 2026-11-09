-- Private server-side settings (e.g. the Zapier hook for warranty emails). Only the service role reads it:
-- RLS on with no policies, and no grants to the page's roles. Values are set in the SQL editor, never in the repo.
create table if not exists public.al_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
alter table public.al_settings enable row level security;
revoke all on public.al_settings from anon, authenticated;

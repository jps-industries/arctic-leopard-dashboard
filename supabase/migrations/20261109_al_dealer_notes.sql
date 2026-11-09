-- Dealer profile notes log (calls, visits, agreements).
create table if not exists public.al_dealer_notes (
  id bigint generated always as identity primary key,
  dealer_id bigint not null references public.al_dealers(id) on delete cascade,
  note text not null,
  created_at timestamptz not null default now(),
  created_by_email text default (auth.jwt() ->> 'email')
);
create index if not exists al_dealer_notes_dealer on public.al_dealer_notes(dealer_id);
alter table public.al_dealer_notes enable row level security;
create policy "staff_all" on public.al_dealer_notes for all to authenticated using (public.al_is_staff()) with check (public.al_is_staff());
revoke all on public.al_dealer_notes from anon;

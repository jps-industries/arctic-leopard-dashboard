-- Customer profile notes log.
create table if not exists public.al_customer_notes (
  id bigint generated always as identity primary key,
  customer_id bigint not null references public.al_customers(id) on delete cascade,
  note text not null,
  created_at timestamptz not null default now(),
  created_by_email text default (auth.jwt() ->> 'email')
);
create index if not exists al_customer_notes_customer on public.al_customer_notes(customer_id);
alter table public.al_customer_notes enable row level security;
create policy "staff_all" on public.al_customer_notes for all to authenticated using (public.al_is_staff()) with check (public.al_is_staff());
revoke all on public.al_customer_notes from anon;

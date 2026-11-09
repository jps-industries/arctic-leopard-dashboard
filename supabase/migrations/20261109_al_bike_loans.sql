-- Demo / marketing bikes: who has which bike, for what, and when it comes back.
create table if not exists public.al_bike_loans (
  id bigint generated always as identity primary key,
  bike_id bigint not null references public.al_bikes(id),
  kind text not null default 'demo' check (kind in ('demo','collab','ambassador','event','media','staff')),
  status text not null default 'out' check (status in ('planned','out','returned','gifted')),
  recipient text not null,
  dealer_id bigint references public.al_dealers(id),
  phone text, email text, social_handle text, location text,
  out_date date, due_back date, returned_date date,
  agreement text,        -- what they give us: videos, posts, event days
  content_links text,    -- links to what they posted
  condition_out text, condition_back text, km_back text,
  notes text,
  created_at timestamptz not null default now()
);
create index if not exists al_bike_loans_bike on public.al_bike_loans(bike_id);
alter table public.al_bike_loans enable row level security;
create policy "staff_all" on public.al_bike_loans for all to authenticated using (public.al_is_staff()) with check (public.al_is_staff());
revoke all on public.al_bike_loans from anon;

-- Rodi Electric sells the one-off models (not on the Arctic Leopard Shopify).
insert into public.al_dealers (business_name, status, contact_name, email, state, territory, address, notes)
select 'Rodi Electric', 'active', 'SHAR', 'contact@rodihaus.co', 'WA', 'Perth (own shop)', '2/14 Foley Street, Balcatta WA 6021',
       'Our own shop. Sells the one-off models (EZ Pro, EAT 600 Trial, EXE 880 Enduro, E 20X, E 16X) that are not on the Arctic Leopard Shopify.'
where not exists (select 1 from public.al_dealers where business_name ilike 'Rodi Electric');

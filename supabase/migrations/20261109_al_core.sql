-- Arctic Leopard dashboard: core schema (lives in the RODI ELECTRIC project, al_ prefix)
-- Access: logged-in (authenticated) users only. Anon gets nothing.

create table public.al_models (
  id bigint generated always as identity primary key,
  code text unique not null,
  name text not null,
  series text,
  rrp_aud numeric(10,2),
  notes text,
  created_at timestamptz not null default now()
);

create table public.al_dealers (
  id bigint generated always as identity primary key,
  business_name text not null,
  contact_name text,
  phone text,
  email text,
  address text,
  state text,
  territory text,
  discount_pct numeric(5,2),
  status text not null default 'prospect' check (status in ('prospect','active','paused','ended')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.al_customers (
  id bigint generated always as identity primary key,
  full_name text not null,
  phone text,
  email text,
  address text,
  suburb text,
  state text,
  postcode text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.al_shipments (
  id bigint generated always as identity primary key,
  ref text not null,
  pi_number text,
  kind text not null default 'bikes' check (kind in ('bikes','parts','mixed')),
  freight_mode text check (freight_mode in ('sea','air','courier')),
  supplier text default 'Jiaxing Arctic Leopard New Energy Co',
  invoice_date date,
  usd_total numeric(12,2),
  fx_rate numeric(8,4) default 1.4243,
  freight_aud numeric(12,2),
  duty_aud numeric(12,2),
  eta date,
  arrived_at date,
  status text not null default 'ordered' check (status in ('ordered','deposit_paid','balance_paid','shipped','arrived','received','cancelled')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.al_parts (
  id bigint generated always as identity primary key,
  sku text unique,
  name text not null,
  series text,
  shopify_product_id text,
  us_retail_usd numeric(10,2),
  factory_cost_usd numeric(10,2),
  landed_cost_aud numeric(10,2),
  rrp_aud numeric(10,2),
  dealer_price_aud numeric(10,2) generated always as (round(rrp_aud * 0.7, 2)) stored,
  reorder_level int not null default 0,
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.al_shipment_lines (
  id bigint generated always as identity primary key,
  shipment_id bigint not null references public.al_shipments(id) on delete cascade,
  model_id bigint references public.al_models(id),
  part_id bigint references public.al_parts(id),
  description text not null,
  spec text,
  qty int not null check (qty > 0),
  unit_usd numeric(10,2),
  qty_received int not null default 0,
  notes text
);

create table public.al_bikes (
  id bigint generated always as identity primary key,
  model_id bigint not null references public.al_models(id),
  shipment_id bigint references public.al_shipments(id),
  frame_no text unique,
  motor_no text,
  battery_no text,
  colour text,
  landed_cost_aud numeric(10,2),
  status text not null default 'in_transit' check (status in ('in_transit','in_stock','pdi_done','reserved','sold_retail','to_dealer','demo','warranty_hold','written_off')),
  location text,
  dealer_id bigint references public.al_dealers(id),
  customer_id bigint references public.al_customers(id),
  sale_price_aud numeric(10,2),
  sold_date date,
  delivered_date date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create sequence public.al_claim_no_seq start 1001;

create table public.al_warranty_claims (
  id bigint generated always as identity primary key,
  claim_no text unique not null default ('W-' || lpad(nextval('public.al_claim_no_seq')::text, 4, '0')),
  bike_id bigint references public.al_bikes(id),
  customer_id bigint references public.al_customers(id),
  dealer_id bigint references public.al_dealers(id),
  purchase_date date,
  hours_km text,
  category text check (category in ('motor','battery','controller','charger','suspension','brakes','frame','electrical','drivetrain','plastics','other')),
  problem text not null,
  diagnosis text,
  status text not null default 'new' check (status in ('new','assessing','parts_requested','parts_received','repaired','closed','rejected')),
  factory_ref text,
  sent_to_factory_at date,
  export_batch text,
  opened_at date not null default current_date,
  closed_at date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.al_warranty_parts (
  id bigint generated always as identity primary key,
  claim_id bigint not null references public.al_warranty_claims(id) on delete cascade,
  part_id bigint references public.al_parts(id),
  description text,
  qty int not null default 1 check (qty > 0),
  source text not null default 'factory' check (source in ('factory','from_stock')),
  status text not null default 'needed' check (status in ('needed','requested','received','fitted')),
  notes text
);

create table public.al_warranty_media (
  id bigint generated always as identity primary key,
  claim_id bigint not null references public.al_warranty_claims(id) on delete cascade,
  storage_path text not null,
  caption text,
  created_at timestamptz not null default now()
);

create table public.al_warranty_events (
  id bigint generated always as identity primary key,
  claim_id bigint not null references public.al_warranty_claims(id) on delete cascade,
  from_status text,
  to_status text,
  note text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

create table public.al_stock_movements (
  id bigint generated always as identity primary key,
  part_id bigint not null references public.al_parts(id),
  qty int not null check (qty <> 0), -- + in, - out
  kind text not null check (kind in ('received','sold_retail','to_dealer','warranty','returned','adjustment')),
  shipment_id bigint references public.al_shipments(id),
  dealer_id bigint references public.al_dealers(id),
  customer_id bigint references public.al_customers(id),
  claim_id bigint references public.al_warranty_claims(id),
  unit_price_aud numeric(10,2),
  reference text,
  notes text,
  moved_at date not null default current_date,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

create table public.al_preorders (
  id bigint generated always as identity primary key,
  customer_id bigint references public.al_customers(id),
  dealer_id bigint references public.al_dealers(id),
  model_id bigint not null references public.al_models(id),
  colour text,
  deposit_aud numeric(10,2),
  deposit_date date,
  agreed_price_aud numeric(10,2),
  bike_id bigint references public.al_bikes(id),
  status text not null default 'deposit_paid' check (status in ('enquiry','deposit_paid','allocated','delivered','cancelled','refunded')),
  shopify_order text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.al_pdi (
  bike_id bigint primary key references public.al_bikes(id) on delete cascade,
  unpacked boolean not null default false,
  assembled boolean not null default false,
  charged boolean not null default false,
  torque_checked boolean not null default false,
  brakes_bled boolean not null default false,
  suspension_set boolean not null default false,
  test_ridden boolean not null default false,
  photos_taken boolean not null default false,
  completed_at date,
  completed_by text,
  notes text,
  updated_at timestamptz not null default now()
);

-- indexes on foreign keys
create index on public.al_shipment_lines(shipment_id);
create index on public.al_shipment_lines(model_id);
create index on public.al_shipment_lines(part_id);
create index on public.al_bikes(model_id);
create index on public.al_bikes(shipment_id);
create index on public.al_bikes(dealer_id);
create index on public.al_bikes(customer_id);
create index on public.al_bikes(status);
create index on public.al_warranty_claims(bike_id);
create index on public.al_warranty_claims(customer_id);
create index on public.al_warranty_claims(dealer_id);
create index on public.al_warranty_claims(status);
create index on public.al_warranty_parts(claim_id);
create index on public.al_warranty_parts(part_id);
create index on public.al_warranty_media(claim_id);
create index on public.al_warranty_events(claim_id);
create index on public.al_stock_movements(part_id);
create index on public.al_stock_movements(shipment_id);
create index on public.al_stock_movements(dealer_id);
create index on public.al_stock_movements(customer_id);
create index on public.al_stock_movements(claim_id);
create index on public.al_preorders(customer_id);
create index on public.al_preorders(dealer_id);
create index on public.al_preorders(model_id);
create index on public.al_preorders(bike_id);

-- updated_at
create or replace function public.al_touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end $$;

do $$ declare t text; begin
  foreach t in array array['al_dealers','al_customers','al_shipments','al_parts','al_bikes','al_warranty_claims','al_preorders','al_pdi'] loop
    execute format('create trigger %I before update on public.%I for each row execute function public.al_touch_updated_at()', t || '_touch', t);
  end loop;
end $$;

-- warranty status history
create or replace function public.al_log_claim_status() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    insert into public.al_warranty_events(claim_id, to_status, note) values (new.id, new.status, 'Claim opened');
  elsif new.status is distinct from old.status then
    insert into public.al_warranty_events(claim_id, from_status, to_status) values (new.id, old.status, new.status);
    if new.status in ('closed','rejected') and new.closed_at is null then
      update public.al_warranty_claims set closed_at = current_date where id = new.id;
    end if;
  end if;
  return new;
end $$;

create trigger al_warranty_claims_status after insert or update of status on public.al_warranty_claims
for each row execute function public.al_log_claim_status();

-- views (security_invoker so RLS of the caller applies)
create view public.al_part_stock with (security_invoker = true) as
select p.id, p.sku, p.name, p.series, p.rrp_aud, p.dealer_price_aud, p.landed_cost_aud, p.reorder_level,
  coalesce((select sum(m.qty) from public.al_stock_movements m where m.part_id = p.id), 0)::int as on_hand,
  coalesce((select sum(l.qty - l.qty_received) from public.al_shipment_lines l
            join public.al_shipments s on s.id = l.shipment_id
            where l.part_id = p.id and s.status not in ('received','cancelled')), 0)::int as on_order,
  coalesce((select sum(w.qty) from public.al_warranty_parts w
            join public.al_warranty_claims c on c.id = w.claim_id
            where w.part_id = p.id and w.status in ('needed','requested') and c.status not in ('closed','rejected')), 0)::int as warranty_pending
from public.al_parts p;

create view public.al_bike_summary with (security_invoker = true) as
select m.id as model_id, m.code, m.name,
  count(b.id) filter (where b.status = 'in_transit') as in_transit,
  count(b.id) filter (where b.status in ('in_stock','pdi_done')) as in_stock,
  count(b.id) filter (where b.status = 'reserved') as reserved,
  count(b.id) filter (where b.status = 'sold_retail') as sold_retail,
  count(b.id) filter (where b.status = 'to_dealer') as to_dealer,
  count(b.id) filter (where b.status = 'demo') as demo,
  count(b.id) filter (where b.status = 'warranty_hold') as warranty_hold,
  count(b.id) as total
from public.al_models m left join public.al_bikes b on b.model_id = m.id
group by m.id, m.code, m.name;

-- RLS: logged-in staff only
do $$ declare t text; begin
  foreach t in array array['al_models','al_dealers','al_customers','al_shipments','al_parts','al_shipment_lines','al_bikes','al_warranty_claims','al_warranty_parts','al_warranty_media','al_warranty_events','al_stock_movements','al_preorders','al_pdi'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "staff_all" on public.%I for all to authenticated using (true) with check (true)', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;
revoke all on sequence public.al_claim_no_seq from anon;
revoke all on public.al_part_stock, public.al_bike_summary from anon;

-- private bucket for warranty photos/videos
insert into storage.buckets (id, name, public, file_size_limit)
values ('al-warranty', 'al-warranty', false, 104857600)
on conflict (id) do nothing;

create policy "al_warranty_staff_read" on storage.objects for select to authenticated using (bucket_id = 'al-warranty');
create policy "al_warranty_staff_insert" on storage.objects for insert to authenticated with check (bucket_id = 'al-warranty');
create policy "al_warranty_staff_update" on storage.objects for update to authenticated using (bucket_id = 'al-warranty');
create policy "al_warranty_staff_delete" on storage.objects for delete to authenticated using (bucket_id = 'al-warranty');

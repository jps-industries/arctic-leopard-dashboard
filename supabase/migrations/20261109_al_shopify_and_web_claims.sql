-- Shopify order sync + public warranty claim form

alter table public.al_models add column shopify_product_id text unique;
update public.al_models set shopify_product_id = '9487516958939' where code = 'XE-PRO-R';
update public.al_models set shopify_product_id = '9487516565723' where code = 'XE-PRO-S';
update public.al_models set shopify_product_id = '9487517057243' where code = 'XF-PRO-MX';

alter table public.al_warranty_claims
  add column source text not null default 'dashboard' check (source in ('dashboard','web_form')),
  add column reported_frame_no text,
  add column reported_model text,
  add column purchased_from text;

-- One row per Shopify order processed (also stops a webhook retry being applied twice)
create table public.al_shopify_orders (
  shopify_order_id text primary key,
  order_name text,
  email text,
  customer_id bigint references public.al_customers(id),
  dealer_id bigint references public.al_dealers(id),
  total_aud numeric(12,2),
  parts_lines int not null default 0,
  bikes_reserved int not null default 0,
  preorders_created int not null default 0,
  unmatched jsonb not null default '[]'::jsonb,
  ordered_at timestamptz,
  processed_at timestamptz not null default now()
);
create index on public.al_shopify_orders(customer_id);
create index on public.al_shopify_orders(dealer_id);
alter table public.al_shopify_orders enable row level security;
create policy "staff_all" on public.al_shopify_orders for all to authenticated using (public.al_is_staff()) with check (public.al_is_staff());
revoke all on public.al_shopify_orders from anon;

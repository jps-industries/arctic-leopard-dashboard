-- Shopify refunds and cancellations synced by al-shopify-order.
alter table public.al_shopify_orders add column if not exists refunded_aud numeric(10,2) not null default 0;
alter table public.al_shopify_orders add column if not exists refund_status text;
alter table public.al_shopify_orders add column if not exists bikes_refunded int not null default 0;
alter table public.al_shopify_orders add column if not exists refund_notes jsonb;
alter table public.al_shopify_orders add column if not exists cancelled_at timestamptz;
create table if not exists public.al_shopify_refunds (
  refund_id text primary key,
  shopify_order_id text not null,
  amount_aud numeric(10,2),
  parts_restocked int not null default 0,
  bikes_released int not null default 0,
  notes jsonb,
  created_at timestamptz not null default now()
);
alter table public.al_shopify_refunds enable row level security;
create policy "staff_all" on public.al_shopify_refunds for all to authenticated using (public.al_is_staff()) with check (public.al_is_staff());
revoke all on public.al_shopify_refunds from anon;

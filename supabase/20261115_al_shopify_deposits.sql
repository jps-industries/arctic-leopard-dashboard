-- Pre-order deposit orders (STOQ "Reserve now, pay later"): what's been paid and what's still owing.
alter table al_shopify_orders add column if not exists balance_aud numeric(10,2), add column if not exists paid_aud numeric(10,2), add column if not exists fully_paid_at timestamptz;

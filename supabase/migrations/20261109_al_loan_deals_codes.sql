-- Discounted bikes for riders / creators (status "gifted" = kept by them, sold if price_paid_aud is set), and affiliate codes with commission.
alter table public.al_bike_loans alter column bike_id drop not null; -- code-only affiliates have no bike
alter table public.al_bike_loans
  add column if not exists price_paid_aud numeric(10,2),
  add column if not exists discount_pct numeric(5,2),
  add column if not exists promo_code text,
  add column if not exists commission_pct numeric(5,2),
  add column if not exists commission_flat_aud numeric(10,2),
  add column if not exists commission_paid_aud numeric(10,2) not null default 0,
  add column if not exists terms_until date;
create unique index if not exists al_bike_loans_code on public.al_bike_loans (upper(promo_code)) where promo_code is not null;
-- Shopify orders keep their discount codes (upper case) and subtotal, so code sales count automatically.
alter table public.al_shopify_orders
  add column if not exists discount_codes text[],
  add column if not exists subtotal_aud numeric(10,2);
alter table public.al_shopify_orders add column if not exists parts_aud numeric(10,2);
comment on column public.al_shopify_orders.parts_aud is 'Value of parts lines after line discounts (inc GST), for commission on parts';
comment on column public.al_bike_loans.commission_pct is 'Commission % on parts orders that use their code';
comment on column public.al_bike_loans.commission_flat_aud is 'Commission $ per bike sold with their code';
-- Collab tiers (affiliate, creator, ambassador, review_loan) and store price for discounts.
alter table public.al_bike_loans add column if not exists tier text;
alter table public.al_models add column if not exists store_price_aud numeric(10,2);
update public.al_models set store_price_aud = v.p from (values ('AL-XE-PRO-R',8790),('AL-XE-PRO-S',7990),('AL-XF-PRO-MX',6290)) v(s,p) where sku = v.s;

-- Dealer discounts split into bikes and parts; shipment lines can be warranty parts.
alter table public.al_dealers add column if not exists discount_bikes_pct numeric(5,2);
alter table public.al_dealers add column if not exists discount_parts_pct numeric(5,2);
update public.al_dealers set discount_bikes_pct = discount_pct where discount_pct is not null and discount_bikes_pct is null;
alter table public.al_shipment_lines add column if not exists for_warranty boolean not null default false;
-- al_receive_shipment(): see the applied version in Supabase (migration al_dealer_discounts_warranty_lines).

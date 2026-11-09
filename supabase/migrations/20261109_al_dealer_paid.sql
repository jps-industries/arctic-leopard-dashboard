-- Paid / owing tracking for dealer purchases (Shopify orders are paid at checkout).
alter table public.al_bikes add column if not exists paid_date date;
alter table public.al_stock_movements add column if not exists paid_date date;
update public.al_stock_movements set paid_date = moved_at where paid_date is null and reference like 'Shopify %';

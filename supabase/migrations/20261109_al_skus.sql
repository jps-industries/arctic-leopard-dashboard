-- SKUs shared with Shopify: AL-XE-###, AL-XF-###, AL-XX-### (fits XE and XF), bikes AL-<model code>.
-- The same codes are written to the Shopify variant SKU field.
alter table public.al_parts add column if not exists shopify_variant_id text;
alter table public.al_models add column if not exists sku text unique, add column if not exists shopify_variant_id text;
update public.al_models set sku = 'AL-' || code where sku is null;

-- One-off numbering (9 Nov 2026), per series in name order, parts not on Shopify last:
-- with n as (select id, 'AL-' || case series when 'XE/XF' then 'XX' else series end || '-' ||
--   lpad(row_number() over (partition by series order by (shopify_product_id is null), name)::text, 3, '0') sku from al_parts)
-- update al_parts p set sku = n.sku from n where n.id = p.id;
-- New parts: take the next free number in their series.

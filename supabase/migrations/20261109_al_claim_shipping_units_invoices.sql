-- Claim shipping to customer, ship-to address
alter table public.al_warranty_claims drop constraint al_warranty_claims_status_check;
alter table public.al_warranty_claims add constraint al_warranty_claims_status_check
  check (status in ('new','assessing','parts_requested','parts_received','shipped','delivered','repaired','closed','rejected'));
alter table public.al_warranty_claims
  add column if not exists ship_carrier text,
  add column if not exists ship_tracking text,
  add column if not exists shipped_at date,
  add column if not exists delivered_at date,
  add column if not exists ship_address text;

-- Shipment invoice file (private al-warranty bucket, shipments/<id>/)
alter table public.al_shipments add column if not exists invoice_path text;

-- Each bike gets its own unit code: <model SKU>-001, -002 ...
alter table public.al_bikes add column if not exists unit_no text unique;
create or replace function public.al_bike_unit_no() returns trigger language plpgsql set search_path = public as $$
declare base text; n int;
begin
  if new.unit_no is not null then return new; end if;
  select coalesce(sku, 'AL-' || code) into base from al_models where id = new.model_id;
  perform pg_advisory_xact_lock(hashtext('al_bike_unit_no:' || new.model_id));
  select coalesce(max(substring(unit_no from '-(\d+)$')::int), 0) + 1 into n from al_bikes where model_id = new.model_id and unit_no like base || '-%';
  new.unit_no := base || '-' || lpad(n::text, 3, '0');
  return new;
end $$;
create trigger al_bikes_unit_no before insert on public.al_bikes for each row execute function public.al_bike_unit_no();
revoke execute on function public.al_bike_unit_no() from public, anon;
update public.al_bikes b set unit_no = coalesce(m.sku, 'AL-' || m.code) || '-' || lpad(x.n::text, 3, '0')
from (select id, row_number() over (partition by model_id order by id) n from public.al_bikes) x, public.al_models m
where x.id = b.id and m.id = b.model_id and b.unit_no is null;

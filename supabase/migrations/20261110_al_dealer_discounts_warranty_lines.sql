-- Dealer discounts split into bikes and parts; shipment lines can be warranty parts.
alter table public.al_dealers add column if not exists discount_bikes_pct numeric(5,2);
alter table public.al_dealers add column if not exists discount_parts_pct numeric(5,2);
update public.al_dealers set discount_bikes_pct = discount_pct where discount_pct is not null and discount_bikes_pct is null;
alter table public.al_shipment_lines add column if not exists for_warranty boolean not null default false;

-- Receiving: warranty lines go to the claims waiting for them, extras into stock.
CREATE OR REPLACE FUNCTION public.al_receive_shipment(p_shipment_id bigint, p_date date DEFAULT CURRENT_DATE)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare v_bikes int; v_parts int; v_warranty int := 0; v_extra int := 0; v_claims text[] := '{}';
  r record; w record; v_left int; v_ref text; v_got text[];
begin
  if not public.al_is_staff() then raise exception 'Not allowed'; end if;
  select ref into v_ref from public.al_shipments where id = p_shipment_id;
  update public.al_bikes set status = 'in_stock'
   where shipment_id = p_shipment_id and status = 'in_transit';
  get diagnostics v_bikes = row_count;

  insert into public.al_stock_movements(part_id, qty, kind, shipment_id, moved_at, reference)
  select l.part_id, l.qty - l.qty_received, 'received', l.shipment_id, p_date, v_ref
    from public.al_shipment_lines l
   where l.shipment_id = p_shipment_id and l.part_id is not null and not l.for_warranty and l.qty > l.qty_received;
  select coalesce(sum(l.qty - l.qty_received), 0) into v_parts
    from public.al_shipment_lines l where l.shipment_id = p_shipment_id and l.part_id is not null and not l.for_warranty and l.qty > l.qty_received;
  update public.al_shipment_lines set qty_received = qty
   where shipment_id = p_shipment_id and part_id is not null and not for_warranty;

  for r in select * from public.al_shipment_lines where shipment_id = p_shipment_id and for_warranty and qty > qty_received order by id loop
    v_left := r.qty - r.qty_received; v_got := '{}';
    for w in select wp.id, wp.qty, wp.claim_id, c.claim_no
               from public.al_warranty_parts wp join public.al_warranty_claims c on c.id = wp.claim_id
              where wp.source = 'factory' and wp.status in ('requested','needed')
                and ((r.part_id is not null and wp.part_id = r.part_id)
                  or (r.part_id is null and wp.part_id is null and lower(trim(wp.description)) = lower(trim(r.description))))
              order by (wp.status = 'requested') desc, c.opened_at, wp.id loop
      exit when v_left <= 0;
      continue when w.qty > v_left;
      update public.al_warranty_parts set status = 'received' where id = w.id;
      insert into public.al_warranty_events(claim_id, note) values (w.claim_id, w.qty || 'x ' || r.description || ' arrived (' || coalesce(v_ref, 'shipment') || ')');
      update public.al_warranty_claims set status = 'parts_received' where id = w.claim_id and status in ('new','assessing','parts_requested');
      v_left := v_left - w.qty; v_warranty := v_warranty + w.qty; v_got := v_got || w.claim_no;
      if not (w.claim_no = any(v_claims)) then v_claims := v_claims || w.claim_no; end if;
    end loop;
    if v_left > 0 and r.part_id is not null then
      insert into public.al_stock_movements(part_id, qty, kind, shipment_id, moved_at, reference) values (r.part_id, v_left, 'received', p_shipment_id, p_date, coalesce(v_ref, '') || ' (warranty extra)');
      v_extra := v_extra + v_left;
    end if;
    update public.al_shipment_lines set qty_received = qty,
      notes = trim(both ' ' from coalesce(notes, '') || ' Warranty: ' || coalesce(nullif(array_to_string(v_got, ', '), ''), 'no claim waiting') || case when v_left > 0 then ' · ' || v_left || (case when r.part_id is not null then ' extra to stock' else ' not matched' end) else '' end)
     where id = r.id;
  end loop;

  update public.al_shipments set status = 'received', arrived_at = coalesce(arrived_at, p_date)
   where id = p_shipment_id;
  return jsonb_build_object('bikes', v_bikes, 'parts', v_parts + v_extra, 'warranty', v_warranty, 'claims', to_jsonb(v_claims));
end $function$
;

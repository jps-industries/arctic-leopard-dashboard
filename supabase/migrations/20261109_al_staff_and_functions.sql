-- Staff allow-list: being logged in is not enough, the email must be in al_staff.
create table public.al_staff (
  email text primary key check (email = lower(email)),
  name text,
  created_at timestamptz not null default now()
);
alter table public.al_staff enable row level security;
revoke all on public.al_staff from anon;

create or replace function public.al_is_staff() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.al_staff s where s.email = lower(coalesce(auth.jwt() ->> 'email', '')));
$$;
revoke all on function public.al_is_staff() from public, anon;
grant execute on function public.al_is_staff() to authenticated;

create policy "staff_read" on public.al_staff for select to authenticated using (public.al_is_staff());

do $$ declare t text; begin
  foreach t in array array['al_models','al_dealers','al_customers','al_shipments','al_parts','al_shipment_lines','al_bikes','al_warranty_claims','al_warranty_parts','al_warranty_media','al_warranty_events','al_stock_movements','al_preorders','al_pdi'] loop
    execute format('alter policy "staff_all" on public.%I to authenticated using (public.al_is_staff()) with check (public.al_is_staff())', t);
  end loop;
end $$;

alter policy "al_warranty_staff_read" on storage.objects using (bucket_id = 'al-warranty' and public.al_is_staff());
alter policy "al_warranty_staff_insert" on storage.objects with check (bucket_id = 'al-warranty' and public.al_is_staff());
alter policy "al_warranty_staff_update" on storage.objects using (bucket_id = 'al-warranty' and public.al_is_staff());
alter policy "al_warranty_staff_delete" on storage.objects using (bucket_id = 'al-warranty' and public.al_is_staff());

-- Receive a shipment: bikes in transit -> in stock, outstanding part lines -> stock movements.
create or replace function public.al_receive_shipment(p_shipment_id bigint, p_date date default current_date)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_bikes int; v_parts int;
begin
  if not public.al_is_staff() then raise exception 'Not allowed'; end if;
  update public.al_bikes set status = 'in_stock'
   where shipment_id = p_shipment_id and status = 'in_transit';
  get diagnostics v_bikes = row_count;

  insert into public.al_stock_movements(part_id, qty, kind, shipment_id, moved_at, reference)
  select l.part_id, l.qty - l.qty_received, 'received', l.shipment_id, p_date, s.ref
    from public.al_shipment_lines l join public.al_shipments s on s.id = l.shipment_id
   where l.shipment_id = p_shipment_id and l.part_id is not null and l.qty > l.qty_received;
  select coalesce(sum(l.qty - l.qty_received), 0) into v_parts
    from public.al_shipment_lines l where l.shipment_id = p_shipment_id and l.part_id is not null and l.qty > l.qty_received;
  update public.al_shipment_lines set qty_received = qty
   where shipment_id = p_shipment_id and part_id is not null;

  update public.al_shipments set status = 'received', arrived_at = coalesce(arrived_at, p_date)
   where id = p_shipment_id;
  return jsonb_build_object('bikes', v_bikes, 'parts', v_parts);
end $$;
revoke all on function public.al_receive_shipment(bigint, date) from public, anon;
grant execute on function public.al_receive_shipment(bigint, date) to authenticated;

-- Parts fitted from our own stock on a warranty job come out of stock automatically.
create or replace function public.al_warranty_part_stock() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.source = 'from_stock' and new.status = 'fitted' and new.part_id is not null
     and (tg_op = 'INSERT' or old.status is distinct from 'fitted') then
    insert into public.al_stock_movements(part_id, qty, kind, claim_id, reference)
    select new.part_id, -new.qty, 'warranty', new.claim_id, c.claim_no
      from public.al_warranty_claims c where c.id = new.claim_id;
  end if;
  return new;
end $$;
create trigger al_warranty_parts_stock after insert or update of status on public.al_warranty_parts
for each row execute function public.al_warranty_part_stock();

-- Warranty internal notes become a dated log (al_warranty_events rows with a note and no status change).
alter table public.al_warranty_events add column if not exists created_by_email text default (auth.jwt() ->> 'email');
insert into public.al_warranty_events (claim_id, note, created_at, created_by_email)
select id, trim(notes), coalesce(updated_at, now()), null from public.al_warranty_claims where coalesce(trim(notes), '') <> '';
update public.al_warranty_claims set notes = null where coalesce(trim(notes), '') <> '';

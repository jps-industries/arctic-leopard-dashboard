-- Claims carry their own model, so bikes we didn't sell (Global Bike / Pedl stock) can be claimed
alter table public.al_warranty_claims add column model_id bigint references public.al_models(id);
create index on public.al_warranty_claims(model_id);

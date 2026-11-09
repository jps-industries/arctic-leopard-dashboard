alter table public.al_warranty_claims add column if not exists invoice_no text;
comment on column public.al_warranty_claims.invoice_no is 'Invoice or receipt number from the proof of purchase';

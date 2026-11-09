# Arctic Leopard Australia Desk

Internal dashboard for Arctic Leopard Australia: shipments, bikes by frame number, parts stock, dealers, customers, pre-orders and warranty claims with an Excel parts request for the factory. A single `index.html` served by GitHub Pages, same pattern as Parts Desk.

- **Data:** Supabase project `dobonmovezqepjgzfwmt` (RODI ELECTRIC), tables prefixed `al_`. Rodi's own tables are separate and untouched.
- **Access:** email and password login (Supabase Auth). Being logged in isn't enough: the email must also be in `al_staff`. Every `al_` table and the private `al-warranty` photo bucket check this through `al_is_staff()`.
- **Key in the page:** the Supabase *publishable* key is meant to be public; the data is protected by row-level security.
- **Adding a person:** insert their email (lower case) into `al_staff` in the Supabase SQL editor, then they use "Create a login" on the page.

## Schema

`supabase/migrations/` holds the SQL that created the tables, views (`al_part_stock`, `al_bike_summary`), triggers (claim status history, warranty parts fitted from stock) and `al_receive_shipment()`. `supabase/seed/seed.sql` is the initial load: container 1 (52 bikes, 7 Sep 2026 invoice), the 12 Oct parts order (186 pcs), 192 XE/XF parts with RRPs, and two prospect dealers.

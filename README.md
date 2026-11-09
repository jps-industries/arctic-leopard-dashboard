# Arctic Leopard Australia Desk

Internal dashboard for Arctic Leopard Australia: shipments, bikes by frame number, parts stock, dealers, customers, pre-orders and warranty claims with an Excel parts request for the factory. A single `index.html` served by GitHub Pages, same pattern as Parts Desk.

- **Data:** Supabase project `dobonmovezqepjgzfwmt` (RODI ELECTRIC), tables prefixed `al_`. Rodi's own tables are separate and untouched.
- **Access:** email and password login (Supabase Auth). Being logged in isn't enough: the email must also be in `al_staff`. Every `al_` table and the private `al-warranty` photo bucket check this through `al_is_staff()`.
- **Key in the page:** the Supabase *publishable* key is meant to be public; the data is protected by row-level security.
- **Adding a person:** insert their email (lower case) into `al_staff` in the Supabase SQL editor, then they use "Create a login" on the page.

## Schema

`supabase/migrations/` holds the SQL that created the tables, views (`al_part_stock`, `al_bike_summary`), triggers (claim status history, warranty parts fitted from stock) and `al_receive_shipment()`. `supabase/seed/seed.sql` is the initial load: container 1 (52 bikes, 7 Sep 2026 invoice), the 12 Oct parts order (186 pcs), 192 XE/XF parts with RRPs, and two prospect dealers.

## Shopify order sync

Edge function `al-shopify-order` (Supabase) receives Shopify's **Order payment** webhook. For each paid order it:

- matches the email to a dealer (`al_dealers.email`) or finds/creates the customer;
- takes parts out of stock (matched on `al_parts.shopify_product_id`), as a dealer sale or retail sale;
- for bikes (matched on `al_models.shopify_product_id`), reserves the next free bike of that model (PDI done, then in stock, then in transit) and records a pre-order; if none is free it creates a pre-order to allocate later;
- logs the order in `al_shopify_orders`, including anything it couldn't match. Shopify retries are ignored.

Setup: Shopify admin > Settings > Notifications > Webhooks > Create webhook, event **Order payment**, format JSON, URL `https://dobonmovezqepjgzfwmt.supabase.co/functions/v1/al-shopify-order`. Put the signing key shown on that page into the Supabase edge function secret `AL_SHOPIFY_WEBHOOK_SECRET`.

Refunds and cancellations are not reversed automatically; adjust stock on the Parts tab.

## Website warranty form

`claim.html` is a public form (no login) that posts to the edge function `al-warranty-submit`, which creates the customer, a New claim marked Website, and stores the photos and proof of purchase in the private bucket. To put it on the Shopify warranty page, add a **Custom Liquid** section with:

```html
<iframe id="al-claim" src="https://jps-industries.github.io/arctic-leopard-dashboard/claim.html" style="width:100%;border:0;min-height:1400px" title="Warranty claim form"></iframe>
<script>addEventListener("message",e=>{if(e.data&&e.data.alClaimHeight)document.getElementById("al-claim").style.height=e.data.alClaimHeight+"px"});</script>
```

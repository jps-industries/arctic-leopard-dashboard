# Arctic Leopard Australia Dashboard

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

Setup (recommended): create an app in the Shopify **Dev Dashboard** (dev.shopify.com), give it the scopes `read_products, read_inventory, write_inventory, read_locations, read_orders`, release a version and install it on the store. Then set Supabase edge function secrets `AL_SHOPIFY_SHOP` = `xr02jp-6s.myshopify.com`, `AL_SHOPIFY_CLIENT_ID` and `AL_SHOPIFY_CLIENT_SECRET` from the app's Settings page. On the dashboard, Parts > **Update Shopify stock** registers the Order payment webhook and pushes stock. Webhooks the app creates are signed with the client secret.

Alternative: Shopify admin > Settings > Notifications > Webhooks > Create webhook, event **Order payment**, JSON, URL `https://dobonmovezqepjgzfwmt.supabase.co/functions/v1/al-shopify-order`, and put its signing key in `AL_SHOPIFY_WEBHOOK_SECRET`.

## SKUs and Shopify stock

Parts: `AL-XE-###`, `AL-XF-###`, `AL-XX-###` (fits both). Bike models: `AL-<model code>` (e.g. `AL-XE-PRO-R`), and each bike gets a unit number `AL-XE-PRO-R-001` (trigger `al_bike_unit_no`). The part and model SKUs are on the Shopify variants. Shopify sells by model, so `al-shopify-stock` sets each model's Shopify stock to bikes in stock/PDI done and not reserved, and each part's to its on-hand count. It runs after a shipment is received and from Parts > Update Shopify stock.

## Factory invoices

Shipments > Upload factory invoice creates a shipment from the factory PI. Excel files are read (header row with Description / Unit price / QTY; "Chinese — English" descriptions keep the English) and lines are linked to bike models by name and to parts by earlier lines with the same description; bike records are created per unit. PDFs are attached only. The file is stored in the private bucket under `shipments/<id>/`.

Refunds and cancellations are not reversed automatically; adjust stock on the Parts tab.

## Website warranty form

`claim.html` is a public form (no login) that posts to the edge function `al-warranty-submit`, which creates the customer, a New claim marked Website, and stores the photos and proof of purchase in the private bucket. It then posts the claim to a Zapier webhook (workflow "Arctic Leopard warranty claim emails"), which emails the customer a confirmation and the team an alert from contact@arcticleopardaustralia.com. The hook URL and its key live in the private `al_settings` table (`zapier_claim_hook`, `zapier_claim_key`), not in this repo. To put it on the Shopify warranty page, add a **Custom Liquid** section with:

```html
<div style="width:760px;max-width:calc(100vw - 32px);margin:0 auto">
  <iframe id="al-claim" src="https://jps-industries.github.io/arctic-leopard-dashboard/claim.html" title="Warranty claim form" style="width:100%;height:2100px;border:0;display:block;background:transparent" loading="lazy"></iframe>
</div>
<script>
  window.addEventListener("message", function (e) {
    if (e.origin !== "https://jps-industries.github.io" || !e.data) return;
    var f = document.getElementById("al-claim");
    if (e.data.alClaimHeight) f.style.height = (e.data.alClaimHeight + 10) + "px";
    if (e.data.alClaimDone) f.scrollIntoView({ behavior: "smooth", block: "start" });
  });
</script>
```

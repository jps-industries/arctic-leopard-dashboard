// Shopify "Order payment" webhook -> Arctic Leopard dashboard.
// Parts come out of stock, the customer is created or matched (or the dealer, by email),
// bike orders reserve the next in-stock bike of that model (or become a pre-order if none).
// Secret: AL_SHOPIFY_WEBHOOK_SECRET = the signing key shown under Shopify Settings > Notifications > Webhooks.
import { createClient } from "npm:@supabase/supabase-js@2.116.0";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const SECRET = Deno.env.get("AL_SHOPIFY_WEBHOOK_SECRET") ?? "";

async function validHmac(raw: Uint8Array, header: string | null): Promise<boolean> {
  if (!SECRET || !header) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, raw));
  const b64 = btoa(String.fromCharCode(...sig));
  if (b64.length !== header.length) return false;
  let diff = 0;
  for (let i = 0; i < b64.length; i++) diff |= b64.charCodeAt(i) ^ header.charCodeAt(i);
  return diff === 0;
}

const like = (v: string) => v.replace(/[\\%_]/g, (c) => "\\" + c);
const must = <T>(r: { data: T; error: unknown }) => { if (r.error) throw r.error; return r.data; };

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  const raw = new Uint8Array(await req.arrayBuffer());
  if (!(await validHmac(raw, req.headers.get("x-shopify-hmac-sha256")))) return new Response("bad signature", { status: 401 });

  const order = JSON.parse(new TextDecoder().decode(raw));
  const orderId = String(order.id);
  // Already processed? Shopify retries webhooks, so this must be idempotent.
  const seen = must(await db.from("al_shopify_orders").select("shopify_order_id").eq("shopify_order_id", orderId).maybeSingle());
  if (seen) return new Response("already processed");
  // Claim the order id first so a parallel retry can't double-process it.
  const claim = await db.from("al_shopify_orders").insert({ shopify_order_id: orderId, order_name: order.name, email: (order.email || "").toLowerCase() || null, ordered_at: order.created_at, total_aud: Number(order.total_price) || null });
  if (claim.error) return new Response("already processing");

  try {
    const email = (order.email || order.customer?.email || "").trim().toLowerCase();
    const ship = order.shipping_address || order.billing_address || {};
    const name = [order.customer?.first_name || ship.first_name, order.customer?.last_name || ship.last_name].filter(Boolean).join(" ") || email || "Shopify customer";

    // Dealer if the email matches one, otherwise a retail customer.
    let dealerId: number | null = null, customerId: number | null = null;
    if (email) {
      const d = must(await db.from("al_dealers").select("id").ilike("email", like(email)).limit(1));
      if (d.length) dealerId = d[0].id;
    }
    if (!dealerId) {
      const c = email ? must(await db.from("al_customers").select("id").ilike("email", like(email)).limit(1)) : [];
      if (c.length) customerId = c[0].id;
      else {
        const ins = must(await db.from("al_customers").insert({
          full_name: name, email: email || null, phone: order.phone || ship.phone || order.customer?.phone || null,
          address: [ship.address1, ship.address2].filter(Boolean).join(", ") || null, suburb: ship.city || null,
          state: ship.province_code || null, postcode: ship.zip || null, notes: `Created from Shopify order ${order.name}`,
        }).select("id").single());
        customerId = ins.id;
      }
    }

    let partsLines = 0, bikes = 0, preorders = 0;
    const unmatched: unknown[] = [];
    const ref = `Shopify ${order.name}`;
    const date = (order.processed_at || order.created_at || new Date().toISOString()).slice(0, 10);

    for (const li of order.line_items || []) {
      const pid = li.product_id ? String(li.product_id) : null;
      const sku = typeof li.sku === "string" && li.sku.trim() ? li.sku.trim() : null;
      const qty = Number(li.quantity) || 0;
      const unit = Number(li.price) || null;
      if ((!pid && !sku) || qty <= 0) { unmatched.push({ title: li.title, qty, reason: "no product" }); continue; }

      // Match on SKU first (same code in Shopify and the dashboard), then on the Shopify product ID.
      let part = sku ? must(await db.from("al_parts").select("id").eq("sku", sku).limit(1)) : [];
      if (!part.length && pid) part = must(await db.from("al_parts").select("id").eq("shopify_product_id", pid).limit(1));
      if (part.length) {
        must(await db.from("al_stock_movements").insert({
          part_id: part[0].id, qty: -qty, kind: dealerId ? "to_dealer" : "sold_retail",
          dealer_id: dealerId, customer_id: customerId, unit_price_aud: unit, reference: ref, moved_at: date,
        }));
        partsLines++;
        continue;
      }

      let model = sku ? must(await db.from("al_models").select("id,name").eq("sku", sku).limit(1)) : [];
      if (!model.length && pid) model = must(await db.from("al_models").select("id,name").eq("shopify_product_id", pid).limit(1));
      if (model.length) {
        for (let i = 0; i < qty; i++) {
          // Prefer a bike already in stock (PDI done first), then one on the water.
          let bike = null;
          for (const st of [["pdi_done"], ["in_stock"], ["in_transit"]]) {
            const b = must(await db.from("al_bikes").select("id,status").eq("model_id", model[0].id).in("status", st).is("customer_id", null).is("dealer_id", null).order("id").limit(1));
            if (b.length) { bike = b[0]; break; }
          }
          if (bike) {
            must(await db.from("al_bikes").update({ status: "reserved", customer_id: customerId, dealer_id: dealerId, sale_price_aud: unit, notes: `Reserved by ${ref} (was ${bike.status}). Confirm frame no. at delivery.` }).eq("id", bike.id));
            must(await db.from("al_preorders").insert({ customer_id: customerId, dealer_id: dealerId, model_id: model[0].id, agreed_price_aud: unit, deposit_aud: unit, deposit_date: date, bike_id: bike.id, status: "allocated", shopify_order: order.name, notes: "Paid online" }));
            bikes++;
          } else {
            must(await db.from("al_preorders").insert({ customer_id: customerId, dealer_id: dealerId, model_id: model[0].id, agreed_price_aud: unit, deposit_aud: unit, deposit_date: date, status: "deposit_paid", shopify_order: order.name, notes: "Paid online, no bike free to allocate" }));
            preorders++;
          }
        }
        continue;
      }
      unmatched.push({ title: li.title, qty, sku, product_id: pid, reason: "not in dashboard" });
    }

    must(await db.from("al_shopify_orders").update({ customer_id: customerId, dealer_id: dealerId, parts_lines: partsLines, bikes_reserved: bikes, preorders_created: preorders, unmatched }).eq("shopify_order_id", orderId));
    return new Response("ok");
  } catch (e) {
    // Let Shopify retry: remove the claim row so the retry can process it.
    await db.from("al_shopify_orders").delete().eq("shopify_order_id", orderId);
    console.error(e);
    return new Response("error", { status: 500 });
  }
});

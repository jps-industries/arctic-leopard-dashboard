// Shopify webhooks -> Arctic Leopard dashboard: "Order payment" (orders/paid), "Refund create" (refunds/create)
// and "Order cancellation" (orders/cancelled), told apart by the X-Shopify-Topic header. "Order creation" (orders/create)
// is used only for pre-order deposit orders (partially paid), which never fire orders/paid until the balance is paid.
// Refunds: restocked part lines go back into stock, refunded bikes are released back to stock (unless already
// handed over), pre-orders are marked refunded, and the order's refunded amount / bike count reduce commission.
// Discount codes are saved on the order so affiliate / creator codes count sales and commission.
// Parts come out of stock, the customer is created or matched (or the dealer, by email),
// bike orders reserve the next in-stock bike of that model (or become a pre-order if none).
// Signed with AL_SHOPIFY_CLIENT_SECRET when the webhook is registered by the dashboard's Shopify app,
// or AL_SHOPIFY_WEBHOOK_SECRET (the key under Shopify Settings > Notifications > Webhooks) if made by hand.
import { createClient } from "npm:@supabase/supabase-js@2.116.0";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const SECRETS = [Deno.env.get("AL_SHOPIFY_CLIENT_SECRET"), Deno.env.get("AL_SHOPIFY_WEBHOOK_SECRET")].filter((x): x is string => !!x);

async function validHmac(raw: Uint8Array, header: string | null): Promise<boolean> {
  if (!header) return false;
  for (const s of SECRETS) if (await hmacMatches(s, raw, header)) return true;
  return false;
}

async function hmacMatches(secret: string, raw: Uint8Array, header: string): Promise<boolean> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
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

  const topic = (req.headers.get("x-shopify-topic") || "orders/paid").toLowerCase();
  const payload = JSON.parse(new TextDecoder().decode(raw));
  if (topic === "refunds/create") return await handleRefund(payload);
  if (topic === "orders/cancelled") {
    const r = await db.from("al_shopify_orders").update({ cancelled_at: payload.cancelled_at || new Date().toISOString() }).eq("shopify_order_id", String(payload.id));
    if (r.error) { console.error(r.error); return new Response("error", { status: 500 }); }
    return new Response("ok");
  }
  const order = payload;
  const orderId = String(order.id);
  // Pre-order deposits (STOQ "Reserve now, pay later"): Shopify marks these "partially_paid" and only sends
  // orders/paid once the balance is collected, so deposit orders come in on orders/create instead.
  const total = Number(order.total_price) || 0;
  const outstanding = Math.max(0, Number(order.total_outstanding) || 0);
  const isDeposit = order.financial_status === "partially_paid" || outstanding > 0.009;
  const paidAud = Math.round((total - outstanding) * 100) / 100;
  if (topic === "orders/create" && !isDeposit) return new Response("not a deposit order, waiting for orders/paid");
  // Already processed? Shopify retries webhooks, so this must be idempotent.
  const seen = must(await db.from("al_shopify_orders").select("shopify_order_id,balance_aud").eq("shopify_order_id", orderId).maybeSingle());
  if (seen) {
    // A deposit order now paid in full: settle the pre-order and mark the bike paid.
    if (!isDeposit && Number(seen.balance_aud) > 0) {
      const today = new Date().toISOString().slice(0, 10);
      must(await db.from("al_shopify_orders").update({ balance_aud: 0, paid_aud: total, fully_paid_at: new Date().toISOString() }).eq("shopify_order_id", orderId));
      const pre = must(await db.from("al_preorders").select("id,agreed_price_aud,bike_id,notes").eq("shopify_order", order.name));
      for (const p of pre) {
        must(await db.from("al_preorders").update({ deposit_aud: p.agreed_price_aud, notes: [p.notes, `Balance paid online ${today}`].filter(Boolean).join(". ") }).eq("id", p.id));
        if (p.bike_id) must(await db.from("al_bikes").update({ paid_date: today }).eq("id", p.bike_id));
      }
      return new Response("balance paid");
    }
    return new Response("already processed");
  }
  // Claim the order id first so a parallel retry can't double-process it.
  const claim = await db.from("al_shopify_orders").insert({ shopify_order_id: orderId, order_name: order.name, email: (order.email || "").toLowerCase() || null, ordered_at: order.created_at, total_aud: Number(order.total_price) || null,
    subtotal_aud: order.subtotal_price != null ? Number(order.subtotal_price) : null,
    discount_codes: (order.discount_codes || []).map((d: { code?: string }) => String(d.code || "").trim().toUpperCase()).filter(Boolean),
    paid_aud: paidAud, balance_aud: isDeposit ? outstanding : 0, fully_paid_at: isDeposit ? null : new Date().toISOString() });
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

    let partsLines = 0, bikes = 0, preorders = 0, partsAud = 0;
    const unmatched: unknown[] = [];
    const bikeLines: { modelId: number; unit: number | null; bike: { id: number; status: string } | null }[] = [];
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
          dealer_id: dealerId, customer_id: customerId, unit_price_aud: unit, reference: ref, moved_at: date, paid_date: date,
        }));
        partsLines++;
        partsAud += (unit || 0) * qty - (li.discount_allocations || []).reduce((t: number, d: { amount?: string }) => t + (Number(d.amount) || 0), 0);
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
            // Reserve straight away so the same bike can't be sold twice; the pre-order row is added below.
            must(await db.from("al_bikes").update({ status: "reserved", customer_id: customerId, dealer_id: dealerId, sale_price_aud: unit }).eq("id", bike.id));
          }
          bikeLines.push({ modelId: model[0].id, unit, bike });
        }
        continue;
      }
      unmatched.push({ title: li.title, qty, sku, product_id: pid, reason: "not in dashboard" });
    }

    // Pre-order rows. For a deposit order, the money paid so far (less any parts) is split across the bikes.
    const perBikePaid = bikeLines.length ? Math.max(0, Math.round(((paidAud - partsAud) / bikeLines.length) * 100) / 100) : 0;
    for (const b of bikeLines) {
      const dep = isDeposit ? Math.min(b.unit ?? perBikePaid, perBikePaid) : b.unit;
      const bal = isDeposit && b.unit != null ? Math.max(0, Math.round((b.unit - (dep || 0)) * 100) / 100) : 0;
      const payNote = isDeposit ? `Deposit A$${dep} paid online, balance A$${bal} due` : "Paid online";
      if (b.bike) {
        must(await db.from("al_bikes").update({ paid_date: isDeposit ? null : date, notes: `Reserved by ${ref} (was ${b.bike.status}). ${payNote}. Confirm frame no. at delivery.` }).eq("id", b.bike.id));
        must(await db.from("al_preorders").insert({ customer_id: customerId, dealer_id: dealerId, model_id: b.modelId, agreed_price_aud: b.unit, deposit_aud: dep, deposit_date: date, bike_id: b.bike.id, status: "allocated", shopify_order: order.name, notes: payNote }));
        bikes++;
      } else {
        must(await db.from("al_preorders").insert({ customer_id: customerId, dealer_id: dealerId, model_id: b.modelId, agreed_price_aud: b.unit, deposit_aud: dep, deposit_date: date, status: "deposit_paid", shopify_order: order.name, notes: payNote + ", no bike free to allocate" }));
        preorders++;
      }
    }

    must(await db.from("al_shopify_orders").update({ customer_id: customerId, dealer_id: dealerId, parts_lines: partsLines, bikes_reserved: bikes, preorders_created: preorders, parts_aud: Math.round(partsAud * 100) / 100, unmatched }).eq("shopify_order_id", orderId));
    return new Response("ok");
  } catch (e) {
    // Let Shopify retry: remove the claim row so the retry can process it.
    await db.from("al_shopify_orders").delete().eq("shopify_order_id", orderId);
    console.error(e);
    return new Response("error", { status: 500 });
  }
});

async function matchLine(li: { sku?: string; product_id?: number | string }) {
  const sku = typeof li.sku === "string" && li.sku.trim() ? li.sku.trim() : null;
  const pid = li.product_id ? String(li.product_id) : null;
  let part = sku ? must(await db.from("al_parts").select("id").eq("sku", sku).limit(1)) : [];
  if (!part.length && pid) part = must(await db.from("al_parts").select("id").eq("shopify_product_id", pid).limit(1));
  if (part.length) return { part: part[0].id as number };
  let model = sku ? must(await db.from("al_models").select("id").eq("sku", sku).limit(1)) : [];
  if (!model.length && pid) model = must(await db.from("al_models").select("id").eq("shopify_product_id", pid).limit(1));
  if (model.length) return { model: model[0].id as number };
  return {};
}

// deno-lint-ignore no-explicit-any
async function handleRefund(refund: any): Promise<Response> {
  const refundId = String(refund.id), orderId = String(refund.order_id);
  const amount = (refund.transactions || []).filter((t: { kind?: string; status?: string }) => t.kind === "refund" && t.status === "success").reduce((a: number, t: { amount?: string }) => a + (Number(t.amount) || 0), 0);
  const claim = await db.from("al_shopify_refunds").insert({ refund_id: refundId, shopify_order_id: orderId, amount_aud: amount });
  if (claim.error) return new Response("already processed");
  try {
    const ord = must(await db.from("al_shopify_orders").select("*").eq("shopify_order_id", orderId).maybeSingle());
    const name = ord?.order_name || `#${orderId}`;
    const date = (refund.processed_at || refund.created_at || new Date().toISOString()).slice(0, 10);
    const notes: string[] = [];
    let restocked = 0, released = 0, bikesRefunded = 0, partsAud = 0;
    for (const rli of refund.refund_line_items || []) {
      const li = rli.line_item || {}, qty = Number(rli.quantity) || 0;
      if (qty <= 0) continue;
      const m = await matchLine(li);
      if (m.part) {
        partsAud += Number(rli.subtotal) || (Number(li.price) || 0) * qty;
        if (["return", "cancel", "legacy_restock"].includes(rli.restock_type)) {
          must(await db.from("al_stock_movements").insert({ part_id: m.part, qty, kind: "returned", dealer_id: ord?.dealer_id ?? null, customer_id: ord?.customer_id ?? null, unit_price_aud: Number(li.price) || null, reference: `Refund Shopify ${name}`, moved_at: date, paid_date: date }));
          restocked += qty;
        } else notes.push(`${qty}x ${li.title || "part"} refunded without restock`);
        continue;
      }
      if (m.model) {
        bikesRefunded += qty;
        for (let i = 0; i < qty; i++) {
          // Pre-order for this order still open? Refund it and free its bike (if not handed over yet).
          const pre = must(await db.from("al_preorders").select("id,bike_id,status").eq("shopify_order", name).eq("model_id", m.model).in("status", ["allocated", "deposit_paid", "enquiry"]).order("id").limit(1));
          let bikeId: number | null = pre[0]?.bike_id ?? null;
          if (pre.length) must(await db.from("al_preorders").update({ status: "refunded", notes: `Refunded in Shopify ${date}` }).eq("id", pre[0].id));
          if (!bikeId) {
            const b = must(await db.from("al_bikes").select("id").eq("model_id", m.model).eq("status", "reserved").like("notes", `Reserved by Shopify ${name} %`).order("id").limit(1));
            bikeId = b[0]?.id ?? null;
          }
          if (bikeId) {
            const b = must(await db.from("al_bikes").select("id,status,notes").eq("id", bikeId).single());
            if (b.status === "reserved") {
              const was = /\(was (pdi_done|in_stock|in_transit)\)/.exec(b.notes || "")?.[1] || "in_stock";
              must(await db.from("al_bikes").update({ status: was, customer_id: null, dealer_id: null, sale_price_aud: null, paid_date: null, notes: `Released: Shopify ${name} refunded ${date}` }).eq("id", bikeId));
              released++;
            } else notes.push(`Bike ${bikeId} was already ${b.status}: refunded in Shopify, check it by hand`);
          } else if (!pre.length) notes.push(`${li.title || "Bike"} refunded but no reserved bike or pre-order found`);
        }
        continue;
      }
      notes.push(`${qty}x ${li.title || "item"} refunded (not in dashboard)`);
    }
    must(await db.from("al_shopify_refunds").update({ parts_restocked: restocked, bikes_released: released, notes }).eq("refund_id", refundId));
    if (ord) {
      const refunded = Math.round(((Number(ord.refunded_aud) || 0) + amount) * 100) / 100;
      must(await db.from("al_shopify_orders").update({
        refunded_aud: refunded, refund_status: refunded >= (Number(ord.total_aud) || 0) - 0.005 ? "refunded" : "partial",
        bikes_refunded: (Number(ord.bikes_refunded) || 0) + bikesRefunded,
        parts_aud: Math.max(0, Math.round(((Number(ord.parts_aud) || 0) - partsAud) * 100) / 100),
        refund_notes: [...(ord.refund_notes || []), ...notes],
      }).eq("shopify_order_id", orderId));
    }
    return new Response("ok");
  } catch (e) {
    await db.from("al_shopify_refunds").delete().eq("refund_id", refundId);
    console.error(e);
    return new Response("error", { status: 500 });
  }
}

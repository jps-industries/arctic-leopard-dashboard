// Push dashboard stock to Shopify (staff only, called from the dashboard).
// Parts: Shopify "available" = on hand in al_part_stock. Bikes: Shopify "available" = bikes of that model
// in stock or PDI done that aren't reserved for anyone. Matched by the variant ids stored with each part / model.
// Also registers the Shopify "orders/paid" webhook for al-shopify-order when asked.
// Secrets (Shopify Dev Dashboard app installed on the store, scopes read_products, read_inventory,
// write_inventory, read_locations, read_orders):
//   AL_SHOPIFY_SHOP           xr02jp-6s.myshopify.com
//   AL_SHOPIFY_CLIENT_ID      the app's Client ID
//   AL_SHOPIFY_CLIENT_SECRET  the app's Client secret
import { createClient } from "npm:@supabase/supabase-js@2.116.0";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const db = createClient(URL_, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const SHOP = Deno.env.get("AL_SHOPIFY_SHOP") ?? "";
const CID = Deno.env.get("AL_SHOPIFY_CLIENT_ID") ?? "";
const CSECRET = Deno.env.get("AL_SHOPIFY_CLIENT_SECRET") ?? "";
const API = "2026-01";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-client-info" };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, "content-type": "application/json" } });

async function token(): Promise<string> {
  const r = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: CID, client_secret: CSECRET }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`Shopify sign-in failed (${r.status}). Check the app is installed and the Client ID/secret are right.`);
  return j.access_token;
}

async function gql(tok: string, query: string, variables: Record<string, unknown> = {}) {
  const r = await fetch(`https://${SHOP}/admin/api/${API}/graphql.json`, {
    method: "POST", headers: { "content-type": "application/json", "X-Shopify-Access-Token": tok }, body: JSON.stringify({ query, variables }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.errors) throw new Error("Shopify: " + JSON.stringify(j.errors || r.status).slice(0, 300));
  return j.data;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  // Staff check with the caller's own login.
  const auth = req.headers.get("authorization") ?? "";
  const user = createClient(URL_, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const staff = await user.rpc("al_is_staff");
  if (staff.error || staff.data !== true) return json({ error: "Staff login needed" }, 403);
  if (!SHOP || !CID || !CSECRET) return json({ error: "Shopify isn't connected yet (secrets AL_SHOPIFY_SHOP, AL_SHOPIFY_CLIENT_ID, AL_SHOPIFY_CLIENT_SECRET)." }, 400);

  const body = await req.json().catch(() => ({}));
  try {
    const tok = await token();
    const out: Record<string, unknown> = {};

    if (body.register_webhook) {
      const uri = `${URL_}/functions/v1/al-shopify-order`;
      const have = await gql(tok, `{ webhookSubscriptions(first: 50, topics: [ORDERS_PAID]) { nodes { id uri } } }`);
      if (!have.webhookSubscriptions.nodes.some((n: { uri: string }) => n.uri === uri)) {
        const r = await gql(tok, `mutation($u: String!) { webhookSubscriptionCreate(topic: ORDERS_PAID, webhookSubscription: { uri: $u, format: JSON }) { userErrors { message } } }`, { u: uri });
        const e = r.webhookSubscriptionCreate.userErrors; if (e.length) throw new Error("Webhook: " + e.map((x: { message: string }) => x.message).join("; "));
        out.webhook = "created";
      } else out.webhook = "already set up";
    }

    // What to push: everything, or just the given parts / models.
    const partIds: number[] | null = Array.isArray(body.part_ids) ? body.part_ids.map(Number) : null;
    const modelIds: number[] | null = Array.isArray(body.model_ids) ? body.model_ids.map(Number) : null;
    const want: { variant: string; qty: number }[] = [];

    if (body.all || partIds) {
      let q = db.from("al_parts").select("id,shopify_variant_id").not("shopify_variant_id", "is", null);
      if (partIds) q = q.in("id", partIds);
      const { data: parts, error } = await q; if (error) throw error;
      const { data: stock, error: e2 } = await db.from("al_part_stock").select("id,on_hand").in("id", parts!.map((p) => p.id)); if (e2) throw e2;
      const oh = new Map(stock!.map((s) => [s.id, Math.max(0, Number(s.on_hand) || 0)]));
      for (const p of parts!) want.push({ variant: p.shopify_variant_id, qty: oh.get(p.id) ?? 0 });
    }
    if (body.all || modelIds) {
      let q = db.from("al_models").select("id,shopify_variant_id").not("shopify_variant_id", "is", null);
      if (modelIds) q = q.in("id", modelIds);
      const { data: models, error } = await q; if (error) throw error;
      for (const m of models!) {
        const { count, error: e3 } = await db.from("al_bikes").select("id", { count: "exact", head: true }).eq("model_id", m.id).in("status", ["in_stock", "pdi_done"]).is("customer_id", null).is("dealer_id", null);
        if (e3) throw e3;
        want.push({ variant: m.shopify_variant_id, qty: count ?? 0 });
      }
    }

    if (want.length) {
      const loc = await gql(tok, `{ locations(first: 5) { nodes { id isActive } } }`);
      const location = loc.locations.nodes.find((l: { isActive: boolean }) => l.isActive)?.id;
      if (!location) throw new Error("No active Shopify location");
      let set = 0;
      for (let i = 0; i < want.length; i += 100) {
        const chunk = want.slice(i, i + 100);
        const v = await gql(tok, `query($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id inventoryItem { id tracked } } } }`, { ids: chunk.map((w) => `gid://shopify/ProductVariant/${w.variant}`) });
        const item = new Map((v.nodes || []).filter(Boolean).map((n: { id: string; inventoryItem: { id: string; tracked: boolean } }) => [n.id.split("/").pop(), n.inventoryItem]));
        const quantities = chunk.filter((w) => (item.get(w.variant) as { tracked?: boolean } | undefined)?.tracked)
          .map((w) => ({ inventoryItemId: (item.get(w.variant) as { id: string }).id, locationId: location, quantity: w.qty, changeFromQuantity: null }));
        if (!quantities.length) continue;
        const r = await gql(tok, `mutation($input: InventorySetQuantitiesInput!) { inventorySetQuantities(input: $input) @idempotent(key: "${crypto.randomUUID()}") { userErrors { message } } }`,
          { input: { name: "available", reason: "correction", referenceDocumentUri: "logistics://arctic-leopard-dashboard/stock", quantities } });
        const e = r.inventorySetQuantities.userErrors; if (e.length) throw new Error("Stock: " + e.map((x: { message: string }) => x.message).join("; "));
        set += quantities.length;
      }
      out.updated = set;
    }
    return json({ ok: true, ...out });
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message || "Shopify sync failed" }, 502);
  }
});

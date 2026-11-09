// Public warranty claim form -> Arctic Leopard dashboard (claim status New, source web_form).
// Called from claim.html (multipart/form-data). No login: validated, size-limited, honeypot for bots.
// Emails: posted to a Zapier hook (URL + key in the private al_settings table), which sends the customer a
// confirmation and the team an alert from the Arctic Leopard Gmail. No hook set = no emails, the claim still saves.
import { createClient } from "npm:@supabase/supabase-js@2.116.0";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const BUCKET = "al-warranty";
const MAX_FILES = 10, MAX_FILE = 25 * 1024 * 1024, MAX_TOTAL = 80 * 1024 * 1024;
const ALLOWED = /^(image\/|video\/|application\/pdf$)/;
const CATS = ["motor","battery","controller","charger","suspension","brakes","frame","electrical","drivetrain","plastics","other"];
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-client-info" };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, "content-type": "application/json" } });
const like = (v: string) => v.replace(/[\\%_]/g, (c) => "\\" + c);
const TEAM = "contact@arcticleopardaustralia.com";
const DASH = "https://jps-industries.github.io/arctic-leopard-dashboard/";
const h = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
async function sendMails(payload: Record<string, string>) {
  try {
    const r = await db.from("al_settings").select("key,value").in("key", ["zapier_claim_hook", "zapier_claim_key"]);
    const cfg = Object.fromEntries((r.data || []).map((x) => [x.key, x.value]));
    if (!cfg.zapier_claim_hook) return;
    const res = await fetch(cfg.zapier_claim_hook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: cfg.zapier_claim_key || "", ...payload }) });
    if (!res.ok) console.error("email hook", res.status, (await res.text()).slice(0, 300));
  } catch (e) { console.error("email hook", e); }
}
const clip = (v: FormDataEntryValue | null, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : "") || null;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let f: FormData;
  try { f = await req.formData(); } catch { return json({ error: "Couldn't read the form" }, 400); }
  if (clip(f.get("website"), 200)) return json({ ok: true, claim_no: "W-0000" }); // honeypot: bots fill hidden fields

  const name = clip(f.get("name"), 120), email = clip(f.get("email"), 160)?.toLowerCase() ?? null, phone = clip(f.get("phone"), 40);
  const frame = clip(f.get("frame_no"), 60), problem = clip(f.get("problem"), 4000);
  const modelName = clip(f.get("model"), 60), hoursKm = clip(f.get("hours_km"), 40), purchase = clip(f.get("purchase_date"), 10);
  const invoiceNo = clip(f.get("invoice_no"), 60), boughtFrom = clip(f.get("purchased_from"), 120), cat = clip(f.get("category"), 20);
  const addr = { address: clip(f.get("address"), 200), suburb: clip(f.get("suburb"), 80), state: clip(f.get("state"), 3), postcode: clip(f.get("postcode"), 8) };
  if (!name || !email || !phone || !frame || !problem) return json({ error: "Please fill in your name, email, phone, frame number and the problem." }, 400);
  if (!addr.address || !addr.suburb || !addr.state || !addr.postcode) return json({ error: "Please fill in your full address so we can send parts if needed." }, 400);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "That email address doesn't look right." }, 400);
  if (!modelName || !hoursKm || !cat) return json({ error: "Please fill in your model, hours or km ridden and the problem area." }, 400);
  if (!purchase || !/^\d{4}-\d{2}-\d{2}$/.test(purchase) || !invoiceNo || !boughtFrom) return json({ error: "Please fill in your purchase date, invoice or receipt number and where you bought the bike." }, 400);
  if (f.get("consent") !== "yes") return json({ error: "Please tick the box to confirm the details are correct." }, 400);

  const proof = f.getAll("proof").filter((x): x is File => x instanceof File && x.size > 0);
  const files = f.getAll("files").filter((x): x is File => x instanceof File && x.size > 0);
  if (!proof.length) return json({ error: "Please attach your invoice or receipt." }, 400);
  if (proof.length > 3) return json({ error: "Please attach 3 proof of purchase files or fewer." }, 400);
  if (!files.length) return json({ error: "Please attach at least one photo or video of the problem." }, 400);
  if (files.length > MAX_FILES) return json({ error: `Please attach ${MAX_FILES} files or fewer.` }, 400);
  let total = 0;
  for (const file of [...proof, ...files]) {
    total += file.size;
    if (file.size > MAX_FILE) return json({ error: `${file.name} is over 25 MB.` }, 400);
    if (!ALLOWED.test(file.type)) return json({ error: `${file.name} isn't a photo, video or PDF.` }, 400);
  }
  if (total > MAX_TOTAL) return json({ error: "Attachments are over 80 MB in total. Please send fewer or smaller files." }, 400);

  try {
    // Customer: match by email, else create.
    let customerId: number;
    const c = await db.from("al_customers").select("id").ilike("email", like(email)).limit(1);
    if (c.error) throw c.error;
    if (c.data.length) {
      customerId = c.data[0].id;
      // Fill in details we don't have yet. Never overwrite from a public form (the claim keeps the address given).
      const cur = await db.from("al_customers").select("phone,address,suburb,state,postcode").eq("id", customerId).single();
      if (cur.error) throw cur.error;
      const fill: Record<string, string> = {};
      for (const [k, v] of Object.entries({ phone, ...addr })) if (v && !(cur.data as Record<string, unknown>)[k]) fill[k] = v;
      if (Object.keys(fill).length) { const upd = await db.from("al_customers").update(fill).eq("id", customerId); if (upd.error) throw upd.error; }
    } else {
      const ins = await db.from("al_customers").insert({ full_name: name, email, phone, ...addr, notes: "Created from the website warranty form" }).select("id").single();
      if (ins.error) throw ins.error;
      customerId = ins.data.id;
    }
    // Bike: match the frame number if we know it.
    const b = await db.from("al_bikes").select("id,dealer_id,sold_date").ilike("frame_no", like(frame)).limit(1);
    if (b.error) throw b.error;
    const bike = b.data[0];
    const m = modelName ? await db.from("al_models").select("id").ilike("name", like(modelName)).limit(1) : { data: [] as { id: number }[] };
    const claim = await db.from("al_warranty_claims").insert({
      source: "web_form", status: "new", model_id: m.data?.[0]?.id ?? null, customer_id: customerId, bike_id: bike?.id ?? null, dealer_id: bike?.dealer_id ?? null,
      purchase_date: purchase, invoice_no: invoiceNo,
      hours_km: hoursKm, category: cat && CATS.includes(cat) ? cat : null, problem,
      reported_frame_no: frame, reported_model: modelName, purchased_from: boughtFrom,
      ship_address: `${addr.address}, ${addr.suburb} ${addr.state} ${addr.postcode}`,
    }).select("id,claim_no").single();
    if (claim.error) throw claim.error;

    let n = 0;
    for (const [file, caption, tag] of [...proof.map((x) => [x, "Proof of purchase", "proof"] as const), ...files.map((x) => [x, "Photo or video from customer", "web"] as const)]) {
      const path = `${claim.data.claim_no}/${tag}-${Date.now()}-${n++}-${file.name.replace(/[^\w.\-]+/g, "_").slice(-80)}`;
      const up = await db.storage.from(BUCKET).upload(path, file, { contentType: file.type });
      if (up.error) { console.error(up.error); continue; }
      await db.from("al_warranty_media").insert({ claim_id: claim.data.id, storage_path: path, caption });
    }
    const no = claim.data.claim_no;
    const rows: [string, unknown][] = [["Claim number", no], ["Name", name], ["Phone", phone], ["Email", email], ["Address", `${addr.address}, ${addr.suburb} ${addr.state} ${addr.postcode}`],
      ["Model", modelName], ["Frame (VIN) number", frame], ["Hours or km", hoursKm], ["Purchase date", purchase], ["Invoice or receipt no.", invoiceNo], ["Bought from", boughtFrom],
      ["Problem", problem], ["Files", `${proof.length} proof of purchase, ${files.length} photo/video`]];
    const table = `<table style="border-collapse:collapse;font:14px/1.5 Arial,sans-serif">${rows.map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#666;vertical-align:top;white-space:nowrap">${h(k)}</td><td style="padding:4px 0;white-space:pre-wrap">${h(v)}</td></tr>`).join("")}</table>`;
    const wrap = (body: string) => `<div style="font:15px/1.5 Arial,sans-serif;color:#111;max-width:600px">${body}</div>`;
    await sendMails({
      claim_no: no, email,
      customer_subject: `Warranty claim ${no} received`,
      customer_html: wrap(`<p>Hi ${h(name.split(" ")[0])},</p><p>Thanks, we've received your warranty claim. Your claim number is <b>${h(no)}</b>. We'll review it and get back to you.</p><p>Keep your bike stored safely and don't ride it if it isn't safe to. If you need to add anything, just reply to this email and quote your claim number.</p>${table}<p style="margin-top:20px">The Arctic Leopard Australia Team<br>0457 416 969 · ${TEAM}</p>`),
      team_subject: `New warranty claim ${no}: ${modelName} · ${name}`,
      team_html: wrap(`<p>A new warranty claim came in from the website.</p>${table}<p><a href="${DASH}">Open the dashboard</a> (Warranty tab) to see the proof of purchase, photos and video.</p>`),
    });
    return json({ ok: true, claim_no: no });
  } catch (e) {
    console.error(e);
    return json({ error: "Something went wrong saving your claim. Please try again or email us." }, 500);
  }
});

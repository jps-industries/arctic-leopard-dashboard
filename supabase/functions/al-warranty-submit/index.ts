// Public warranty claim form -> Arctic Leopard dashboard (claim status New, source web_form).
// Called from claim.html (multipart/form-data). No login: validated, size-limited, honeypot for bots.
import { createClient } from "npm:@supabase/supabase-js@2.116.0";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const BUCKET = "al-warranty";
const MAX_FILES = 10, MAX_FILE = 25 * 1024 * 1024, MAX_TOTAL = 80 * 1024 * 1024;
const ALLOWED = /^(image\/|video\/|application\/pdf$)/;
const CATS = ["motor","battery","controller","charger","suspension","brakes","frame","electrical","drivetrain","plastics","other"];
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-client-info" };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, "content-type": "application/json" } });
const like = (v: string) => v.replace(/[\\%_]/g, (c) => "\\" + c);
const clip = (v: FormDataEntryValue | null, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : "") || null;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let f: FormData;
  try { f = await req.formData(); } catch { return json({ error: "Couldn't read the form" }, 400); }
  if (clip(f.get("website"), 200)) return json({ ok: true, claim_no: "W-0000" }); // honeypot: bots fill hidden fields

  const name = clip(f.get("name"), 120), email = clip(f.get("email"), 160)?.toLowerCase() ?? null, phone = clip(f.get("phone"), 40);
  const frame = clip(f.get("frame_no"), 60), problem = clip(f.get("problem"), 4000);
  if (!name || !email || !phone || !frame || !problem) return json({ error: "Please fill in your name, email, phone, frame number and the problem." }, 400);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "That email address doesn't look right." }, 400);
  if (f.get("consent") !== "yes") return json({ error: "Please tick the box to confirm the details are correct." }, 400);

  const files = f.getAll("files").filter((x): x is File => x instanceof File && x.size > 0);
  if (files.length > MAX_FILES) return json({ error: `Please attach ${MAX_FILES} files or fewer.` }, 400);
  let total = 0;
  for (const file of files) {
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
    if (c.data.length) customerId = c.data[0].id;
    else {
      const ins = await db.from("al_customers").insert({ full_name: name, email, phone, suburb: clip(f.get("suburb"), 80), state: clip(f.get("state"), 3), postcode: clip(f.get("postcode"), 8), notes: "Created from the website warranty form" }).select("id").single();
      if (ins.error) throw ins.error;
      customerId = ins.data.id;
    }
    // Bike: match the frame number if we know it.
    const b = await db.from("al_bikes").select("id,dealer_id,sold_date").ilike("frame_no", like(frame)).limit(1);
    if (b.error) throw b.error;
    const bike = b.data[0];
    const modelName = clip(f.get("model"), 60);
    const m = modelName ? await db.from("al_models").select("id").ilike("name", like(modelName)).limit(1) : { data: [] as { id: number }[] };
    const cat = clip(f.get("category"), 20);
    const purchase = clip(f.get("purchase_date"), 10);
    const claim = await db.from("al_warranty_claims").insert({
      source: "web_form", status: "new", model_id: m.data?.[0]?.id ?? null, customer_id: customerId, bike_id: bike?.id ?? null, dealer_id: bike?.dealer_id ?? null,
      purchase_date: purchase && /^\d{4}-\d{2}-\d{2}$/.test(purchase) ? purchase : bike?.sold_date ?? null,
      hours_km: clip(f.get("hours_km"), 40), category: cat && CATS.includes(cat) ? cat : null, problem,
      reported_frame_no: frame, reported_model: clip(f.get("model"), 60), purchased_from: clip(f.get("purchased_from"), 120),
    }).select("id,claim_no").single();
    if (claim.error) throw claim.error;

    let n = 0;
    for (const file of files) {
      const path = `${claim.data.claim_no}/web-${Date.now()}-${n++}-${file.name.replace(/[^\w.\-]+/g, "_").slice(-80)}`;
      const up = await db.storage.from(BUCKET).upload(path, file, { contentType: file.type });
      if (up.error) { console.error(up.error); continue; }
      await db.from("al_warranty_media").insert({ claim_id: claim.data.id, storage_path: path, caption: "Uploaded by customer" });
    }
    return json({ ok: true, claim_no: claim.data.claim_no });
  } catch (e) {
    console.error(e);
    return json({ error: "Something went wrong saving your claim. Please try again or email us." }, 500);
  }
});

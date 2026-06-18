// kean-tip — receives a tip from the "Where is Tom Kean?" bulletin
// (whereistomkean.org), stores it, optionally stashes an attachment, and sends
// a confirmation receipt to the tipster via Resend.
//
// This is the static-site analogue of the Donor Strike's `submitSignup` server
// function: whereistomkean.org is a single static index.html with only the
// public anon key, so every secret (service role, Resend key, Turnstile secret)
// lives HERE in the edge function, never in the page.
//
// Public (verify_jwt:false): called by the page's tip form. Abuse is gated by
// Cloudflare Turnstile (verified server-side below) plus a honeypot/timing
// layer on the client. Because we email the address that was just submitted,
// Turnstile is the primary defense against using this as a bulk relay.
//
// Request: multipart/form-data
//   email                  (required)
//   zip                    (required — 5-digit US ZIP; geocoded for the map)
//   cf-turnstile-response   (required — Turnstile token)
//   website                (honeypot — must be empty)
//   file                   (optional — image/PDF, <= 2 MB)
//
// A valid ZIP is geocoded server-side (zip_geo cache → Zippopotam → cache
// write, the same path the Donor Strike uses) and the resulting ZIP-centroid
// point is written to the public `kean_tip_map` table that feeds the homepage
// map. The private `kean_tips` row keeps the full record.
//
// Email copy/design lives entirely in Resend as the published template
// `tom-kean-tip`. We send by template reference — `template: { id, variables }`
// — and omit from/subject/html so every send inherits the LATEST published
// version (edit + Publish in Resend, no redeploy).
//
// Template variables (Resend → tom-kean-tip):
//   LOCATION — the town/ZIP the tipster reported. May be empty; give it a
//              Resend fallback (e.g. "an undisclosed location") if your copy
//              references it.
//
// Required project secrets (Supabase → Edge Functions → Secrets):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  — injected automatically
//   RESEND_API_KEY                           — already set (shared w/ strike-welcome)
//   KEAN_TURNSTILE_SECRET                    — the SECRET for the whereistomkean.org
//                                              Turnstile widget (NOT the donor-strike one).
//                                              If this env var is unset, the secret is
//                                              read from Supabase Vault via the
//                                              kean_turnstile_secret() RPC instead.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;

// Turnstile secret: prefer the KEAN_TURNSTILE_SECRET env var; otherwise fall
// back to Supabase Vault via the kean_turnstile_secret() RPC (set there because
// edge-function env secrets can't always be provisioned through tooling). The
// resolved value is cached for the lifetime of the warm instance.
let cachedTurnstileSecret: string | null = null;
async function resolveTurnstileSecret(admin: SupabaseClient): Promise<string> {
  const env = Deno.env.get("KEAN_TURNSTILE_SECRET");
  if (env) return env;
  if (cachedTurnstileSecret) return cachedTurnstileSecret;
  const { data, error } = await admin.rpc("kean_turnstile_secret");
  if (error || typeof data !== "string" || !data) {
    console.error("kean-tip: could not resolve Turnstile secret from vault", error?.message);
    return "";
  }
  cachedTurnstileSecret = data;
  return cachedTurnstileSecret;
}

const RESEND_TEMPLATE = "tom-kean-tip";
const BUCKET = "kean-tips";
const MAX_BYTES = 2 * 1024 * 1024; // 2 MiB
const ALLOWED_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
]);
const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "application/pdf": "pdf",
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const emailOk = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

// Strip ASCII control chars (CR/LF/TAB/NUL/DEL etc.); keep all printable input.
const sanitize = (v: unknown, max: number) =>
  String(v ?? "")
    .replace(/[\x00-\x1F\x7F]/g, " ")
    .trim()
    .slice(0, max);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method-not-allowed" }, 405);

  try {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return json({ error: "bad-request" }, 400);
    }

    // Honeypot: real users never fill this hidden field. Pretend success so a
    // scraper learns nothing about why it was dropped.
    if (sanitize(form.get("website"), 200) !== "") {
      return json({ ok: true });
    }

    const email = sanitize(form.get("email"), 254).toLowerCase();
    if (!emailOk(email)) return json({ error: "invalid-email" }, 400);
    // ZIP is required. Keep digits only, first 5; reject if not a full 5-digit
    // ZIP. (A valid-format ZIP that fails to geocode is still accepted — we
    // don't punish the user for an upstream lookup hiccup, it just gets no pin.)
    const zip = sanitize(form.get("zip"), 10).replace(/[^0-9]/g, "").slice(0, 5);
    if (zip.length !== 5) return json({ error: "zip-required" }, 400);

    // Caller IP (used for Turnstile remoteip + audit trail).
    const ip =
      req.headers.get("cf-connecting-ip") ??
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      null;
    const userAgent = sanitize(req.headers.get("user-agent"), 400) || null;

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
      auth: { persistSession: false },
    });

    // Verify Turnstile. Fail closed if no secret can be resolved (env or vault).
    const turnstileSecret = await resolveTurnstileSecret(admin);
    if (!turnstileSecret) {
      console.error("kean-tip: Turnstile secret not configured (env or vault)");
      return json({ error: "turnstile-misconfigured" }, 500);
    }
    const token = sanitize(form.get("cf-turnstile-response"), 4096);
    if (!token) return json({ error: "turnstile" }, 400);
    if (!(await verifyTurnstile(token, ip, turnstileSecret))) {
      return json({ error: "turnstile" }, 400);
    }

    // Optional attachment.
    let attachment:
      | { path: string; name: string; type: string; size: number }
      | null = null;
    const file = form.get("file");
    if (file instanceof File && file.size > 0) {
      if (file.size > MAX_BYTES) return json({ error: "file-too-large" }, 400);
      const type = (file.type || "").toLowerCase();
      if (!ALLOWED_TYPES.has(type)) return json({ error: "file-type" }, 400);

      const bytes = new Uint8Array(await file.arrayBuffer());
      // Re-check after read (multipart can under-report size).
      if (bytes.byteLength > MAX_BYTES) return json({ error: "file-too-large" }, 400);

      const ext = EXT[type] ?? "bin";
      const path = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await admin.storage
        .from(BUCKET)
        .upload(path, bytes, { contentType: type, upsert: false });
      if (upErr) {
        // Don't fail the whole tip over an attachment hiccup — record it without.
        console.error("kean-tip: attachment upload failed", upErr.message);
      } else {
        attachment = {
          path,
          name: sanitize(file.name, 200) || `attachment.${ext}`,
          type,
          size: bytes.byteLength,
        };
      }
    }

    // Authoritative server-side geocode of the ZIP (client-supplied coords are
    // never trusted). Null when the lookup fails (still accepted, just no pin).
    const geo = zip ? await geocodeZip(admin, zip) : null;
    const placeLabel = geo ? [geo.city, geo.region].filter(Boolean).join(", ") : null;

    const { data: inserted, error: insErr } = await admin
      .from("kean_tips")
      .insert({
        email,
        location: placeLabel || (zip || null),
        zip: zip || null,
        city: geo?.city ?? null,
        region: geo?.region ?? null,
        lat: geo?.lat ?? null,
        lng: geo?.lng ?? null,
        attachment_path: attachment?.path ?? null,
        attachment_name: attachment?.name ?? null,
        attachment_type: attachment?.type ?? null,
        attachment_size: attachment?.size ?? null,
        ip,
        user_agent: userAgent,
      })
      .select("id")
      .single();

    if (insErr) {
      console.error("kean-tip: insert failed", insErr.message);
      return json({ error: "db" }, 500);
    }
    const tipId = (inserted as { id: number }).id;

    // Drop a public-safe point on the map (no email / tip id) when we have
    // coords. Best-effort: a map hiccup must not fail the tip. We return the
    // new row's id + created_at so the client can drop the pin optimistically
    // and de-dupe it against the poll.
    let mapPoint:
      | {
          id: number;
          lat: number;
          lng: number;
          city: string | null;
          region: string | null;
          created_at: string;
        }
      | null = null;
    if (geo && geo.lat != null && geo.lng != null) {
      const { data: mapRow, error: mapErr } = await admin
        .from("kean_tip_map")
        .insert({
          city: geo.city,
          region: geo.region,
          country: geo.country,
          lat: geo.lat,
          lng: geo.lng,
        })
        .select("id, created_at")
        .single();
      if (mapErr || !mapRow) {
        console.error("kean-tip: map insert failed", mapErr?.message);
      } else {
        const row = mapRow as { id: number; created_at: string };
        mapPoint = {
          id: row.id,
          lat: geo.lat,
          lng: geo.lng,
          city: geo.city,
          region: geo.region,
          created_at: row.created_at,
        };
      }
    }

    // Send the confirmation receipt. A delivery failure is logged but does not
    // fail the submission — the tip is already safely recorded.
    const delivery = await deliver(email, { LOCATION: placeLabel || zip || "" }, tipId);
    await admin
      .from("kean_tips")
      .update(
        delivery.delivered
          ? { confirmation_sent_at: new Date().toISOString(), confirmation_error: null }
          : { confirmation_error: String(delivery.reason ?? "unknown") },
      )
      .eq("id", tipId);

    return json({ ok: true, point: mapPoint });
  } catch (err) {
    console.error("kean-tip error", err);
    return json({ error: "server" }, 500);
  }
});

// ---------------- ZIP geocode ----------------
interface Geo {
  lat: number | null;
  lng: number | null;
  city: string | null;
  region: string | null;
  country: string | null;
}

const numOk = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

// ZIP → lat/lng. Reads the shared public.zip_geo cache first (built up across
// both sites), falls back to Zippopotam with a short timeout, and writes the
// result back to the cache. Mirrors the Donor Strike's lookupZipCached.
async function geocodeZip(admin: SupabaseClient, zip: string): Promise<Geo | null> {
  const z = zip.slice(0, 5);
  if (!/^\d{5}$/.test(z)) return null;

  try {
    const { data: hit } = await admin
      .from("zip_geo")
      .select("zip, lat, lng, city, region")
      .eq("zip", z)
      .maybeSingle();
    if (hit) {
      return {
        lat: numOk((hit as { lat: number }).lat),
        lng: numOk((hit as { lng: number }).lng),
        city: (hit as { city: string | null }).city ?? null,
        region: (hit as { region: string | null }).region ?? null,
        country: "United States",
      };
    }
  } catch {
    /* cache unavailable — fall through to upstream */
  }

  let up: Geo | null = null;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`https://api.zippopotam.us/us/${z}`, { signal: ctrl.signal });
    clearTimeout(to);
    if (res.ok) {
      const j = (await res.json()) as {
        country?: string;
        places?: Array<{
          latitude?: string;
          longitude?: string;
          "place name"?: string;
          state?: string;
        }>;
      };
      const place = j?.places?.[0];
      if (place) {
        const lat = numOk(parseFloat(place.latitude ?? ""));
        const lng = numOk(parseFloat(place.longitude ?? ""));
        if (lat != null && lng != null) {
          up = {
            lat,
            lng,
            city: place["place name"] ?? null,
            region: place.state ?? null,
            country: j.country ?? "United States",
          };
        }
      }
    }
  } catch {
    /* swallow — cache stays cold for this ZIP */
  }

  if (up) {
    try {
      await admin
        .from("zip_geo")
        .upsert(
          { zip: z, lat: up.lat, lng: up.lng, city: up.city, region: up.region },
          { onConflict: "zip" },
        );
    } catch {
      /* ignore */
    }
  }
  return up;
}

// ---------------- Turnstile ----------------
async function verifyTurnstile(token: string, ip: string | null, secret: string): Promise<boolean> {
  try {
    const body = new URLSearchParams();
    body.set("secret", secret);
    body.set("response", token);
    if (ip) body.set("remoteip", ip);
    const res = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      { method: "POST", body },
    );
    const out = (await res.json().catch(() => ({}))) as { success?: boolean };
    return out.success === true;
  } catch (err) {
    console.error("kean-tip turnstile exception", err);
    return false;
  }
}

// ---------------- delivery ----------------
interface SendResult {
  delivered: boolean;
  reason?: string;
  resend_id?: string;
}

/** One transactional Resend send using the published `kean-tip` template. */
async function deliver(
  to: string,
  variables: Record<string, string>,
  tipId: number,
): Promise<SendResult> {
  if (!RESEND_API_KEY) {
    console.error("kean-tip: RESEND_API_KEY not configured");
    return { delivered: false, reason: "email-misconfigured" };
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `kean-tip-${tipId}`,
      },
      // No from/subject/html: inherit the latest published template defaults.
      body: JSON.stringify({ to: [to], template: { id: RESEND_TEMPLATE, variables } }),
    });
    const out = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
    if (res.ok && out.id) return { delivered: true, resend_id: out.id };
    console.error("kean-tip resend error", res.status, JSON.stringify(out));
    return { delivered: false, reason: out.message ?? `http_${res.status}` };
  } catch (err) {
    console.error("kean-tip resend exception", err);
    return { delivered: false, reason: String((err as { message?: string })?.message ?? err) };
  }
}

// ---------------- helpers ----------------
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

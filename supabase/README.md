# Tip line backend

The "If You Have Information" tip line on the bulletin collects a tip (email +
optional location + optional ≤2 MB attachment) and emails the tipster a
confirmation. Because the site is a single static `index.html` with only the
public anon key, **all secrets live in the `kean-tip` edge function**, never in
the page — the same model the Donor Strike uses for signups.

```
index.html (tip form)
   │  POST multipart/form-data  (email, location, file, cf-turnstile-response)
   ▼
kean-tip  edge function  (verify_jwt: false)
   ├─ verify Cloudflare Turnstile        (KEAN_TURNSTILE_SECRET)
   ├─ upload attachment → storage bucket `kean-tips` (private, service role)
   ├─ insert row        → table  `public.kean_tips`  (service role)
   └─ send receipt      → Resend template `kean-tip` (RESEND_API_KEY)
```

## Files

- `migrations/20260618_kean_tips.sql` — `kean_tips` table (service-role-only,
  RLS on, no policies) + private `kean-tips` storage bucket (2 MB cap, image/PDF
  allow-list).
- `functions/kean-tip/index.ts` — the edge function.

Both are already deployed to the **Integrity Index** project
(`qjsesvdduoriofiodumm`), shared with the Donor Strike and Integrity Index apps.

## Remaining setup (one-time, before launch)

1. **Resend template** — create and **Publish** a template with alias
   `kean-tip` in the Resend dashboard. Declare one variable, `LOCATION`
   (Text), and give it a fallback (e.g. "an undisclosed location") since it can
   be empty. The function sends by reference and omits from/subject/html, so
   the latest published version is always used — no redeploy to change copy.

2. **Cloudflare Turnstile** — create a Turnstile widget whose domain list
   includes `whereistomkean.org` (do **not** reuse the donor-strike widget).
   - Paste the **site key** into `TURNSTILE_SITE_KEY` in `index.html`.
   - Set the **secret key** in Supabase → Edge Functions → Secrets as
     `KEAN_TURNSTILE_SECRET`.

3. **RESEND_API_KEY** — already present in the project (shared with
   `strike-welcome`). No action unless it's rotated.

Until steps 1–2 are done the form renders but submission is blocked client-side
(missing site key) and would be rejected server-side (missing secret / template).

## Where tips land

- Rows: `public.kean_tips` (read with the service role / SQL editor).
- Attachments: private `kean-tips` storage bucket, path stored in
  `kean_tips.attachment_path`. `confirmation_sent_at` / `confirmation_error`
  record receipt delivery.

## Redeploy

Schema: re-run `migrations/20260618_kean_tips.sql` (idempotent). Function:
redeploy `functions/kean-tip/index.ts` via the Supabase CLI or dashboard.

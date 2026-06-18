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
- `migrations/20260618_kean_turnstile_secret_rpc.sql` — `kean_turnstile_secret()`
  RPC (service-role-only) that reads the Turnstile secret from Supabase Vault.
- `functions/kean-tip/index.ts` — the edge function.

All are already deployed to the **Integrity Index** project
(`qjsesvdduoriofiodumm`), shared with the Donor Strike and Integrity Index apps.

## Setup status

- ✅ **Cloudflare Turnstile** — widget for `whereistomkean.org` is wired:
  - site key is set in `TURNSTILE_SITE_KEY` in `index.html`;
  - secret is stored in **Supabase Vault** (`kean_turnstile_secret`) and read by
    the function via the `kean_turnstile_secret()` RPC. Setting a
    `KEAN_TURNSTILE_SECRET` env secret would override the Vault path.
  - Verified live: a bogus token is rejected with `{"error":"turnstile"}` (400).
- ✅ **RESEND_API_KEY** — already present (shared with `strike-welcome`).
- ⏳ **Resend template** — still TODO: create and **Publish** a template with
  alias `kean-tip`. Declare one variable, `LOCATION` (Text), with a fallback
  (e.g. "an undisclosed location") since it can be empty. The function sends by
  reference and omits from/subject/html, so the latest published version is
  always used — no redeploy to change copy.

Until the Resend template exists, tips are still **stored** correctly; only the
confirmation email fails, and the failure is recorded in
`kean_tips.confirmation_error` (the user-facing submit still succeeds).

### Rotating the Turnstile secret

Since the secret was provisioned via Vault, rotate with:

```sql
select vault.update_secret(
  (select id from vault.secrets where name = 'kean_turnstile_secret'),
  '<new secret>', 'kean_turnstile_secret');
```

(or set a `KEAN_TURNSTILE_SECRET` env secret, which takes precedence). Generate
the matching new secret in the Cloudflare Turnstile dashboard.

## Where tips land

- Rows: `public.kean_tips` (read with the service role / SQL editor).
- Attachments: private `kean-tips` storage bucket, path stored in
  `kean_tips.attachment_path`. `confirmation_sent_at` / `confirmation_error`
  record receipt delivery.

## Redeploy

Schema: re-run `migrations/20260618_kean_tips.sql` (idempotent). Function:
redeploy `functions/kean-tip/index.ts` via the Supabase CLI or dashboard.

-- "Where is Tom Kean?" tip line.
-- Stores tips submitted from the public bulletin (whereistomkean.org) and the
-- attachment metadata. Apply against the Integrity Index Supabase project
-- (qjsesvdduoriofiodumm) in the SQL Editor. Idempotent — safe to re-run.
--
-- Mirrors the Donor Strike collection model: writes happen ONLY through the
-- `kean-tip` edge function using the service role, so this table (and the
-- attachment bucket) are completely closed to anon/authenticated.

-- ----------------------------------------------------------------------------
-- 1. Tips table.
-- ----------------------------------------------------------------------------
create table if not exists public.kean_tips (
  id                   bigserial primary key,
  email                text not null,
  location             text,
  attachment_path      text,        -- object path inside the `kean-tips` bucket
  attachment_name      text,        -- original client filename (sanitized)
  attachment_type      text,        -- stored MIME type
  attachment_size      integer,     -- bytes
  confirmation_sent_at timestamptz, -- stamped once the Resend receipt is sent
  confirmation_error   text,        -- last delivery error, if any
  ip                   text,
  user_agent           text,
  created_at           timestamptz not null default now()
);

create index if not exists kean_tips_created_at_idx
  on public.kean_tips (created_at desc);

create index if not exists kean_tips_email_lower_idx
  on public.kean_tips (lower(email));

-- Service-role only. No anon/authenticated grants → PostgREST can't read or
-- write it with the public anon key the static page ships.
grant all on public.kean_tips to service_role;
grant usage, select on sequence public.kean_tips_id_seq to service_role;

alter table public.kean_tips enable row level security;
-- No policies → only the service role (used inside the edge function) touches it.

-- ----------------------------------------------------------------------------
-- 2. Private attachment bucket.
--    The edge function uploads here with the service role; nothing is public.
--    2 MB cap + image/PDF allow-list enforced at the storage layer as a second
--    line of defense behind the in-function checks.
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'kean-tips',
  'kean-tips',
  false,
  2097152, -- 2 MiB
  array['image/png','image/jpeg','image/webp','image/heic','image/heif','application/pdf']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- No storage RLS policies are added: the bucket is private and only the
-- service role (which bypasses storage RLS) reads/writes it.

-- Adds the map to the "Where is Tom Kean?" tip line.
-- Apply against the Integrity Index Supabase project (qjsesvdduoriofiodumm).
-- Idempotent — safe to re-run.

-- Geo columns on the (private) tips table.
alter table public.kean_tips
  add column if not exists zip    text,
  add column if not exists city   text,
  add column if not exists region text,
  add column if not exists lat    double precision,
  add column if not exists lng    double precision;

-- Public-safe map points, mirroring the Donor Strike's strike_map: the edge
-- function (service role) writes a row here for each geocoded tip; the static
-- page reads it with the anon key. No email / tip id / attachment — just the
-- ZIP-centroid location, so plotting it reveals nothing private.
create table if not exists public.kean_tip_map (
  id         bigserial primary key,
  city       text,
  region     text,
  country    text,
  lat        double precision,
  lng        double precision,
  created_at timestamptz not null default now()
);

create index if not exists kean_tip_map_created_at_idx
  on public.kean_tip_map (created_at desc);

grant select on public.kean_tip_map to anon, authenticated;
grant all    on public.kean_tip_map to service_role;
grant usage, select on sequence public.kean_tip_map_id_seq to service_role;

alter table public.kean_tip_map enable row level security;

drop policy if exists "kean_tip_map public read" on public.kean_tip_map;
create policy "kean_tip_map public read"
  on public.kean_tip_map for select
  using (true);
-- No insert/update/delete policies → only service_role can write.

-- NOTE: ZIP → lat/lng geocoding reuses the existing shared public.zip_geo
-- cache table (created by the Donor Strike's launch-hardening.sql). No new
-- table needed for that.

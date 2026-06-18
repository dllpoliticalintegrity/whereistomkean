-- Service-role-only reader for the whereistomkean.org Turnstile secret stored
-- in Supabase Vault. The `kean-tip` edge function calls this when the
-- KEAN_TURNSTILE_SECRET env var isn't set.
--
-- The secret VALUE is never stored here. Set it once (outside migration history,
-- so it isn't recorded as plaintext) with, e.g.:
--   select vault.create_secret('<turnstile secret>', 'kean_turnstile_secret',
--                              'Cloudflare Turnstile secret for whereistomkean.org tip line');
-- To rotate: vault.update_secret(<id>, '<new secret>', 'kean_turnstile_secret').
create or replace function public.kean_turnstile_secret()
returns text
language sql
security definer
set search_path = vault, public
as $$
  select decrypted_secret
    from vault.decrypted_secrets
   where name = 'kean_turnstile_secret'
   limit 1;
$$;

revoke all on function public.kean_turnstile_secret() from public, anon, authenticated;
grant execute on function public.kean_turnstile_secret() to service_role;

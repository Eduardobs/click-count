-- Secure the already-provisioned public counter without requiring user accounts.
-- Requests now pass through the public increment-counter Edge Function. Increment
-- frequency remains intentionally unrestricted.
begin;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- This helper was created by the original setup script. Keep implementation
-- details out of the Data API's exposed public schema.
alter function public.private_increment_decimal(text) set schema private;
revoke all on function private.private_increment_decimal(text) from public, anon, authenticated;

create or replace function public.increment_counter_backend()
returns table (new_value text, changed_at timestamptz)
language plpgsql
security definer
set search_path = ''
set statement_timeout = '2s'
as $$
declare
  request_time timestamptz := clock_timestamp();
begin
  return query
  update public.counters as counter
  set
    value = private.private_increment_decimal(counter.value),
    updated_at = request_time
  where counter.id = 'main'
  returning counter.value, counter.updated_at;
end;
$$;

revoke all on function public.increment_counter_backend() from public, anon, authenticated;
grant execute on function public.increment_counter_backend() to service_role;

-- Close the old browser-callable RPC before removing it.
revoke all on function public.increment_counter(text) from public, anon, authenticated;
drop function public.increment_counter(text);

-- New functions created by the migration owner should start closed by default.
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema private revoke execute on functions from public;

commit;

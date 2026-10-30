begin;

-- Freeze the original total as the baseline. The lock also waits for old writers.
lock table public.counters in access exclusive mode;
create table private.counter_shards (
  id smallint primary key check (id between 0 and 63),
  value numeric not null default 0 check (value >= 0 and value = trunc(value))
);
insert into private.counter_shards (id) select generate_series(0, 63);
create table private.counter_baseline (value numeric not null);
insert into private.counter_baseline select value::numeric from public.counters where id = 'main';
do $$ begin
  if (select count(*) from private.counter_baseline) <> 1 then
    raise exception 'Missing main counter';
  end if;
end $$;

-- Keep receipts permanently: deleting them would permit old requests to count again.
-- No email, token or IP address is stored. IDs remain reserved after account deletion.
create table private.click_requests (
  request_id uuid primary key,
  user_id uuid,
  amount smallint not null check (amount between 1 and 50)
);
revoke all on private.counter_shards, private.counter_baseline, private.click_requests
  from public, anon, authenticated;

create function public.counter_total()
returns text language sql stable security definer set search_path = '' as $$
  select (b.value + (select sum(s.value) from private.counter_shards s))::text
  from private.counter_baseline b;
$$;
revoke all on function public.counter_total() from public;
grant execute on function public.counter_total() to anon, authenticated, service_role;

-- No public mutation path, including the original provisioned table.
revoke insert, update, delete, truncate, references, trigger on public.counters from public, anon, authenticated;
drop function public.increment_counter_backend(uuid);
create function public.increment_counter_backend(
  request_id uuid, click_amount integer, click_user_id uuid default null
)
returns table (new_value text, changed_at timestamptz, user_clicks text)
language plpgsql security definer set search_path = '' set lock_timeout = '1s' as $$
declare
  receipt private.click_requests%rowtype;
  inserted boolean;
  personal text;
  shard_id smallint;
begin
  if request_id is null or click_amount is null or click_amount not between 1 and 50 then
    raise exception 'Invalid click request' using errcode = '22023';
  end if;
  insert into private.click_requests values (request_id, click_user_id, click_amount)
    on conflict do nothing;
  inserted := found;
  if not inserted then
    -- A concurrent duplicate waits at the unique index. This subsequent statement
    -- sees its committed receipt at READ COMMITTED (PostgREST's default).
    select * into strict receipt from private.click_requests r where r.request_id = $1;
    if receipt.user_id is distinct from click_user_id or receipt.amount <> click_amount then
      raise exception 'Request ID already used' using errcode = '22023';
    end if;
  else
    if click_user_id is not null then
      insert into public.click_profiles (user_id, display_name, clicks)
      select id, left(coalesce(nullif(btrim(raw_user_meta_data->>'display_name'), ''), 'Participante'), 40), click_amount
      from auth.users where id = click_user_id
      on conflict (user_id) do update set clicks = public.click_profiles.clicks + excluded.clicks;
      if not found then raise exception 'Unknown user' using errcode = '22023'; end if;
    end if;
    shard_id := floor(random() * 64)::smallint;
    update private.counter_shards set value = value + click_amount where id = shard_id;
  end if;
  if click_user_id is not null then
    select p.clicks::text into personal from public.click_profiles p where p.user_id = click_user_id;
  end if;
  return query select public.counter_total(), clock_timestamp(), personal;
end;
$$;
revoke all on function public.increment_counter_backend(uuid, integer, uuid) from public, anon, authenticated;
grant execute on function public.increment_counter_backend(uuid, integer, uuid) to service_role;

notify pgrst, 'reload schema';
commit;

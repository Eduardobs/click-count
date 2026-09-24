-- Execute este arquivo uma vez no SQL Editor do Supabase.
create table if not exists public.counters (
  id text primary key,
  value text not null default '0',
  updated_at timestamptz not null default now(),
  constraint counter_is_non_negative_integer check (value ~ '^(0|[1-9][0-9]*)$')
);

insert into public.counters (id, value)
values ('main', '0')
on conflict (id) do nothing;

alter table public.counters enable row level security;
revoke all on table public.counters from anon, authenticated;
grant select on table public.counters to anon, authenticated;

drop policy if exists "Public can read main counter" on public.counters;
create policy "Public can read main counter"
on public.counters for select to anon, authenticated
using (id = 'main');

-- Soma um em texto, dígito a dígito: não depende de bigint ou de numeric.
create or replace function public.private_increment_decimal(input_value text)
returns text
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
  result text := input_value;
  digit_position integer := length(input_value);
  digit integer;
begin
  if input_value !~ '^(0|[1-9][0-9]*)$' then
    raise exception 'Invalid counter value';
  end if;

  while digit_position > 0 loop
    digit := ascii(substr(result, digit_position, 1)) - 48;
    if digit < 9 then
      return overlay(result placing chr(48 + digit + 1) from digit_position for 1);
    end if;
    result := overlay(result placing '0' from digit_position for 1);
    digit_position := digit_position - 1;
  end loop;
  return '1' || result;
end;
$$;

revoke all on function public.private_increment_decimal(text) from public;

create or replace function public.increment_counter(counter_id text default 'main')
returns table (new_value text, changed_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if counter_id <> 'main' then
    raise exception 'Unknown counter';
  end if;

  return query
  update public.counters as counter
  set value = public.private_increment_decimal(counter.value), updated_at = now()
  where counter.id = counter_id
  returning counter.value, counter.updated_at;
end;
$$;

revoke all on function public.increment_counter(text) from public;
grant execute on function public.increment_counter(text) to anon, authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'counters'
  ) then
    alter publication supabase_realtime add table public.counters;
  end if;
end
$$;

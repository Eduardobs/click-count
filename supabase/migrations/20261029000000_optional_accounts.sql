begin;
create table public.click_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 40),
  clicks numeric not null default 0 check (clicks >= 0 and clicks = trunc(clicks))
);
create index click_profiles_ranking on public.click_profiles (clicks desc, display_name, user_id);
alter table public.click_profiles enable row level security;
revoke all on public.click_profiles from anon, authenticated;

create function public.click_leaderboard()
returns table (display_name text, clicks text)
language sql stable security definer set search_path = '' as $$
  select p.display_name, p.clicks::text from public.click_profiles p
  where p.clicks > 0 order by p.clicks desc, p.display_name, p.user_id limit 20;
$$;
revoke all on function public.click_leaderboard() from public;
grant execute on function public.click_leaderboard() to anon, authenticated;

create function public.my_clicks()
returns text language sql stable security definer set search_path = '' as $$
  select coalesce((select clicks::text from public.click_profiles where user_id = auth.uid()), '0');
$$;
revoke all on function public.my_clicks() from public, anon;
grant execute on function public.my_clicks() to authenticated;

drop function public.increment_counter_backend();
create function public.increment_counter_backend(click_user_id uuid default null)
returns table (new_value text, changed_at timestamptz, user_clicks text)
language plpgsql security definer set search_path = '' set statement_timeout = '2s' as $$
declare personal text;
begin
  -- The Edge Function supplies only a user ID verified by Supabase Auth.
  if click_user_id is not null then
    insert into public.click_profiles (user_id, display_name, clicks)
    select id, left(coalesce(nullif(btrim(raw_user_meta_data->>'display_name'), ''), 'Participante'), 40), 1
    from auth.users where id = click_user_id
    on conflict (user_id) do update set clicks = public.click_profiles.clicks + 1
    returning clicks::text into personal;
    if personal is null then raise exception 'Unknown user'; end if;
  end if;
  return query update public.counters as c
    set value = private.private_increment_decimal(c.value), updated_at = clock_timestamp()
    where c.id = 'main' returning c.value, c.updated_at, personal;
end;
$$;
revoke all on function public.increment_counter_backend(uuid) from public, anon, authenticated;
grant execute on function public.increment_counter_backend(uuid) to service_role;
commit;

-- Sharing features: the game's "case file" story (highlights + titles), one-tap rematch with
-- swapped roles, and an opt-in public replay readable without signing in.

alter table public.games
  add column rematch_game_id uuid references public.games (id) on delete set null,
  add column replay_public boolean not null default false;

-- Internal: story of a finished game (no access checks; callers check).
create or replace function public.story_json(p_game uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  g public.games;
  v_mrx public.players;
  v_pairs jsonb;
  v_closest record;
  v_mrx_min double precision;
  v_adj constant text[] := array['ködös','néma','éjféli','esős','vörös','elveszett','hallgatag','sötét','csendes','füstös'];
  v_noun constant text[] := array['hajnal','sikátor','híd','lámpás','esernyő','kalap','árnyék','tér','kikötő','óra'];
  v_h int;
begin
  select * into g from public.games where id = p_game;
  select * into v_mrx from public.players where game_id = p_game and role = 'mrx';
  v_h := hashtext(g.code) & 2147483647;

  -- Each detective fix paired with Mr. X's nearest-in-time fix (±15 s).
  select coalesce(jsonb_agg(jsonb_build_object('p', player_id, 't', t, 'd', d)), '[]') into v_pairs from (
    select dp.player_id, dp.recorded_at as t, extensions.st_distance(dp.geom, x.geom) as d
    from public.positions dp
    join public.players pl on pl.id = dp.player_id and pl.role = 'detective'
    cross join lateral (
      select xp.geom from public.positions xp
      where xp.player_id = v_mrx.id and xp.recorded_at between dp.recorded_at - interval '15 seconds' and dp.recorded_at + interval '15 seconds'
      order by abs(extract(epoch from xp.recorded_at - dp.recorded_at)) limit 1
    ) x
    where dp.game_id = p_game) s;

  select min((e->>'d')::float8) into v_mrx_min from jsonb_array_elements(v_pairs) e;
  -- Closest call that was not the catch itself (ignore the last minute of a caught game).
  select pl.name, round((e->>'d')::numeric)::int as meters,
         (extract(epoch from (e->>'t')::timestamptz - g.started_at) / 60)::int as minute, pl.id as player_id
    into v_closest
  from jsonb_array_elements(v_pairs) e join public.players pl on pl.id = (e->>'p')::uuid
  where g.winner = 'mrx' or (e->>'t')::timestamptz < g.finished_at - interval '60 seconds'
  order by (e->>'d')::float8 limit 1;

  return jsonb_build_object(
    'code', g.code,
    'case_name', 'A ' || v_adj[1 + v_h % array_length(v_adj, 1)] || ' ' || v_noun[1 + (v_h / 7) % array_length(v_noun, 1)] || ' ügye',
    'winner', g.winner,
    'duration_min', (extract(epoch from g.finished_at - g.started_at) / 60)::int,
    'mrx', v_mrx.name,
    'caught_by', (select name from public.players where id = g.caught_by),
    'center', jsonb_build_object('lat', g.center_lat, 'lng', g.center_lng),
    'radius_m', g.radius_m,
    'catch_point', (select jsonb_build_object('lat', lat, 'lng', lng) from public.positions
                    where player_id = v_mrx.id order by recorded_at desc limit 1),
    'closest', case when v_closest.name is null then null
               else jsonb_build_object('name', v_closest.name, 'meters', v_closest.meters, 'minute', v_closest.minute) end,
    'reveals', (select count(*) from public.reveals where game_id = p_game and kind in ('scheduled', 'radar')),
    'items_used', (select coalesce(jsonb_object_agg(kind, n), '{}') from (
                     select kind, count(*) n from public.items where game_id = p_game and used_at is not null group by kind) s),
    'players', (
      with legs as (
        select player_id, extensions.st_distance(geom, lag(geom) over (partition by player_id order by recorded_at)) as d
        from public.positions where game_id = p_game
      ), stats as (
        select p.id, p.name, p.role, p.joined_at,
          coalesce((select round(sum(d))::int from legs where legs.player_id = p.id), 0) as distance_m,
          (select count(*) from public.items i where i.player_id = p.id)::int as items
        from public.players p where p.game_id = p_game
      ), ranked as (
        select s.*,
          -- One title per player, first matching rule wins.
          case
            when s.role = 'mrx' and g.winner = 'mrx' and coalesce(v_mrx_min, 1e9) > 50 then 'Szellem'
            when s.role = 'mrx' and g.winner = 'mrx' then 'Megfoghatatlan'
            when s.role = 'mrx' then 'Lebukott'
            when s.id = g.caught_by then 'Vérszag'
            when s.id = v_closest.player_id then 'Hajszálnyira'
            when s.distance_m = (select max(distance_m) from stats) and s.distance_m > 0 then 'Maratonista'
            when s.items > 0 and s.items = (select max(items) from stats) then 'Kincsvadász'
            else 'Nyomozó'
          end as title
        from stats s
      )
      select coalesce(jsonb_agg(jsonb_build_object('name', name, 'role', role, 'title', title,
               'distance_m', distance_m, 'items', items) order by role desc nulls last, joined_at), '[]')
      from ranked
    ));
end;
$$;

create or replace function public.game_story(p_game uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_member(p_game) then raise exception 'game_not_found'; end if;
  if not exists (select 1 from public.games where id = p_game and status = 'finished') then raise exception 'game_not_finished'; end if;
  return public.story_json(p_game);
end;
$$;

-- Rematch: same area, settings, points and players; roles swap (catcher, or the next player
-- after the old Mr. X, becomes Mr. X). Idempotent: returns the existing rematch.
create or replace function public.rematch(p_game uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  g public.games;
  v_new public.games;
  v_code text;
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_next_mrx uuid; -- user_id of the next Mr. X
begin
  select * into g from public.games where id = p_game for update;
  if not found or g.host_user_id is distinct from auth.uid() then raise exception 'not_host'; end if;
  if g.status <> 'finished' then raise exception 'game_not_finished'; end if;
  if g.rematch_game_id is not null then return g.rematch_game_id; end if;

  loop
    select string_agg(substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1), '')
      into v_code from generate_series(1, 6);
    exit when not exists (select 1 from public.games where code = v_code);
  end loop;

  if g.caught_by is not null then
    select user_id into v_next_mrx from public.players where id = g.caught_by;
  else
    -- Next player after the old Mr. X in join order (wrapping around).
    select p.user_id into v_next_mrx from public.players p, public.players x
    where p.game_id = p_game and x.game_id = p_game and x.role = 'mrx' and p.id <> x.id
    order by (p.joined_at <= x.joined_at), p.joined_at limit 1;
  end if;

  insert into public.games (code, mode, host_user_id, center_lat, center_lng, radius_m, config)
    values (v_code, g.mode, g.host_user_id, g.center_lat, g.center_lng, g.radius_m, g.config)
    returning * into v_new;
  insert into public.players (game_id, user_id, name, is_host, role)
    select v_new.id, user_id, name, is_host, case when user_id = v_next_mrx then 'mrx' else 'detective' end
    from public.players where game_id = p_game;
  insert into public.points (game_id, name, kind, lat, lng)
    select v_new.id, name, kind, lat, lng from public.points where game_id = p_game;
  update public.games set rematch_game_id = v_new.id where id = p_game;
  return v_new.id;
end;
$$;

-- Host opt-in: make the replay readable by anyone with the code (keeps the data past 24 h).
create or replace function public.set_replay_public(p_game uuid, p_public boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.games set replay_public = p_public, replay_saved = replay_saved or p_public
  where id = p_game and host_user_id = auth.uid() and status = 'finished';
  if not found then raise exception 'not_host'; end if;
end;
$$;

-- Public (anon) read of an opted-in replay by game code.
create or replace function public.public_replay(p_code text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  g public.games;
begin
  select * into g from public.games where code = upper(trim(p_code)) and replay_public and status = 'finished';
  if not found then raise exception 'replay_not_found'; end if;
  return public.story_json(g.id) || jsonb_build_object(
    'started_at', g.started_at,
    'finished_at', g.finished_at,
    'roles', (select jsonb_object_agg(id, jsonb_build_object('name', name, 'role', role)) from public.players where game_id = g.id),
    'tracks', (
      select coalesce(jsonb_agg(jsonb_build_array(player_id, t, lat, lng) order by t), '[]') from (
        select distinct on (player_id, floor(extract(epoch from recorded_at) / 5))
          player_id, extract(epoch from recorded_at)::int as t, round(lat::numeric, 5) as lat, round(lng::numeric, 5) as lng
        from public.positions where game_id = g.id
        order by player_id, floor(extract(epoch from recorded_at) / 5), recorded_at
      ) s),
    'reveal_points', (
      select coalesce(jsonb_agg(jsonb_build_array(extract(epoch from revealed_at)::int, lat, lng) order by revealed_at), '[]')
      from public.reveals where game_id = g.id));
end;
$$;

revoke execute on function public.story_json(uuid) from public, anon, authenticated;
revoke execute on function public.game_story(uuid), public.rematch(uuid), public.set_replay_public(uuid, boolean) from public, anon;
grant execute on function public.game_story(uuid), public.rematch(uuid), public.set_replay_public(uuid, boolean) to authenticated;
revoke execute on function public.public_replay(text) from public;
grant execute on function public.public_replay(text) to anon, authenticated;

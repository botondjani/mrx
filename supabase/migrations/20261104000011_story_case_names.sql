-- Case names: no vowel-initial adjectives ("A elveszett …" is ungrammatical).
create or replace function public.story_json(p_game uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  g public.games;
  v_mrx public.players;
  v_pairs jsonb;
  v_closest record;
  v_mrx_min double precision;
  -- Consonant-initial adjectives only, so the article is always "A" (never "Az").
  v_adj constant text[] := array['ködös','néma','holdfényes','zord','vörös','titokzatos','hallgatag','sötét','csendes','füstös'];
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

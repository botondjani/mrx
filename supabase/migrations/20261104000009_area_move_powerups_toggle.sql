-- Area editing moves the whole circle: points shift with the center (the host's arrangement is
-- kept). Power-ups can be switched off (powerups_enabled, default on).

create or replace function public.set_area(p_game uuid, p_lat double precision, p_lng double precision, p_radius_m integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_game public.games := public.assert_host_lobby(p_game);
begin
  if p_radius_m < (v_game.config->>'radius_min_m')::int or p_radius_m > (v_game.config->>'radius_max_m')::int then
    raise exception 'invalid_radius';
  end if;
  if v_game.center_lat is not null then
    update public.points set lat = lat + (p_lat - v_game.center_lat), lng = lng + (p_lng - v_game.center_lng)
      where game_id = p_game;
  end if;
  update public.games set center_lat = p_lat, center_lng = p_lng, radius_m = p_radius_m where id = p_game;
end;
$$;

create or replace function public.set_options(p_game uuid, p_options jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_game public.games := public.assert_host_lobby(p_game);
  v_key text;
  v_ranges constant jsonb := '{
    "duration_min": [1, 180], "head_start_s": [0, 900], "reveal_interval_s": [20, 900],
    "reveal_interval_endgame_s": [20, 900], "endgame_s": [0, 3600], "mrx_sees_detectives_interval_s": [20, 900],
    "zone_final_pct": [20, 100], "points_max": [3, 20], "point_cooldown_s": [60, 3600]
  }';
  v_kinds constant jsonb := '{"detective": ["radar", "tracker", "compass"], "mrx": ["decoy", "fog", "hide", "jam"]}';
begin
  for v_key in select jsonb_object_keys(p_options) loop
    if v_key in ('transit_allowed', 'powerups_enabled') then
      if jsonb_typeof(p_options->v_key) <> 'boolean' then raise exception 'invalid_option'; end if;
    elsif v_key = 'items' then
      -- {"detective": [...], "mrx": [...]}: subsets of the known kinds (empty = none for that role).
      if jsonb_typeof(p_options->'items') <> 'object'
         or exists (select 1 from jsonb_object_keys(p_options->'items') k where not v_kinds ? k)
         or exists (select 1 from jsonb_each(p_options->'items') e
                    where jsonb_typeof(e.value) <> 'array'
                       or exists (select 1 from jsonb_array_elements_text(e.value) x where not (v_kinds->e.key) ? x)) then
        raise exception 'invalid_option';
      end if;
    elsif v_ranges ? v_key then
      if jsonb_typeof(p_options->v_key) <> 'number'
         or (p_options->>v_key)::numeric not between (v_ranges->v_key->>0)::numeric and (v_ranges->v_key->>1)::numeric then
        raise exception 'invalid_option';
      end if;
    else
      raise exception 'invalid_option';
    end if;
  end loop;
  update public.games set config = config || p_options where id = p_game;
end;
$$;

create or replace function public.pickup_point(p_point uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_pt public.points;
  v_game public.games;
  v_me public.players;
  v_live public.live_positions;
  v_kind text;
  v_cfg jsonb;
begin
  select * into v_pt from public.points where id = p_point;
  if not found then raise exception 'point_not_found'; end if;
  select * into v_game from public.games where id = v_pt.game_id for update;
  if v_game.status <> 'running' then raise exception 'game_not_running'; end if;
  v_cfg := public.default_game_config() || v_game.config;
  if not coalesce((v_cfg->>'powerups_enabled')::boolean, true) then raise exception 'powerups_disabled'; end if;
  select * into v_me from public.players where game_id = v_game.id and user_id = auth.uid();
  if not found then raise exception 'not_in_game'; end if;
  if v_me.role = 'detective' and v_me.out_since is not null then raise exception 'out_of_bounds'; end if;
  if exists (select 1 from public.point_pickups where point_id = p_point and player_id = v_me.id
             and picked_at > now() - make_interval(secs => (v_cfg->>'point_cooldown_s')::int)) then
    raise exception 'point_cooldown';
  end if;
  if (select count(*) from public.items where player_id = v_me.id and used_at is null) >= (v_cfg->>'max_items')::int then
    raise exception 'inventory_full';
  end if;
  select * into v_live from public.live_positions where player_id = v_me.id;
  if not found or v_live.updated_at < now() - interval '60 seconds' then raise exception 'no_position'; end if;
  if not extensions.st_dwithin(
       extensions.st_setsrid(extensions.st_makepoint(v_live.lng, v_live.lat), 4326)::extensions.geography,
       v_pt.geom, (v_cfg->>'pickup_radius_m')::int) then
    raise exception 'too_far';
  end if;
  select value into v_kind from jsonb_array_elements_text(v_cfg->'items'->v_me.role) order by random() limit 1;
  if v_kind is null then raise exception 'no_items_for_role'; end if;
  insert into public.items (game_id, player_id, kind) values (v_game.id, v_me.id, v_kind);
  insert into public.point_pickups (game_id, point_id, player_id) values (v_game.id, p_point, v_me.id);
  return v_kind;
end;
$$;

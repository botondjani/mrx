-- Power-up rework: per-player point cooldown (a shared cooldown leaked when/where Mr. X picked
-- up a point), fog only skips scheduled reveals, new items (compass, hide, jam), host options
-- for enabled items, number of points and cooldown.

alter table public.games
  add column hide_until timestamptz,
  add column jam_until timestamptz;

create table public.point_pickups (
  id bigint generated always as identity primary key,
  game_id uuid not null references public.games (id) on delete cascade,
  point_id uuid not null references public.points (id) on delete cascade,
  player_id uuid not null references public.players (id) on delete cascade,
  picked_at timestamptz not null default now()
);
create index point_pickups_player_idx on public.point_pickups (player_id, point_id, picked_at);
alter table public.point_pickups enable row level security;
-- Only your own pickups (and therefore cooldowns) are visible.
create policy point_pickups_select on public.point_pickups for select to authenticated
  using (exists (select 1 from public.players p where p.id = player_id and p.user_id = auth.uid()));
alter publication supabase_realtime add table public.point_pickups;

create or replace function public.default_game_config()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'min_players', 4,
    'max_players', 12,
    'radius_min_m', 500,
    'radius_max_m', 2000,
    'radius_default_m', 1000,
    'report_interval_s', 10,
    'fast_report_interval_s', 3,
    'fast_report_radius_m', 150,
    'head_start_s', 300,
    'head_start_radius_m', 100,
    'duration_min', 60,
    'duration_options_min', jsonb_build_array(45, 60, 90),
    'reveal_interval_s', 180,
    'reveal_interval_endgame_s', 120,
    'endgame_s', 600,
    'mrx_sees_detectives_interval_s', 120,
    'proximity_m', 50,
    'proximity_repeat_s', 30,
    'out_of_bounds_grace_s', 30,
    'out_of_bounds_penalty_s', 120,
    'transit_allowed', true,
    'transit_speed_limit_kmh', 25,
    'points_min', 6,
    'points_max', 12,
    'point_min_spacing_m', 150,
    'pickup_radius_m', 25,
    'point_cooldown_s', 600,
    'max_items', 2,
    'items', jsonb_build_object(
      'detective', jsonb_build_array('radar', 'tracker', 'compass'),
      'mrx', jsonb_build_array('decoy', 'fog', 'hide', 'jam')
    ),
    'tracker_duration_s', 60,
    'hide_duration_s', 120,
    'jam_duration_s', 60,
    'decoy_max_distance_m', 300,
    'position_retention_h', 24,
    'gps_max_accuracy_m', 50,
    'gps_max_speed_kmh', 150
  )
$$;

-- Zavarás (jam): detectives cannot see each other while it lasts.
create or replace function public.is_jammed(p_game uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select jam_until > now() from public.games where id = p_game), false)
$$;

alter policy live_positions_select on public.live_positions
  using (
    exists (select 1 from public.players p where p.id = player_id and p.user_id = auth.uid())
    or (role = 'detective' and public.my_role(game_id) = 'detective' and not public.is_jammed(game_id))
  );

-- Fog now only skips the next *scheduled* reveal (a detective's radar still works).
create or replace function public.make_reveal(p_game uuid, p_mrx uuid, p_kind text, p_notify boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_live public.live_positions;
  v_game public.games;
  v_prev extensions.geography;
  v_heading real;
begin
  select * into v_live from public.live_positions where player_id = p_mrx;
  if not found then return; end if;
  if p_kind in ('scheduled', 'radar') then
    select * into v_game from public.games where id = p_game;
    if v_game.fog_pending and p_kind = 'scheduled' then
      update public.games set fog_pending = false where id = p_game;
      if p_notify then perform public.emit_role(p_game, 'detective', 'reveal_fogged'); end if;
      return;
    end if;
    if v_game.decoy_lat is not null then
      update public.games set decoy_lat = null, decoy_lng = null where id = p_game;
      insert into public.reveals (game_id, player_id, lat, lng, heading, kind)
        values (p_game, p_mrx, v_game.decoy_lat, v_game.decoy_lng, null, p_kind);
      if p_notify then perform public.emit_role(p_game, 'detective', 'reveal', jsonb_build_object('kind', p_kind)); end if;
      return;
    end if;
  end if;
  select geom into v_prev from public.positions
    where player_id = p_mrx and recorded_at <= v_live.updated_at - interval '30 seconds'
    order by recorded_at desc limit 1;
  if v_prev is not null then
    v_heading := degrees(extensions.st_azimuth(
      v_prev, extensions.st_setsrid(extensions.st_makepoint(v_live.lng, v_live.lat), 4326)::extensions.geography));
  end if;
  insert into public.reveals (game_id, player_id, lat, lng, heading, kind)
    values (p_game, p_mrx, v_live.lat, v_live.lng, v_heading, p_kind);
  if p_notify then
    perform public.emit_role(p_game, 'detective', 'reveal', jsonb_build_object('kind', p_kind));
  end if;
end;
$$;

-- Tracker reveals are suppressed while Mr. X hides.
create or replace function public.process_report(p_user uuid, p_game uuid, p_locations jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  g public.games;
  me public.players;
  mrx public.players;
  cfg jsonb;
  v_now timestamptz := now();
  v_hs_end timestamptz;
  v_last record;
  v_point extensions.geography;
  v_inside boolean;
  v_min_d double precision;
  v_fast boolean := false;
  v_reveal_s int;
  v_events jsonb;
  v_prev public.live_positions;
  v_accepted boolean := false;
begin
  select * into g from public.games where id = p_game for update;
  if not found then raise exception 'game_not_found'; end if;
  select * into me from public.players where game_id = p_game and user_id = p_user;
  if not found then raise exception 'not_in_game'; end if;
  cfg := public.default_game_config() || g.config;

  if g.status = 'running' then
    -- GPS filtering: drop inaccurate fixes, and jumps implying an impossible speed since the
    -- last accepted position (self-healing: the allowed distance grows with the elapsed time).
    select l.* into v_last
    from jsonb_to_recordset(p_locations) as l(lat float8, lng float8, accuracy real, speed real, heading real, "timestamp" float8)
    where coalesce(l.accuracy, 0) <= (cfg->>'gps_max_accuracy_m')::real
    order by l."timestamp" desc limit 1;
    v_accepted := found;
    if v_accepted then
      select * into v_prev from public.live_positions where player_id = me.id;
      if found then
        v_accepted := extensions.st_distance(
            extensions.st_setsrid(extensions.st_makepoint(v_prev.lng, v_prev.lat), 4326)::extensions.geography,
            extensions.st_setsrid(extensions.st_makepoint(v_last.lng, v_last.lat), 4326)::extensions.geography)
          <= (cfg->>'gps_max_speed_kmh')::numeric / 3.6 * greatest(1, extract(epoch from v_now - v_prev.updated_at));
      end if;
    end if;
  end if;

  if g.status = 'running' and v_accepted then
    insert into public.positions (game_id, player_id, lat, lng, accuracy_m, speed_mps, heading, recorded_at)
    values (p_game, me.id, v_last.lat, v_last.lng, v_last.accuracy, v_last.speed, v_last.heading, to_timestamp(v_last."timestamp" / 1000.0));

    insert into public.live_positions (player_id, game_id, role, lat, lng, accuracy_m, heading, speed_mps, updated_at)
    values (me.id, p_game, me.role, v_last.lat, v_last.lng, v_last.accuracy, v_last.heading, v_last.speed, v_now)
    on conflict (player_id) do update set lat = excluded.lat, lng = excluded.lng, accuracy_m = excluded.accuracy_m,
      heading = excluded.heading, speed_mps = excluded.speed_mps, role = excluded.role, updated_at = excluded.updated_at;
    update public.players set last_report_at = v_now where id = me.id;
  end if;

  if g.status = 'running' then
    v_hs_end := g.started_at + make_interval(secs => (cfg->>'head_start_s')::int);
    if v_accepted then
      v_point := extensions.st_setsrid(extensions.st_makepoint(v_last.lng, v_last.lat), 4326)::extensions.geography;
    end if;

    if v_now >= g.ends_at then
      perform public.finish_game(p_game, 'mrx', null);
    else
      -- Head start ends: tell everyone once.
      if v_now >= v_hs_end and g.next_reveal_at is null then
        perform public.emit_role(p_game, null, 'head_start_over');
        g.next_reveal_at := v_hs_end + make_interval(secs => case
          when g.ends_at - v_hs_end <= make_interval(secs => (cfg->>'endgame_s')::int)
          then (cfg->>'reveal_interval_endgame_s')::int else (cfg->>'reveal_interval_s')::int end);
        update public.games set next_reveal_at = g.next_reveal_at where id = p_game;
      end if;

      -- Per-player checks need a fresh accepted fix.
      if v_accepted then
      -- Area boundary for the reporting player.
      v_inside := extensions.st_dwithin(v_point, g.center, public.zone_radius(g, v_now));
      if not v_inside and me.out_since is null then
        update public.players set out_since = v_now where id = me.id;
        perform public.emit(p_game, me.id, 'out_of_bounds');
      elsif v_inside and me.out_since is not null then
        update public.players set out_since = null where id = me.id;
        perform public.emit(p_game, me.id, 'back_in_bounds');
      end if;

      -- Transit disabled: warn above the speed limit (max once per proximity_repeat_s).
      if not (cfg->>'transit_allowed')::boolean
         and coalesce(v_last.speed, 0) * 3.6 > (cfg->>'transit_speed_limit_kmh')::numeric
         and (me.last_speed_warn_at is null or me.last_speed_warn_at < v_now - make_interval(secs => (cfg->>'proximity_repeat_s')::int)) then
        update public.players set last_speed_warn_at = v_now where id = me.id;
        perform public.emit(p_game, me.id, 'speeding');
      end if;

      -- Head start: detectives must stay near the start point (area center).
      if v_now < v_hs_end and me.role = 'detective'
         and not extensions.st_dwithin(v_point, g.center, (cfg->>'head_start_radius_m')::int)
         and (me.last_headstart_warn_at is null or me.last_headstart_warn_at < v_now - make_interval(secs => (cfg->>'proximity_repeat_s')::int)) then
        update public.players set last_headstart_warn_at = v_now where id = me.id;
        perform public.emit(p_game, me.id, 'head_start_violation');
      end if;
      end if; -- v_accepted

      select * into mrx from public.players where game_id = p_game and role = 'mrx';

      if v_now >= v_hs_end and exists (select 1 from public.live_positions where player_id = mrx.id) then
        -- Mr. X outside the area for longer than the grace period: live exposure.
        if mrx.out_since is not null
           and mrx.out_since <= v_now - make_interval(secs => (cfg->>'out_of_bounds_grace_s')::int)
           and (mrx.penalty_until is null or mrx.penalty_until < v_now) then
          mrx.penalty_until := v_now + make_interval(secs => (cfg->>'out_of_bounds_penalty_s')::int);
          update public.players set penalty_until = mrx.penalty_until where id = mrx.id;
          perform public.emit_role(p_game, 'detective', 'mrx_exposed');
        end if;
        -- Live exposure (penalty or a detective's tracker): every Mr. X report becomes a reveal.
        if me.id = mrx.id and v_accepted and (mrx.penalty_until > v_now or (g.tracker_until > v_now and not coalesce(g.hide_until > v_now, false))) then
          perform public.make_reveal(p_game, mrx.id, case when mrx.penalty_until > v_now then 'penalty' else 'tracker' end, false);
        end if;

        -- Scheduled reveal; faster in the endgame.
        if v_now >= g.next_reveal_at then
          perform public.make_reveal(p_game, mrx.id, 'scheduled', true);
          v_reveal_s := case when g.ends_at - v_now <= make_interval(secs => (cfg->>'endgame_s')::int)
                             then (cfg->>'reveal_interval_endgame_s')::int else (cfg->>'reveal_interval_s')::int end;
          update public.games set next_reveal_at = v_now + make_interval(secs => v_reveal_s) where id = p_game;
        end if;

        -- Proximity of the nearest fresh detective to Mr. X.
        select min(extensions.st_distance(
                 extensions.st_setsrid(extensions.st_makepoint(d.lng, d.lat), 4326)::extensions.geography,
                 extensions.st_setsrid(extensions.st_makepoint(x.lng, x.lat), 4326)::extensions.geography))
          into v_min_d
        from public.live_positions d, public.live_positions x
        where d.game_id = p_game and d.role = 'detective' and d.updated_at > v_now - interval '60 seconds'
          and x.player_id = mrx.id;
        v_fast := coalesce(v_min_d <= (cfg->>'fast_report_radius_m')::numeric, false);
        if v_min_d <= (cfg->>'proximity_m')::numeric
           and (mrx.last_proximity_at is null or mrx.last_proximity_at < v_now - make_interval(secs => (cfg->>'proximity_repeat_s')::int)) then
          update public.players set last_proximity_at = v_now where id = mrx.id;
          perform public.emit(p_game, mrx.id, 'proximity');
        end if;
      end if;
      if v_fast is distinct from g.fast_mode then
        update public.games set fast_mode = v_fast where id = p_game;
      end if;

      -- Mr. X periodically sees the detectives (from game start).
      if v_now >= coalesce(g.next_mrx_view_at, g.started_at) then
        insert into public.detective_snapshots (game_id, player_id, lat, lng)
          select p_game, player_id, lat, lng from public.live_positions where game_id = p_game and role = 'detective';
        update public.games set next_mrx_view_at = v_now + make_interval(secs => (cfg->>'mrx_sees_detectives_interval_s')::int)
          where id = p_game;
      end if;
    end if;
  end if;

  with pending as (
    update public.events set delivered_at = v_now
    where player_id = me.id and delivered_at is null
    returning kind, payload, created_at
  )
  select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'payload', payload) order by created_at), '[]') into v_events
  from pending;

  select status, fast_mode into g.status, g.fast_mode from public.games where id = p_game;
  return jsonb_build_object(
    'game_status', g.status,
    'events', v_events,
    'gps_filtered', g.status = 'running' and not v_accepted,
    'next_interval_ms', 1000 * (case when g.fast_mode then cfg->>'fast_report_interval_s' else cfg->>'report_interval_s' end)::int
  );
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
    if v_key = 'transit_allowed' then
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

-- Uses an item and returns its result for the user's screen:
-- { ok: true } | { blocked: true } (Mr. X hides) | { direction, distance } (compass).
-- p_lat/p_lng: decoy target (Mr. X picks it on the map).
create or replace function public.activate_item(p_item uuid, p_lat double precision default null, p_lng double precision default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_item public.items;
  v_game public.games;
  v_cfg jsonb;
  v_mrx uuid;
  v_live public.live_positions;
  v_me_live public.live_positions;
  v_hidden boolean;
  v_result jsonb := '{"ok": true}';
  v_d double precision;
  v_az double precision;
begin
  select i.* into v_item from public.items i join public.players p on p.id = i.player_id
    where i.id = p_item and i.used_at is null and p.user_id = auth.uid();
  if not found then raise exception 'item_not_found'; end if;
  select * into v_game from public.games where id = v_item.game_id for update;
  if v_game.status <> 'running' then raise exception 'game_not_running'; end if;
  v_cfg := public.default_game_config() || v_game.config;
  if now() < v_game.started_at + make_interval(secs => (v_cfg->>'head_start_s')::int) then
    raise exception 'head_start';
  end if;
  select id into v_mrx from public.players where game_id = v_game.id and role = 'mrx';
  select * into v_live from public.live_positions where player_id = v_mrx;
  v_hidden := coalesce(v_game.hide_until > now(), false);

  case v_item.kind
    when 'radar' then
      if v_hidden then v_result := '{"blocked": true}';
      else perform public.make_reveal(v_game.id, v_mrx, 'radar', true);
      end if;
    when 'tracker' then
      if v_hidden then v_result := '{"blocked": true}';
      else
        update public.games set tracker_until = now() + make_interval(secs => (v_cfg->>'tracker_duration_s')::int)
          where id = v_game.id;
        perform public.make_reveal(v_game.id, v_mrx, 'tracker', false);
        perform public.emit_role(v_game.id, 'detective', 'tracker_started');
      end if;
    when 'compass' then
      select * into v_me_live from public.live_positions where player_id = v_item.player_id;
      if v_hidden then v_result := '{"blocked": true}';
      elsif v_live.player_id is null or v_me_live.player_id is null then raise exception 'no_position';
      else
        v_d := extensions.st_distance(
          extensions.st_setsrid(extensions.st_makepoint(v_me_live.lng, v_me_live.lat), 4326)::extensions.geography,
          extensions.st_setsrid(extensions.st_makepoint(v_live.lng, v_live.lat), 4326)::extensions.geography);
        v_az := degrees(extensions.st_azimuth(
          extensions.st_setsrid(extensions.st_makepoint(v_me_live.lng, v_me_live.lat), 4326)::extensions.geography,
          extensions.st_setsrid(extensions.st_makepoint(v_live.lng, v_live.lat), 4326)::extensions.geography));
        -- Coarse on purpose: 8 directions and a distance band, never coordinates.
        v_result := jsonb_build_object(
          'direction', (array['É','ÉK','K','DK','D','DNy','Ny','ÉNy'])[(floor((coalesce(v_az, 0) + 22.5) / 45)::int % 8) + 1],
          'distance', case when v_d < 150 then '150 m-en belül' when v_d < 300 then '150–300 m'
                           when v_d < 600 then '300–600 m' when v_d < 1000 then '600 m – 1 km' else '1 km-nél messzebb' end);
      end if;
    when 'decoy' then
      if p_lat is null or p_lng is null or v_live.player_id is null or not extensions.st_dwithin(
           extensions.st_setsrid(extensions.st_makepoint(v_live.lng, v_live.lat), 4326)::extensions.geography,
           extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography,
           (v_cfg->>'decoy_max_distance_m')::int) then
        raise exception 'decoy_too_far';
      end if;
      update public.games set decoy_lat = p_lat, decoy_lng = p_lng where id = v_game.id;
    when 'fog' then
      update public.games set fog_pending = true where id = v_game.id;
    when 'hide' then
      update public.games set hide_until = now() + make_interval(secs => (v_cfg->>'hide_duration_s')::int) where id = v_game.id;
    when 'jam' then
      update public.games set jam_until = now() + make_interval(secs => (v_cfg->>'jam_duration_s')::int) where id = v_game.id;
      perform public.emit_role(v_game.id, 'detective', 'jammed');
    else
      raise exception 'item_not_found';
  end case;
  update public.items set used_at = now() where id = p_item;
  return v_result;
end;
$$;

-- activate_item replaces use_item (different return type).
revoke execute on function public.use_item(uuid, double precision, double precision) from public, anon, authenticated;
revoke execute on function public.activate_item(uuid, double precision, double precision) from public, anon;
grant execute on function public.activate_item(uuid, double precision, double precision) to authenticated;
revoke execute on function public.is_jammed(uuid) from public, anon;
grant execute on function public.is_jammed(uuid) to authenticated;

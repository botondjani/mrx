-- Phase 3: power-ups, GPS filtering, stats, replay, position retention (pg_cron).

alter table public.games
  add column fog_pending boolean not null default false,
  add column decoy_lat double precision,
  add column decoy_lng double precision,
  add column tracker_until timestamptz,
  add column replay_saved boolean not null default false;

alter publication supabase_realtime add table public.items;

-- New config keys (GPS filtering); existing games get the defaults for missing keys.
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
      'detective', jsonb_build_array('radar', 'tracker'),
      'mrx', jsonb_build_array('decoy', 'fog')
    ),
    'tracker_duration_s', 60,
    'decoy_max_distance_m', 300,
    'position_retention_h', 24,
    'gps_max_accuracy_m', 50,
    'gps_max_speed_kmh', 150
  )
$$;

update public.games set config = public.default_game_config() || config;

-- Reveal Mr. X. Scheduled and radar reveals honour Mr. X's items: fog skips the reveal,
-- a decoy shows the chosen fake point (stored with the same kind, so detectives cannot tell).
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
    if v_game.fog_pending then
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

-- Game tick, now with GPS filtering, tracker live exposure and endgame-aware first reveal.
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
  cfg := g.config;

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
      v_inside := extensions.st_dwithin(v_point, g.center, g.radius_m);
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
        if me.id = mrx.id and v_accepted and (mrx.penalty_until > v_now or g.tracker_until > v_now) then
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

-- ---------------------------------------------------------------------------
-- Power-ups
-- ---------------------------------------------------------------------------
create or replace function public.pickup_point(p_point uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_pt public.points;
  v_game public.games;
  v_me public.players;
  v_live public.live_positions;
  v_kind text;
begin
  select * into v_pt from public.points where id = p_point;
  if not found then raise exception 'point_not_found'; end if;
  select * into v_game from public.games where id = v_pt.game_id for update;
  if v_game.status <> 'running' then raise exception 'game_not_running'; end if;
  select * into v_me from public.players where game_id = v_game.id and user_id = auth.uid();
  if not found then raise exception 'not_in_game'; end if;
  if v_me.role = 'detective' and v_me.out_since is not null then raise exception 'out_of_bounds'; end if;
  if v_pt.active_after > now() then raise exception 'point_cooldown'; end if;
  if (select count(*) from public.items where player_id = v_me.id and used_at is null)
     >= (v_game.config->>'max_items')::int then
    raise exception 'inventory_full';
  end if;
  select * into v_live from public.live_positions where player_id = v_me.id;
  if not found or v_live.updated_at < now() - interval '60 seconds' then raise exception 'no_position'; end if;
  if not extensions.st_dwithin(
       extensions.st_setsrid(extensions.st_makepoint(v_live.lng, v_live.lat), 4326)::extensions.geography,
       v_pt.geom, (v_game.config->>'pickup_radius_m')::int) then
    raise exception 'too_far';
  end if;
  select value into v_kind from jsonb_array_elements_text(v_game.config->'items'->v_me.role) order by random() limit 1;
  insert into public.items (game_id, player_id, kind) values (v_game.id, v_me.id, v_kind);
  update public.points set active_after = now() + make_interval(secs => (v_game.config->>'point_cooldown_s')::int)
    where id = p_point;
  return v_kind;
end;
$$;

-- p_lat/p_lng: decoy target (Mr. X picks it on the map).
create or replace function public.use_item(p_item uuid, p_lat double precision default null, p_lng double precision default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_item public.items;
  v_game public.games;
  v_mrx uuid;
  v_live public.live_positions;
begin
  select i.* into v_item from public.items i join public.players p on p.id = i.player_id
    where i.id = p_item and i.used_at is null and p.user_id = auth.uid();
  if not found then raise exception 'item_not_found'; end if;
  select * into v_game from public.games where id = v_item.game_id for update;
  if v_game.status <> 'running' then raise exception 'game_not_running'; end if;
  if now() < v_game.started_at + make_interval(secs => (v_game.config->>'head_start_s')::int) then
    raise exception 'head_start';
  end if;
  select id into v_mrx from public.players where game_id = v_game.id and role = 'mrx';

  case v_item.kind
    when 'radar' then
      perform public.make_reveal(v_game.id, v_mrx, 'radar', true);
    when 'tracker' then
      update public.games set tracker_until = now() + make_interval(secs => (v_game.config->>'tracker_duration_s')::int)
        where id = v_game.id;
      perform public.make_reveal(v_game.id, v_mrx, 'tracker', false);
      perform public.emit_role(v_game.id, 'detective', 'tracker_started');
    when 'decoy' then
      select * into v_live from public.live_positions where player_id = v_mrx;
      if p_lat is null or p_lng is null or not found or not extensions.st_dwithin(
           extensions.st_setsrid(extensions.st_makepoint(v_live.lng, v_live.lat), 4326)::extensions.geography,
           extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography,
           (v_game.config->>'decoy_max_distance_m')::int) then
        raise exception 'decoy_too_far';
      end if;
      update public.games set decoy_lat = p_lat, decoy_lng = p_lng where id = v_game.id;
    when 'fog' then
      update public.games set fog_pending = true where id = v_game.id;
    else
      raise exception 'item_not_found';
  end case;
  update public.items set used_at = now() where id = p_item;
end;
$$;

-- ---------------------------------------------------------------------------
-- After the game: stats and replay (members only, finished games only)
-- ---------------------------------------------------------------------------
create or replace function public.game_stats(p_game uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_game public.games;
begin
  select * into v_game from public.games where id = p_game;
  if not found or not public.is_member(p_game) then raise exception 'game_not_found'; end if;
  if v_game.status <> 'finished' then raise exception 'game_not_finished'; end if;
  return jsonb_build_object(
    'duration_s', extract(epoch from v_game.finished_at - v_game.started_at)::int,
    'head_start_s', (v_game.config->>'head_start_s')::int,
    'players', (
      with legs as (
        select player_id, extensions.st_distance(geom, lag(geom) over (partition by player_id order by recorded_at)) as d
        from public.positions where game_id = p_game
      )
      select coalesce(jsonb_agg(jsonb_build_object(
        'name', p.name, 'role', p.role,
        'distance_m', coalesce((select round(sum(d))::int from legs where legs.player_id = p.id), 0),
        'items', (select count(*) from public.items i where i.player_id = p.id)
      ) order by p.role desc nulls last, p.name), '[]')
      from public.players p where p.game_id = p_game
    ));
end;
$$;

-- Tracks downsampled to one point per player per 5 s.
create or replace function public.game_replay(p_game uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_game public.games;
begin
  select * into v_game from public.games where id = p_game;
  if not found or not public.is_member(p_game) then raise exception 'game_not_found'; end if;
  if v_game.status <> 'finished' then raise exception 'game_not_finished'; end if;
  return jsonb_build_object(
    'started_at', v_game.started_at,
    'finished_at', v_game.finished_at,
    'saved', v_game.replay_saved,
    'tracks', (
      select coalesce(jsonb_agg(jsonb_build_array(player_id, t, lat, lng) order by t), '[]') from (
        select distinct on (player_id, floor(extract(epoch from recorded_at) / 5))
          player_id, extract(epoch from recorded_at)::int as t, round(lat::numeric, 6) as lat, round(lng::numeric, 6) as lng
        from public.positions where game_id = p_game
        order by player_id, floor(extract(epoch from recorded_at) / 5), recorded_at
      ) s),
    'reveals', (
      select coalesce(jsonb_agg(jsonb_build_array(extract(epoch from revealed_at)::int, lat, lng) order by revealed_at), '[]')
      from public.reveals where game_id = p_game));
end;
$$;

create or replace function public.save_replay(p_game uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.games set replay_saved = true
  where id = p_game and host_user_id = auth.uid() and status = 'finished';
  if not found then raise exception 'not_host'; end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Retention: positions are deleted position_retention_h after the game ends (unless the host
-- saved the replay). Abandoned games (never finished) are purged after 24 h.
-- ---------------------------------------------------------------------------
create or replace function public.purge_positions()
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_ids uuid[];
begin
  select coalesce(array_agg(id), '{}') into v_ids from public.games g
  where not g.replay_saved and (
    (g.status = 'finished' and g.finished_at < now() - make_interval(hours => (g.config->>'position_retention_h')::int))
    or (g.status <> 'finished' and g.created_at < now() - interval '24 hours'));
  delete from public.positions where game_id = any (v_ids);
  delete from public.live_positions where game_id = any (v_ids);
  delete from public.detective_snapshots where game_id = any (v_ids);
  delete from public.reveals where game_id = any (v_ids);
  delete from public.events where game_id = any (v_ids);
end;
$$;

create extension if not exists pg_cron;
select cron.schedule('purge-positions', '17 * * * *', 'select public.purge_positions()');

revoke execute on function public.purge_positions(), public.default_game_config() from public, anon, authenticated;
revoke execute on function public.pickup_point(uuid), public.use_item(uuid, double precision, double precision),
  public.game_stats(uuid), public.game_replay(uuid), public.save_replay(uuid) from public, anon;
grant execute on function public.pickup_point(uuid), public.use_item(uuid, double precision, double precision),
  public.game_stats(uuid), public.game_replay(uuid), public.save_replay(uuid) to authenticated;

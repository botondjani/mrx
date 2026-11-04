-- Shrinking zone: the play area shrinks linearly from the end of the head start to the end of
-- the game, down to zone_final_pct % of the original radius (100 = no shrinking, the default).
-- Power-up points stay in the original area.

create or replace function public.zone_radius(g public.games, p_at timestamptz)
returns double precision language sql stable set search_path = '' as $$
  with t as (
    select g.started_at + make_interval(secs => coalesce((g.config->>'head_start_s')::int, 300)) as hs_end,
           coalesce((g.config->>'zone_final_pct')::numeric, 100) / 100 as final
  )
  select g.radius_m * (1 - (1 - t.final) * least(1, greatest(0,
           extract(epoch from p_at - t.hs_end) / greatest(1, extract(epoch from g.ends_at - t.hs_end)))))
  from t
$$;

-- Host option for the zone (whitelisted with range 20–100 %).
create or replace function public.set_options(p_game uuid, p_options jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_game public.games := public.assert_host_lobby(p_game);
  v_key text;
  v_ranges constant jsonb := '{
    "duration_min": [1, 180], "head_start_s": [0, 900], "reveal_interval_s": [20, 900],
    "reveal_interval_endgame_s": [20, 900], "endgame_s": [0, 3600], "mrx_sees_detectives_interval_s": [20, 900],
    "zone_final_pct": [20, 100]
  }';
begin
  for v_key in select jsonb_object_keys(p_options) loop
    if v_key = 'transit_allowed' then
      if jsonb_typeof(p_options->v_key) <> 'boolean' then raise exception 'invalid_option'; end if;
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

-- Game tick: the boundary check uses the current (possibly shrunk) zone.
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

revoke execute on function public.zone_radius(public.games, timestamptz) from public, anon;

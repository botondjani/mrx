-- Phase 2: server-side gameplay. Every position report runs process_report() in one
-- transaction (game row locked), which advances timers, reveals, penalties and
-- proximity, and queues per-player events that the report response delivers.

alter table public.games
  add column winner text check (winner in ('mrx', 'detectives')),
  add column caught_by uuid references public.players (id) on delete set null,
  add column next_reveal_at timestamptz,
  add column next_mrx_view_at timestamptz,
  add column fast_mode boolean not null default false;

alter table public.players
  add column last_report_at timestamptz,
  add column out_since timestamptz,
  add column penalty_until timestamptz,
  add column last_proximity_at timestamptz,
  add column last_headstart_warn_at timestamptz,
  add column last_speed_warn_at timestamptz;

-- Per-recipient event queue (notifications). Delivered via report_position responses.
create table public.events (
  id bigint generated always as identity primary key,
  game_id uuid not null references public.games (id) on delete cascade,
  player_id uuid not null references public.players (id) on delete cascade,
  kind text not null,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  delivered_at timestamptz
);
create index events_pending_idx on public.events (player_id) where delivered_at is null;
alter table public.events enable row level security;
create policy events_select on public.events for select to authenticated
  using (exists (select 1 from public.players p where p.id = player_id and p.user_id = auth.uid()));

-- What Mr. X sees of the detectives (periodic snapshots).
create table public.detective_snapshots (
  id bigint generated always as identity primary key,
  game_id uuid not null references public.games (id) on delete cascade,
  player_id uuid not null references public.players (id) on delete cascade,
  lat double precision not null,
  lng double precision not null,
  taken_at timestamptz not null default now()
);
create index detective_snapshots_game_idx on public.detective_snapshots (game_id, taken_at);
alter table public.detective_snapshots enable row level security;
create policy detective_snapshots_select on public.detective_snapshots for select to authenticated
  using (public.my_role(game_id) in ('mrx', 'detective'));

-- Overpass responses cached by area.
create table public.overpass_cache (
  key text primary key,
  elements jsonb not null,
  fetched_at timestamptz not null default now()
);
alter table public.overpass_cache enable row level security;

alter publication supabase_realtime add table public.reveals, public.detective_snapshots, public.points;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.emit(p_game uuid, p_player uuid, p_kind text, p_payload jsonb default '{}')
returns void language sql security definer set search_path = '' as $$
  insert into public.events (game_id, player_id, kind, payload) values (p_game, p_player, p_kind, p_payload)
$$;

create or replace function public.emit_role(p_game uuid, p_role text, p_kind text, p_payload jsonb default '{}')
returns void language sql security definer set search_path = '' as $$
  insert into public.events (game_id, player_id, kind, payload)
  select p_game, id, p_kind, p_payload from public.players where game_id = p_game and (p_role is null or role = p_role)
$$;

create or replace function public.finish_game(p_game uuid, p_winner text, p_caught_by uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.games set status = 'finished', finished_at = now(), winner = p_winner, caught_by = p_caught_by
  where id = p_game and status = 'running';
  if found then
    perform public.emit_role(p_game, null, 'game_over', jsonb_build_object(
      'winner', p_winner,
      'caught_by', (select name from public.players where id = p_caught_by)));
  end if;
end;
$$;

-- Reveal Mr. X at his latest live position, heading from ~30 s earlier.
create or replace function public.make_reveal(p_game uuid, p_mrx uuid, p_kind text, p_notify boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_live public.live_positions;
  v_prev extensions.geography;
  v_heading real;
begin
  select * into v_live from public.live_positions where player_id = p_mrx;
  if not found then return; end if;
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

-- ---------------------------------------------------------------------------
-- The game tick. Called only by the report_position Edge Function (service role).
-- ---------------------------------------------------------------------------
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
begin
  select * into g from public.games where id = p_game for update;
  if not found then raise exception 'game_not_found'; end if;
  select * into me from public.players where game_id = p_game and user_id = p_user;
  if not found then raise exception 'not_in_game'; end if;
  cfg := g.config;

  if g.status = 'running' then
    -- Store positions; the newest one becomes the live position.
    insert into public.positions (game_id, player_id, lat, lng, accuracy_m, speed_mps, heading, recorded_at)
    select p_game, me.id, l.lat, l.lng, l.accuracy, l.speed, l.heading, to_timestamp(l."timestamp" / 1000.0)
    from jsonb_to_recordset(p_locations) as l(lat float8, lng float8, accuracy real, speed real, heading real, "timestamp" float8);

    select l.* into v_last
    from jsonb_to_recordset(p_locations) as l(lat float8, lng float8, accuracy real, speed real, heading real, "timestamp" float8)
    order by l."timestamp" desc limit 1;

    insert into public.live_positions (player_id, game_id, role, lat, lng, accuracy_m, heading, speed_mps, updated_at)
    values (me.id, p_game, me.role, v_last.lat, v_last.lng, v_last.accuracy, v_last.heading, v_last.speed, v_now)
    on conflict (player_id) do update set lat = excluded.lat, lng = excluded.lng, accuracy_m = excluded.accuracy_m,
      heading = excluded.heading, speed_mps = excluded.speed_mps, role = excluded.role, updated_at = excluded.updated_at;
    update public.players set last_report_at = v_now where id = me.id;

    v_hs_end := g.started_at + make_interval(secs => (cfg->>'head_start_s')::int);
    v_point := extensions.st_setsrid(extensions.st_makepoint(v_last.lng, v_last.lat), 4326)::extensions.geography;

    if v_now >= g.ends_at then
      perform public.finish_game(p_game, 'mrx', null);
    else
      -- Head start ends: tell everyone once.
      if v_now >= v_hs_end and g.next_reveal_at is null then
        perform public.emit_role(p_game, null, 'head_start_over');
        g.next_reveal_at := v_hs_end + make_interval(secs => (cfg->>'reveal_interval_s')::int);
        update public.games set next_reveal_at = g.next_reveal_at where id = p_game;
      end if;

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
        if me.id = mrx.id and mrx.penalty_until > v_now then
          perform public.make_reveal(p_game, mrx.id, 'penalty', false);
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
    'next_interval_ms', 1000 * (case when g.fast_mode then cfg->>'fast_report_interval_s' else cfg->>'report_interval_s' end)::int
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Player-facing RPCs
-- ---------------------------------------------------------------------------

-- Host options in the lobby. Only whitelisted keys, validated ranges.
create or replace function public.set_options(p_game uuid, p_options jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_game public.games := public.assert_host_lobby(p_game);
  v_key text;
  v_ranges constant jsonb := '{
    "duration_min": [1, 180], "head_start_s": [0, 900], "reveal_interval_s": [20, 900],
    "reveal_interval_endgame_s": [20, 900], "endgame_s": [0, 3600], "mrx_sees_detectives_interval_s": [20, 900]
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

create or replace function public.delete_point(p_point uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_game uuid;
begin
  select game_id into v_game from public.points where id = p_point;
  if not found then raise exception 'point_not_found'; end if;
  perform public.assert_host_lobby(v_game);
  delete from public.points where id = p_point;
end;
$$;

-- For Mr. X's "caught" dialog: detectives, nearby (within proximity_m) first. No coordinates.
create or replace function public.catch_candidates(p_game uuid)
returns table (player_id uuid, name text, nearby boolean)
language sql stable security definer set search_path = '' as $$
  select d.id, d.name,
    coalesce(extensions.st_dwithin(
      extensions.st_setsrid(extensions.st_makepoint(ld.lng, ld.lat), 4326)::extensions.geography,
      extensions.st_setsrid(extensions.st_makepoint(lx.lng, lx.lat), 4326)::extensions.geography,
      (g.config->>'proximity_m')::int), false) as nearby
  from public.games g
  join public.players x on x.game_id = g.id and x.role = 'mrx' and x.user_id = auth.uid()
  join public.players d on d.game_id = g.id and d.role = 'detective'
  left join public.live_positions ld on ld.player_id = d.id
  left join public.live_positions lx on lx.player_id = x.id
  where g.id = p_game
  order by nearby desc, extensions.st_distance(
      extensions.st_setsrid(extensions.st_makepoint(ld.lng, ld.lat), 4326)::extensions.geography,
      extensions.st_setsrid(extensions.st_makepoint(lx.lng, lx.lat), 4326)::extensions.geography) nulls last, d.name
$$;

create or replace function public.confirm_catch(p_game uuid, p_detective uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.players where game_id = p_game and user_id = auth.uid() and role = 'mrx') then
    raise exception 'not_mrx';
  end if;
  if not exists (select 1 from public.players where id = p_detective and game_id = p_game and role = 'detective') then
    raise exception 'player_not_found';
  end if;
  if not exists (select 1 from public.games where id = p_game and status = 'running') then
    raise exception 'game_not_running';
  end if;
  perform public.finish_game(p_game, 'detectives', p_detective);
end;
$$;

revoke execute on function public.emit(uuid, uuid, text, jsonb), public.emit_role(uuid, text, text, jsonb),
  public.finish_game(uuid, text, uuid), public.make_reveal(uuid, uuid, text, boolean),
  public.process_report(uuid, uuid, jsonb)
  from public, anon, authenticated;
revoke execute on function public.set_options(uuid, jsonb), public.delete_point(uuid),
  public.catch_candidates(uuid), public.confirm_catch(uuid, uuid) from public, anon;
grant execute on function public.set_options(uuid, jsonb), public.delete_point(uuid),
  public.catch_candidates(uuid), public.confirm_catch(uuid, uuid) to authenticated;
grant execute on function public.process_report(uuid, uuid, jsonb) to service_role;

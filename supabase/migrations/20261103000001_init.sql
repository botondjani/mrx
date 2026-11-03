-- Phase 1: core schema for the GPS hide-and-seek game.
-- All game logic lives server-side. Clients read via RLS-filtered selects/Realtime
-- and write only through RPCs (lobby) and the report_position Edge Function.

create extension if not exists postgis with schema extensions;

-- ---------------------------------------------------------------------------
-- Config: every timing/radius/item comes from games.config (seeded from here).
-- ---------------------------------------------------------------------------
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
    'position_retention_h', 24
  )
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.games (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  mode text not null default 'mrx',
  status text not null default 'lobby' check (status in ('lobby', 'running', 'finished')),
  host_user_id uuid not null references auth.users (id) on delete cascade,
  center_lat double precision,
  center_lng double precision,
  center extensions.geography(Point, 4326) generated always as (
    case when center_lat is null or center_lng is null then null
    else extensions.st_setsrid(extensions.st_makepoint(center_lng, center_lat), 4326)::extensions.geography end
  ) stored,
  radius_m integer,
  config jsonb not null default public.default_game_config(),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  ends_at timestamptz,
  finished_at timestamptz
);

create table public.players (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 24),
  role text check (role in ('mrx', 'detective')),
  is_host boolean not null default false,
  joined_at timestamptz not null default now(),
  unique (game_id, user_id)
);
create index players_user_idx on public.players (user_id);

-- Full position history. Never readable by clients.
create table public.positions (
  id bigint generated always as identity primary key,
  game_id uuid not null references public.games (id) on delete cascade,
  player_id uuid not null references public.players (id) on delete cascade,
  lat double precision not null,
  lng double precision not null,
  geom extensions.geography(Point, 4326) generated always as (
    extensions.st_setsrid(extensions.st_makepoint(lng, lat), 4326)::extensions.geography
  ) stored,
  accuracy_m real,
  speed_mps real,
  heading real,
  recorded_at timestamptz not null,
  received_at timestamptz not null default now()
);
create index positions_game_player_time_idx on public.positions (game_id, player_id, recorded_at);

-- Latest position per player; clients subscribe to it via Realtime (RLS-filtered).
create table public.live_positions (
  player_id uuid primary key references public.players (id) on delete cascade,
  game_id uuid not null references public.games (id) on delete cascade,
  role text,
  lat double precision not null,
  lng double precision not null,
  accuracy_m real,
  heading real,
  speed_mps real,
  updated_at timestamptz not null default now()
);
create index live_positions_game_idx on public.live_positions (game_id);

-- Mr. X reveals (phase 2 fills it).
create table public.reveals (
  id bigint generated always as identity primary key,
  game_id uuid not null references public.games (id) on delete cascade,
  player_id uuid not null references public.players (id) on delete cascade,
  lat double precision not null,
  lng double precision not null,
  heading real,
  kind text not null default 'scheduled',
  revealed_at timestamptz not null default now()
);
create index reveals_game_idx on public.reveals (game_id, revealed_at);

-- Power-up points (phase 2/3).
create table public.points (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  name text,
  kind text,
  osm_id text,
  lat double precision not null,
  lng double precision not null,
  geom extensions.geography(Point, 4326) generated always as (
    extensions.st_setsrid(extensions.st_makepoint(lng, lat), 4326)::extensions.geography
  ) stored,
  active_after timestamptz
);
create index points_game_idx on public.points (game_id);

-- Items held by players (phase 3).
create table public.items (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  player_id uuid not null references public.players (id) on delete cascade,
  kind text not null,
  picked_at timestamptz not null default now(),
  used_at timestamptz
);
create index items_player_idx on public.items (player_id);

-- ---------------------------------------------------------------------------
-- RLS helpers (security definer to avoid policy recursion on players)
-- ---------------------------------------------------------------------------
create or replace function public.my_role(p_game uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(role, 'none') from public.players
  where game_id = p_game and user_id = auth.uid()
$$;

create or replace function public.is_member(p_game uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.players where game_id = p_game and user_id = auth.uid())
$$;

-- ---------------------------------------------------------------------------
-- RLS: read-only policies; all writes go through RPCs / Edge Functions.
-- ---------------------------------------------------------------------------
alter table public.games enable row level security;
alter table public.players enable row level security;
alter table public.positions enable row level security;
alter table public.live_positions enable row level security;
alter table public.reveals enable row level security;
alter table public.points enable row level security;
alter table public.items enable row level security;

create policy games_select on public.games for select to authenticated
  using (public.is_member(id));

create policy players_select on public.players for select to authenticated
  using (public.is_member(game_id));

-- positions: no policies => no client access.

-- Own row always; detectives see detectives. Mr. X sees nobody live.
create policy live_positions_select on public.live_positions for select to authenticated
  using (
    exists (select 1 from public.players p where p.id = player_id and p.user_id = auth.uid())
    or (role = 'detective' and public.my_role(game_id) = 'detective')
  );

create policy reveals_select on public.reveals for select to authenticated
  using (public.is_member(game_id));

create policy points_select on public.points for select to authenticated
  using (public.is_member(game_id));

create policy items_select on public.items for select to authenticated
  using (exists (select 1 from public.players p where p.id = player_id and p.user_id = auth.uid()));

-- ---------------------------------------------------------------------------
-- Lobby RPCs
-- ---------------------------------------------------------------------------
create or replace function public.create_game(p_name text)
returns public.games
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text;
  v_game public.games;
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  loop
    select string_agg(substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1), '')
      into v_code from generate_series(1, 6);
    exit when not exists (select 1 from public.games where code = v_code);
  end loop;

  insert into public.games (code, host_user_id) values (v_code, auth.uid()) returning * into v_game;
  update public.games set radius_m = (config->>'radius_default_m')::int where id = v_game.id
    returning * into v_game;
  insert into public.players (game_id, user_id, name, is_host) values (v_game.id, auth.uid(), trim(p_name), true);
  return v_game;
end;
$$;

create or replace function public.join_game(p_code text, p_name text)
returns public.games
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_game public.games;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select * into v_game from public.games where code = upper(trim(p_code));
  if not found then raise exception 'game_not_found'; end if;
  if exists (select 1 from public.players where game_id = v_game.id and user_id = auth.uid()) then
    return v_game; -- rejoin
  end if;
  if v_game.status <> 'lobby' then raise exception 'game_already_started'; end if;
  if (select count(*) from public.players where game_id = v_game.id) >= (v_game.config->>'max_players')::int then
    raise exception 'game_full';
  end if;
  insert into public.players (game_id, user_id, name) values (v_game.id, auth.uid(), trim(p_name));
  return v_game;
end;
$$;

create or replace function public.assert_host_lobby(p_game uuid)
returns public.games
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_game public.games;
begin
  select * into v_game from public.games where id = p_game for update;
  if not found then raise exception 'game_not_found'; end if;
  if v_game.host_user_id is distinct from auth.uid() then raise exception 'not_host'; end if;
  if v_game.status <> 'lobby' then raise exception 'game_already_started'; end if;
  return v_game;
end;
$$;

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
  update public.games set center_lat = p_lat, center_lng = p_lng, radius_m = p_radius_m where id = p_game;
end;
$$;

-- p_mrx_player null => random draw.
create or replace function public.assign_roles(p_game uuid, p_mrx_player uuid default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mrx uuid := p_mrx_player;
begin
  perform public.assert_host_lobby(p_game);
  if v_mrx is null then
    select id into v_mrx from public.players where game_id = p_game order by random() limit 1;
  elsif not exists (select 1 from public.players where id = v_mrx and game_id = p_game) then
    raise exception 'player_not_found';
  end if;
  update public.players set role = case when id = v_mrx then 'mrx' else 'detective' end where game_id = p_game;
end;
$$;

create or replace function public.start_game(p_game uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_game public.games := public.assert_host_lobby(p_game);
  v_count int;
begin
  select count(*) into v_count from public.players where game_id = p_game;
  if v_count < (v_game.config->>'min_players')::int then raise exception 'not_enough_players'; end if;
  if v_game.center_lat is null or v_game.radius_m is null then raise exception 'area_not_set'; end if;
  if (select count(*) from public.players where game_id = p_game and role = 'mrx') <> 1
     or exists (select 1 from public.players where game_id = p_game and role is null) then
    raise exception 'roles_not_assigned';
  end if;
  update public.games set
    status = 'running',
    started_at = now(),
    ends_at = now() + make_interval(secs => (config->>'head_start_s')::int + (config->>'duration_min')::int * 60)
  where id = p_game;
end;
$$;

revoke execute on function public.create_game(text), public.join_game(text, text),
  public.assert_host_lobby(uuid), public.set_area(uuid, double precision, double precision, integer),
  public.assign_roles(uuid, uuid), public.start_game(uuid),
  public.my_role(uuid), public.is_member(uuid)
  from public, anon;
grant execute on function public.create_game(text), public.join_game(text, text),
  public.set_area(uuid, double precision, double precision, integer),
  public.assign_roles(uuid, uuid), public.start_game(uuid),
  public.my_role(uuid), public.is_member(uuid)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table public.games, public.players, public.live_positions;

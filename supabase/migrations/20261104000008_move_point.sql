-- Host drags a power-up point on the map (lobby only). Any spot inside the original area is
-- allowed (water too); spacing is the host's call.
create or replace function public.move_point(p_point uuid, p_lat double precision, p_lng double precision)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_game public.games;
begin
  select g.* into v_game from public.games g join public.points p on p.game_id = g.id where p.id = p_point;
  if not found then raise exception 'point_not_found'; end if;
  perform public.assert_host_lobby(v_game.id);
  if not extensions.st_dwithin(v_game.center,
       extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography, v_game.radius_m) then
    raise exception 'point_outside_area';
  end if;
  update public.points set lat = p_lat, lng = p_lng where id = p_point;
end;
$$;

revoke execute on function public.move_point(uuid, double precision, double precision) from public, anon;
grant execute on function public.move_point(uuid, double precision, double precision) to authenticated;

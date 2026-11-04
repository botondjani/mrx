-- Phase 3: position retention (pg_cron).

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

revoke execute on function public.purge_positions() from public, anon, authenticated;

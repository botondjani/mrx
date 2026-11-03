-- assert_host_lobby is an internal helper; Supabase default privileges grant it to authenticated.
revoke execute on function public.assert_host_lobby(uuid) from authenticated;

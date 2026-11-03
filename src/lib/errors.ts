const MESSAGES: Record<string, string> = {
  game_not_found: 'Nincs ilyen kódú játék.',
  game_already_started: 'A játék már elindult.',
  game_full: 'A játék megtelt.',
  not_host: 'Ezt csak a házigazda teheti meg.',
  invalid_radius: 'A sugár 0,5 és 2 km között lehet.',
  not_enough_players: 'Legalább 4 játékos kell az indításhoz.',
  area_not_set: 'Előbb jelöld ki a pályát.',
  roles_not_assigned: 'Előbb oszd ki a szerepeket.',
  player_not_found: 'Nincs ilyen játékos.',
  invalid_option: 'Érvénytelen beállítás.',
  point_not_found: 'Nincs ilyen pont.',
  not_mrx: 'Ezt csak Mr. X teheti meg.',
  game_not_running: 'A játék nem fut.',
  overpass_: 'Az OpenStreetMap-szolgáltatás most nem érhető el, próbáld újra később.',
};

export function huError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String((e as any)?.message ?? e);
  const key = Object.keys(MESSAGES).find((k) => msg.includes(k));
  return key ? MESSAGES[key] : `Hiba történt: ${msg}`;
}

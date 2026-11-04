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
  powerups_disabled: 'Ebben a játékban nincsenek power-upok.',
  point_outside_area: 'A pont csak a körön belülre kerülhet.',
  not_mrx: 'Ezt csak Mr. X teheti meg.',
  game_not_running: 'A játék nem fut.',
  game_not_finished: 'A játék még nem ért véget.',
  out_of_bounds: 'Pályán kívül nem vehetsz fel tárgyat.',
  point_cooldown: 'Ez a pont még töltődik.',
  inventory_full: 'Egyszerre legfeljebb 2 tárgyad lehet.',
  no_position: 'Még nincs friss GPS-pozíciód.',
  too_far: 'Túl messze vagy a ponttól (25 m-en belül kell lenned).',
  item_not_found: 'Ez a tárgy már nem használható.',
  head_start: 'Az előny alatt nem használhatsz tárgyat.',
  no_items_for_role: 'Ebben a játékban a te szerepednek nincs engedélyezett tárgya.',
  decoy_too_far: 'A csali legfeljebb 300 m-re lehet tőled.',
};

export function huError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String((e as any)?.message ?? e);
  const key = Object.keys(MESSAGES).find((k) => msg.includes(k));
  return key ? MESSAGES[key] : `Hiba történt: ${msg}`;
}

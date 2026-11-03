# CLAUDE.md – projektállapot és döntések

Lásd még: `AGENTS.md` (Expo-szabályok), `README.md` (build, bot, tesztek).
Specifikáció: a master prompt (3 fázis). Kód/kommentek angolul, UI magyarul.

## Infrastruktúra
- Supabase projekt: `mrx` (`puionefgssztaoyugxks`, eu-central-1). Migrációk: `supabase/migrations`.
- Expo SDK 58, expo-router (`src/app`), EAS Build (`eas.json`: `development`, `preview` → APK).
- Env: `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_KEY` (publishable), `EXPO_PUBLIC_MAPTILER_KEY`.
  Lokálisan `.env` (gitignored), buildhez EAS environment variables.
- Android package: `com.botondjani.mrx`.

## Architektúra-döntések
- Azonosítás: Supabase anonymous sign-in; RLS az `auth.uid()`-re épül.
- Minden írás szerveren: lobby = Postgres RPC-k (security definer), pozíció = `report_position` Edge Function.
  (Kompromisszum: RPC = kevesebb kód, de a logika egy része SQL-ben él.)
- `positions`: teljes előzmény, kliens NEM olvashatja (RLS, nincs policy).
- `live_positions`: játékosonként 1 sor, Realtime-on megy a kliensekhez, RLS szűri szerep szerint
  (1. fázis: detektív → detektívek; Mr. X → csak saját maga).
- Minden időzítés/sugár/tárgy: `games.config` (alap: `default_game_config()`), módfüggetlen `games.mode`.
- Háttér-követés: `expo-location` `startLocationUpdatesAsync` foreground service-szel (`src/lib/tracking.ts`),
  a task `index.ts`-ben töltődik be az expo-router előtt. Eszközoldali napló: „Napló” képernyő.
- Lat/lng double oszlopok + generált PostGIS `geography` oszlop (egyszerű Realtime payload, PostGIS a számításokhoz).
- `assert_host_lobby` belső helper, authenticated-től visszavonva.
- `pg_cron` csak a 3. fázisban kerül be (pozíciótörlés).

## Állapot
- 1. fázis: kód kész; valós eszközös teszt (2 telefon, lezárt képernyő) folyamatban.
- Ismert MVP-egyszerűsítés: a kliens Realtime eseményre újratölti a táblát (egyszerű, RLS-helyes; 12 játékosig elég).

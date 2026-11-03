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

### 2. fázis
- Játéklogika: `public.process_report()` (plpgsql, a `games` sor zárolva, egy tranzakció), a `report_position`
  csak hitelesít és ezt hívja. Csak a service role futtathatja.
  Minden jelentésnél: előny vége, felfedés (`next_reveal_at`, utolsó `endgame_s`-ben gyorsabb), pályahatár
  (`out_since`, Mr. X-nél türelmi idő után `penalty_until` → minden Mr. X-jelentés `penalty` felfedés),
  sebességfigyelés (ha tilos a tömegközlekedés), előny alatti 100 m, közelség (50 m, 30 s ismétlés),
  gyors mód (150 m → 3 s), Mr. X-pillanatkép a detektívekről (`detective_snapshots`), időlejárat → játék vége.
  Az idő csak jelentésekkor halad (ha senki nem jelent, a játék nem zárul le – a kliens maga is számol).
- Események: `events` tábla címzettenként; a `report_position` válasza kézbesíti (→ lokális értesítés + rezgés).
- Kezdőpont = a pálya középpontja (feltételezés).
- Kliens: a GPS mindig a gyors (3 s) ütemben fut, a küldést a szerver `next_interval_ms`-e szabályozza
  (Android 12+ háttérből nem indítható újra a foreground service). Kompromisszum: valamivel több akku.
- Elkapás: `catch_candidates` (csak nevek + „közel” jelző, koordináta nélkül) és `confirm_catch` (csak Mr. X).
- Host-beállítások: `set_options` (whitelist + tartományok), játékidő 45/60/90 perc, tömegközlekedés.
- Power-up pontok: `generate_points` Edge Function. A nyilvános Overpass-szerverek a felhős IP-ket
  elutasítják (406 / timeout a Supabase Edge-ről), ezért a host telefonja futtatja a lekérdezést
  (`need_overpass` → kliens lekér → elküldi), a szerver válogat (≥150 m, max 12) és cache-el (7 nap).
- Tesztek: `scripts/rls-test.mjs`, `scripts/visibility-test.mjs` (minden kliensforgalom rögzítése,
  Mr. X koordináta csak felfedésként; Mr. X detektív-koordinátát csak pillanatképként kap).
- `overpass_probe` Edge Function: kivezetett diagnosztika (410-et ad), a dashboardon törölhető.

## Állapot
- 1. fázis: kód kész, szerveroldal ellenőrizve; valós eszközös teszt (2 telefon, lezárt képernyő) még hátra.
- 2. fázis: kód kész, botokkal és láthatósági teszttel ellenőrizve; valós 2 telefonos teszt hátra.
- Ismert MVP-egyszerűsítés: a kliens Realtime eseményre újratölti a táblát (egyszerű, RLS-helyes; 12 játékosig elég).

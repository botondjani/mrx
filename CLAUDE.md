# CLAUDE.md – projektállapot és döntések

Lásd még: `AGENTS.md` (Expo-szabályok), `README.md` (build, bot, tesztek).
Specifikáció: a master prompt (3 fázis). Kód/kommentek angolul, UI magyarul.

## Infrastruktúra
- Supabase projekt: `mrx` (`puionefgssztaoyugxks`, eu-central-1). Migrációk: `supabase/migrations`.
- Expo SDK 58, expo-router (`src/app`), EAS Build (`eas.json`: `development`, `preview` → APK).
- Env: `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_KEY` (publishable). (`EXPO_PUBLIC_MAPTILER_KEY` már nem kell.)
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

### 3. fázis
- Power-upok: `pickup_point` (szerver ellenőrzi: 25 m a szerver szerinti élő pozíciótól, pont-cooldown,
  max 2 tárgy, kint lévő detektív nem vehet fel), `use_item`. Radar = azonnali felfedés; Nyomkövető =
  `tracker_until`, Mr. X minden jelentése `tracker` felfedés; Csali = `decoy_lat/lng` (300 m), a következő
  scheduled/radar felfedés ezt mutatja ugyanazzal a `kind`-dal (a detektív nem tudja megkülönböztetni);
  Köd = `fog_pending`, a következő scheduled/radar felfedés elmarad (`reveal_fogged` esemény).
- GPS-szűrés a szerveren: `gps_max_accuracy_m` (50) és ugrásszűrés `gps_max_speed_kmh` (150) az utolsó
  elfogadott pozícióhoz képest (önjavító: a megengedett táv az eltelt idővel nő). Válasz: `gps_filtered`.
- `process_report` a `default_game_config() || config` összevonással olvassa a beállításokat, így az új
  kulcsok régi játékoknál is működnek (nem kell meglévő sorokat módosítani).
- Statisztika `game_stats`, visszajátszás `game_replay` (5 s-os mintavétel), `save_replay` (csak host),
  csak befejezett játéknál és csak tagoknak.
- Törlés: `purge_positions()` pg_cron-nal óránként (`17 * * * *`): `position_retention_h` után a
  pozíciók/felfedések/pillanatképek/események törlődnek, kivéve `replay_saved`; félbehagyott játék 24 h után.
- Kliens: „Nincs kapcsolat” sáv (30 s sikertelen küldés), akkumulátormérés (indulás → játék vége, a Naplóban
  5 percenként), `TELEPITES.md` a barátoknak.
- A Supabase MCP `apply_migration` jóváhagyást kér adatmódosító/törlő utasításnál, ami a felhasználónál nem
  jelent meg → a migrációkat úgy bontottuk, hogy ne módosítsanak meglévő sorokat.

### Térkép
- A MapLibre Native (v11) a teszttelefonon csak fekete felületet rajzolt (TextureView-val is), ezért
  lecseréltük: `GameMap` = Leaflet 1.9.4 WebView-ban (`react-native-webview`), OpenStreetMap-csempékkel
  (a felhasználó kérésére; az OSM tile policy csak kis forgalmat enged – nagyobb közönségnél más szolgáltató kell),
  noir hatás CSS-szűrővel. Az állapot JSON-ként megy be (`injectJavaScript`), a koppintás `postMessage`-dzsel jön ki.
- `app.json` version 0.2.0 (új natív modul → új runtime; a 0.1.0-s APK-k nem kapnak több frissítést).
- Dizájn: noir téma (`src/components/ui.tsx` `C` színek, Special Elite betű), Mr. X = bíbor, detektív = arany.

### Szűkülő kör, pontok (2026-11-04)
- `zone_final_pct` (100 = nincs, 75/50/25 a lobbyban): a kör lineárisan szűkül az előny végétől a játék végéig,
  `public.zone_radius(game, t)` (szerver) = `zoneRadius()` (`src/lib/geo.ts`, kliens). A pályahatár-ellenőrzés
  és a büntetés az aktuális kört nézi; a power-up pontok az eredeti körben maradnak (térképen halvány eredeti kör).
- `generate_points`: a telefon több Overpass-tükröt próbál (User-Agenttel, 20 s timeout); ha egyik sem válaszol,
  `{ random: true }` → véletlen „Rejtekhely N” pontok a körben (≥150 m, max 12).
- Lobby: előnézeti térkép (kör + pontok), görgethető.

### Gyors frissítés (EAS Update)
- `expo-updates`, `runtimeVersion: appVersion`, csatorna: `preview` (eas.json). Csak JS-változás:
  `npx eas-cli@latest update --channel preview --message "..."` → a telefonok induláskor letöltik.
- Natív változás (új natív csomag, engedély, app.json plugin) → `version` emelése + új APK-build.

## Állapot
- 1. fázis: kód kész, szerveroldal ellenőrizve; valós eszközös teszt (2 telefon, lezárt képernyő) még hátra.
- 2. fázis: kód kész, botokkal és láthatósági teszttel ellenőrizve; valós 2 telefonos teszt hátra.
- 3. fázis: kód kész, `powerups-test.mjs` + korábbi tesztek zöldek; valós 3 telefonos, 30 perces teszt és
  akkumérés hátra.
- Hiba volt (javítva): azonos nevű Realtime-csatorna két képernyőn (pl. lobby + pálya) → a realtime-js a
  meglévő csatornát adja vissza, az újabb `.on()` kivételt dob → képernyő-összeomlás (sötét üres képernyő).
  Javítás: egyedi csatornanév hook-példányonként; `ErrorBoundary` a `_layout.tsx`-ben.
- Ismert MVP-egyszerűsítés: a kliens Realtime eseményre újratölti a táblát (egyszerű, RLS-helyes; 12 játékosig elég).

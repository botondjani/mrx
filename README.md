# Mr. X – városi GPS-bújócska (Android MVP)

Expo (React Native, TypeScript) + Supabase (Postgres/PostGIS, Realtime, Edge Functions, RLS) + MapLibre/MapTiler.

## Beállítás

```bash
npm ci
cp .env.example .env   # töltsd ki: Supabase URL + publishable key, MapTiler kulcs
```

## APK buildelése (EAS, felhőben – nem kell Android Studio)

Egyszeri lépések:

```bash
npx eas-cli@latest login
npx eas-cli@latest init          # összeköti a projektet az Expo-fiókoddal
```

A `.env` nem kerül fel a buildbe, ezért a változókat az EAS-ben kell megadni (egyszer):

```bash
for E in development preview; do
  npx eas-cli@latest env:create --environment $E --visibility plaintext --name EXPO_PUBLIC_SUPABASE_URL --value "https://puionefgssztaoyugxks.supabase.co"
  npx eas-cli@latest env:create --environment $E --visibility plaintext --name EXPO_PUBLIC_SUPABASE_KEY --value "<publishable key>"
  npx eas-cli@latest env:create --environment $E --visibility plaintext --name EXPO_PUBLIC_MAPTILER_KEY --value "<maptiler kulcs>"
done
```

Build:

```bash
npx eas-cli@latest build -p android --profile preview       # önálló APK, ezt telepítsd a telefonokra
npx eas-cli@latest build -p android --profile development   # dev build (Metro szerverrel, fejlesztéshez)
```

A build végén kapott linket nyisd meg a telefonon, töltsd le és telepítsd az APK-t
(engedélyezni kell az „ismeretlen forrásból” telepítést).

## Bot-szimulátor

```bash
# Csatlakozás egy meglévő lobbyhoz (a házigazda a telefonon oszt szerepet és indít):
npm run bots -- --code ABC123 --n 3 --speed 5
# Teljesen botok által futtatott játék, 60 s várakozással, hogy emberek is beléphessenek:
npm run bots -- --create --lat 47.4979 --lng 19.0402 --radius 1000 --n 4 --mrx 0 --speed 5 --start-after 60
# Rövidített teljes játék (10 perc, 60 s előny); a detektív botok az utolsó felfedést üldözik:
npm run bots -- --create --lat 47.4979 --lng 19.0402 --n 5 --mrx 0 --duration 10 --head-start 60
```

## Tesztek

```bash
npm run typecheck
node --env-file=.env scripts/rls-test.mjs          # a detektív soha nem kapja meg Mr. X élő pozícióját
node --env-file=.env scripts/visibility-test.mjs   # teljes rövid játék: Mr. X pozíciója csak felfedésként jut el
```

## Supabase

- Migrációk: `supabase/migrations/` (az `mrx` projekten alkalmazva).
- Edge Functions: `supabase/functions/report_position/`, `supabase/functions/generate_points/`.
- Anonymous sign-in bekapcsolva kell legyen (Authentication → Sign In / Providers).

# Homemade Food App

A local marketplace where home cooks run their own mini food shop. This repo is
the starting point: a React + Vite + TypeScript web app that installs like a
phone app (PWA) and stores its data in Supabase. The build follows the
Technical V1 Blueprint. It is set up so it can later be wrapped for
iOS and Android with Capacitor.

## Where things live

- **Website:** https://food.beastcase.net, deployed by Netlify (site
  `beastcase-food`) every time `main` changes. Build settings are in
  `netlify.toml`; Netlify holds `VITE_SUPABASE_URL` and the publishable
  `VITE_SUPABASE_ANON_KEY`.
- **Database:** a dedicated Supabase project (free "Food App" organization,
  London). App tables live in the `food` schema, which is exposed in the Data
  API. Every table has row level security.

## Database changes

Database changes are SQL files in `supabase/migrations`, applied in name order.
When a change to that folder lands on `main`, the *Database migrations* GitHub
Action runs `scripts/migrate.sh`, which applies each new file once inside a
transaction and records it in `ops.applied_migrations`.

The action needs one repository secret, `SUPABASE_DB_URL`: the *Session pooler*
connection string from Supabase (*Connect* button at the top of the project),
with the database password filled in. Until it is set, the action skips.

Never put the Supabase secret / service_role key in the app or in Netlify.

## Running it on your computer

```sh
npm install
cp .env.example .env.local   # then fill in the two values
npm run dev
```

## Later: phone apps

```sh
npm install @capacitor/ios @capacitor/android
npm run build
npx cap add ios
npx cap add android
```

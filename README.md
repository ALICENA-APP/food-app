# Homemade Food App

A local marketplace where home cooks run their own mini food shop. This repo is
the starting point: a React + Vite + TypeScript web app that installs like a
phone app (PWA) and stores its data in Supabase. The build follows the
Technical V1 Blueprint. It is set up so it can later be wrapped for
iOS and Android with Capacitor.

## Where the data lives

The app uses one of your existing Supabase projects, in its own schema called
`food`. That keeps its tables apart from your other app and costs nothing extra.

## One-time setup

1. **Create the tables.** In Supabase, open *SQL Editor*, paste the contents of
   `supabase/migrations/0001_foundation.sql`, and click *Run*.
2. **Let the app see the `food` schema.** In Supabase, go to
   *Project Settings > Data API* (or *API*), find *Exposed schemas*, add `food`,
   and save.

   Keep using Stripe test mode in this shared project. Before taking real
   payments, move the app to its own Supabase project (see the blueprint).
3. **Allow sign-in links back to your site.** In *Authentication > URL
   Configuration*, add your Netlify address (for example
   `https://food-app.netlify.app`) to *Redirect URLs*.
4. **Deploy on Netlify.** *Add new site > Import an existing project*, pick the
   `food-app` GitHub repo. Build settings come from `netlify.toml`.
5. **Add the two keys on Netlify.** *Site configuration > Environment variables*:
   - `VITE_SUPABASE_URL` = your project URL (Supabase *Project Settings > API*)
   - `VITE_SUPABASE_ANON_KEY` = the `anon` / publishable key from the same page

   Then redeploy.

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

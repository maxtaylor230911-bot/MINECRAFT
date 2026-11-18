# Voxelcraft

An original browser voxel sandbox: infinite procedurally generated worlds,
mining and building, a day/night cycle, survival and creative modes, and
touch controls for iPad/iPhone. Built with Next.js, React, three.js and zustand.

## Run locally

```bash
npm install
npm run dev
```

Then open http://localhost:3000.

## Deploy

Import this repository into [Vercel](https://vercel.com) and click **Deploy**.
No settings need changing because Vercel detects Next.js on its own.

## Project layout

- `src/game/` holds the engine: renderer, world worker (terrain, lighting,
  meshing), player physics, sky, particles, sound and item drops
- `src/components/game/` holds the React UI: title and menus, HUD, options
  and touch controls
- `src/state/gameStore.ts` holds settings, UI state and world saves (in
  localStorage)

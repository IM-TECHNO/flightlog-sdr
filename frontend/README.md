# flightlog-sdr web app

The Next.js front end for [flightlog-sdr](../README.md): a 3D globe (CesiumJS) with live traffic, history, stats, alerts, receiver gain and projector mode. It talks to the FastAPI backend in `../backend`.

```bash
npm install
npm run dev        # http://localhost:3000
npm run build && npm start
```

`predev` and `prebuild` copy Cesium's runtime assets into `public/cesium` (git-ignored). The API address defaults to the host the page was opened from on port 8000; see `.env.example`.

## Layout

| Path | What is in it |
|---|---|
| `src/app/page.tsx` | the page: tabs, live feed, alerts, projector mode, URL state |
| `src/app/models/[shape]/[file]/route.ts` | generates aircraft glTF models on request |
| `src/components/map/` | `MapView` (Cesium), layer bar, map-style switch |
| `src/components/panels/` | live, history, stats, receiver, alerts and flight-card panels |
| `src/lib/` | API client, formatting, units, liveries, aircraft types, model generator, floating-tag layout |
| `public/geo/` | bundled map data for projector mode (`node scripts/make-geo.mjs` regenerates it) |

```bash
npx tsc --noEmit && npx eslint src
```

This project uses a recent Next.js with breaking changes from older versions; see `AGENTS.md` before changing framework-level code.

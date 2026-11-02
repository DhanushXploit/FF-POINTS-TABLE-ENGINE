# Points Table Engine — standalone (Vercel) copy

A single static app in `public/` (`index.html` + `scoring.js`). No build step, no CDN dependencies.

## Deploy
Deploy this folder to Vercel as a static project (`vercel.json` sets the output directory to `public`), or serve `public/` with any static host.

## How it works
- **Data:** first load seeds the FFISCIRMS tournament (Free Fire India, Squad — 11 teams, Match 1 confirmed) from the seed embedded in `index.html` (source record: `seed-data.json` in this folder). After that, all data lives in the browser's `localStorage` under `pte-v1-data`. Use **JSON backup** (Table tab) to export/import and move between devices. Settings has **Reset to seeded data**.
- **Passcode:** on first use you set an admin passcode (min 4 chars). Only its SHA-256 hash is stored — this is honestly a *device passcode for this browser copy*, not an online account. Viewing the points table needs no login; creating/editing does. Login sessions live in `sessionStorage` + in-memory. Change the passcode in a tournament's Settings tab (current passcode required).
- **Scoring:** 1 pt per kill. Squad placements 12,9,8,7,6,5,4,3,2,1,0,0; Duo 24→0; Solo uses the full 48-place table from the original spec. Editable per tournament in Settings. The points table is always ordered by total points (then kills, then Booyahs), never slot order, and can be downloaded as a PNG poster (Table tab) or CSV.
- **Registry import format:** one team per line — `Team Name | player1, player2, player3, player4`.
- **Screenshots:** a result screenshot can be attached to a match and is stored with it for reference, but this standalone copy has **no vision API key and does not read screenshots automatically** — results are entered via Manual Entry (By placement / By team) and the shared Review → Confirm step. Automatic reading remains available in the Muse app.
- **Verify scoring:** `node test-scoring.mjs` asserts the seeded Match 1 totals and standings order (REVEN ES 20 … BLOOD PRONE 0).

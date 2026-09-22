# Frontier

A browser-based, real-time (not turn-based) territory-strategy game built on the mechanics of
[OpenFront.io](https://github.com/openfrontio/OpenFrontIO): claim a spot on a world map, expand
tile by tile, and try to hold 80% of the land. Overreach and you run out of troops; sit still and
your neighbours swallow you. Play with friends online against dozens of AI nations and bot tribes.

Frontier reuses OpenFront's real map data, unit sprites and UI icons (CC BY‑SA 4.0) and reproduces
its balance — the troop-growth curve, the per-tile attack cost/speed formula, unit prices, trade
income, difficulty scaling — in an original, from-scratch codebase. No build step, no framework:
Node.js + `ws` on the server, a plain HTML5 canvas on the client.

## Quick start

```bash
npm install
npm start
```

Open <http://localhost:3000>, pick a name, **Create game**, choose a map, **Start game**.

## How to play

* **Spawn** — during the spawn phase, click on land to claim your starting spot. Re-click to move it
  until the timer runs out.
* **Expand / attack** — **left-click** any land you don't own. Neutral land is cheap to take;
  attacking a player costs troops on both sides and depends on troop density, terrain and defenses.
  The **attack ratio** (slider, number keys, or **Shift**+scroll) sets how many troops each click
  commits. Push too fast and you'll bleed out — let troops regrow between attacks. If a target isn't
  reachable by land, a transport boat is sent automatically.
* **Right-click** opens a **radial menu**: Build, Boat, Alliance / Donate / Break, and Info. Build
  again from the wrench for the full structure ring.
* **Build** (keys **1‑7** or the bottom bar, then click a tile):
  * **City** — +250K max troops. Build on it again to upgrade.
  * **Port** — sea coast only. Sends trade ships to other players' ports; both sides earn gold.
  * **Defense Post** — attackers within 30 tiles lose 5× troops and move 3× slower.
  * **Missile Silo** — launches atom / hydrogen bombs (90-tick reload).
  * **SAM Launcher** — shoots down incoming nukes within 70 tiles.
* **Alliances** — request from a player's radial or the leaderboard. Allies can't attack each other
  and can donate troops/gold. Breaking one marks you a **traitor** for 30s (weaker defense). Nuking
  an ally breaks the alliance.
* **Win** by owning 80% of the land (configurable). Any player squeezed under 100 tiles is
  conquered outright — the attacker takes their land and half their gold.

**Keys:** `A` attack under cursor · `B` boat under cursor · `R` retaliate against your latest
attacker · `C` centre on your territory · `1‑7` build · `[` `]` or Shift+scroll attack ratio ·
`Enter` chat · `Esc` close · drag / wheel to pan & zoom.

## Maps

Frontier ships five OpenFront maps (World, Europe, Asia, Oceania, Pangaea) and can download ~35
more on demand (Africa, the Americas, individual countries, Mars, Luna, …) — they're cached to
`server/maps-cache/` after first use. Each real map places its actual nations (with country flags)
where they belong. There are also three procedurally generated map types (Continents, Islands,
Pangaea) with a seed, for a fresh layout every game. **Compact** map size runs the half-resolution
version for weaker machines or bigger lobbies.

## Multiplayer

The host runs the server; everyone else just opens a URL — no install. Three ways to be reachable:

1. **Same Wi-Fi** — `npm start` prints your LAN address (e.g. `http://192.168.1.42:3000`). Friends
   open it; you Create a game and share the code or **Copy invite link** (`…/g/ABCDE`). Allow
   Node.js through Windows Firewall the first time.
2. **Over the internet, no router setup** — in a second terminal:
   `npx cloudflared tunnel --url http://localhost:3000` prints a public `https://…trycloudflare.com`
   URL anyone can open. ngrok / Tailscale work the same way.
3. **Host it on a website (permanent URL)** — see below.

**How it works:** the server is authoritative — it runs the whole 10-ticks-per-second simulation and
is the only place game state lives, so nothing can be cheated from the page. Clients send *intents*
("attack this tile with 20%", "build a city here") and receive small per-tick deltas (which tiles
changed owner, plus stats every half-second). A full snapshot is sent only when you join or
reconnect. Reconnecting keeps your seat (a per-tab token); while you're gone your nation keeps
running. The host can pause, change speed, or end the game for everyone.

## Host it on a website

The server is one Node process that reads `PORT` from the environment. Push this folder to GitHub,
then:

* **Render (free)** — <https://render.com> → *New +* → *Blueprint* → pick the repo (`render.yaml`
  configures it). Free instances sleep after ~15 min idle; the game pings itself while people play so
  it won't sleep mid-match.
* **Railway (~$5/mo, never sleeps)** — *New Project* → *Deploy from GitHub repo* → *Generate Domain*.
* **Fly.io** — `fly launch --copy-config --yes` then `fly deploy` (uses `fly.toml` + `Dockerfile`).
* **Any VPS / Docker** — `docker build -t frontier . && docker run -p 80:3000 frontier`.

Every redeploy restarts the process and ends running games (state is in memory), so push between
sessions. `MAX_LOBBIES` (default 50) caps concurrent games; a 512 MB instance handles several.

## Settings

Map, map size (normal/compact), random-map seed, AI nation count, bot count, AI difficulty
(Easy→Impossible scales start troops, max troops, growth, reaction speed and targeting smarts),
spawn-phase length, game speed (0.5×–3×), % of land to win, starting gold, and toggles for
nukes/boats and infinite gold/troops/instant-build sandbox play.

## Project layout

```
server/index.js        HTTP + WebSocket server, lobbies, host controls, intent handling, flag proxy
server/game/config.js  All balance numbers, formulas and colour palettes
server/game/maps.js    Map catalog + loader (OpenFront .bin format) + procedural generator
server/game/game.js    Simulation: players, attacks, boats, trade, structures, nukes, alliances
server/game/ai.js      Nation AI and bot AI
public/                Client: menu/lobby UI, canvas renderer, radial menu, input
public/assets/         OpenFront icons & sprites (CC BY-SA 4.0)
server/maps/           Five bundled OpenFront maps (CC BY-SA 4.0)
```

## Credits

Game design, balance, map data, sprites and icons are from
[OpenFront.io](https://github.com/openfrontio/OpenFrontIO), licensed **CC BY-SA 4.0** (attribution:
OpenFront / OpenFront Inc.). Source code (AGPL-3.0) was not used — this is an independent
re-implementation of the same rules. See `public/assets/LICENSE.txt`.

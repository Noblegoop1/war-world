# OpenFront Lite

A browser-based, real-time (not turn-based) territory strategy game in the style of
[OpenFront.io](https://openfront.io): expand over an open top-down map, grow troops, build
cities/ports/defense posts, send boats, form and break alliances, launch nukes, and win by owning
most of the land. Play with friends over the network with AI nations and bot tribes filling the map.

The mechanics reproduce OpenFront's balance (troop growth curve, attack cost/speed formulas, unit
prices, AI difficulty scaling) in an original, much smaller codebase. No build step, no framework:
Node.js + `ws` on the server, plain HTML/Canvas on the client.

## Quick start

```bash
npm install
npm start
```

Open <http://localhost:3000>, enter a name, **Create game**, tweak the settings, **Start game**.

## Hosting a game for friends

The person hosting runs the server; everybody else just opens a URL in a browser. There are three
ways to make your server reachable, from easiest to most permanent:

### 1. Same Wi-Fi / LAN

Run `npm start`. The console prints your LAN address, e.g.

```
  local:  http://localhost:3000
  LAN:    http://192.168.1.42:3000
```

Friends on the same network open the LAN URL. Create a lobby, then share the game code or click
**Copy invite link** (`http://192.168.1.42:3000/g/ABCDE`). If it doesn't connect, allow Node.js
through Windows Firewall (Windows prompts the first time; if you clicked "cancel", go to
*Windows Security → Firewall → Allow an app* and tick Node.js for private networks).

### 2. Over the internet with a tunnel (no router setup)

Keep `npm start` running and in a second terminal open a tunnel to port 3000:

```bash
npx cloudflared tunnel --url http://localhost:3000
```

Cloudflare prints a public `https://something.trycloudflare.com` URL that anyone can open (no
account needed; the URL changes every time you start the tunnel). [ngrok](https://ngrok.com)
(`ngrok http 3000`) or [Tailscale](https://tailscale.com) (private network between friends) work
the same way. WebSockets go through these tunnels fine.

### 3. Port forwarding or a cloud server (permanent)

* **Port forward**: forward TCP port 3000 on your router to your PC, then friends use
  `http://<your public IP>:3000`.
* **Cloud**: the server is a single Node process that reads `PORT` from the environment, so it
  deploys as-is to Railway, Render, Fly.io, a $5 VPS, etc. (`npm install && npm start`). Put it
  behind HTTPS (the client automatically uses `wss://` on https pages).

The server holds any number of lobbies at once; every lobby has its own map and simulation.

## How multiplayer works

* The server is **authoritative**: it runs the whole simulation at 10 ticks/second and is the only
  place game state lives. Clients never simulate anything, so nobody can cheat by editing the page.
* Each client sends **intents** (`spawn here`, `attack this tile with 20%`, `build a city here`,
  `request alliance`...) over a WebSocket. The server validates them against the rules and applies
  them on the next tick.
* Every tick the server broadcasts a small **delta**: which tiles changed owner, plus (every 0.5 s)
  everyone's troops/gold/tiles, active attacks, boats and nukes. A full snapshot (~200 KB for a
  medium map) is sent only when you join or reconnect.
* **Reconnecting**: your seat is tied to a token stored in the browser tab. If your page reloads or
  your connection drops, you re-join the same game with the same territory. While you're gone your
  nation keeps running (AI nations notice AFK players).
* **Lobbies**: the host creates a lobby (5-letter code / invite link), changes settings, and starts
  the game. Public lobbies show up on the main menu for anyone on the server. The host can end a
  game for everyone from the leaderboard panel.

## Settings

| Setting | What it does |
| --- | --- |
| Map size / type / seed | Procedural map: continents, islands or pangaea. Same seed = same map. |
| AI nations | Real opponents: expand, attack the weakest neighbour, retaliate, boat to islands, build cities/ports/defense posts, save for silos and nuke, form and betray alliances. |
| Bots | Small tribes that mostly just expand (fodder, like OpenFront's bots). |
| AI difficulty | Easy → Impossible scales nation start troops, max troops, growth, reaction time and how smart the target selection is. |
| Spawn phase | Seconds everyone gets to pick a spawn. Unpicked players get a random spot. |
| Game speed | 0.5× – 3× simulation speed. |
| % of land to win | Win condition (OpenFront uses 80). |
| Starting gold, infinite gold/troops, instant build | Sandbox / practice options (infinite applies to humans). |
| Disable nukes / boats | Remove those mechanics. |

## Mechanics cheat-sheet

* **Troops** grow each tick by `10 + troops^0.73 / 4`, scaled down as you approach your max.
  Max troops = `2 × (tiles^0.6 × 1000 + 50 000) + 250 000 per city level`.
* **Attacking**: pick a % with the slider (or keys 1–0) and click land → Attack. Attacks spread tile
  by tile from your border. Neutral land costs ~16 troops per plains tile; attacking a player costs
  both sides troops depending on troop density, terrain (highland/mountain are slower and
  bloodier), defense posts (5× losses, 3× slower) and fallout. Clicking a target you don't touch by
  land sends a boat instead. **Retreat** returns survivors (25% penalty when attacking a player).
* A player reduced to fewer than 100 tiles while under attack is conquered outright (the attacker
  takes their land and half their gold).
* **Gold**: 100/tick base + a little per tile + 120/tick per port level. Costs: city/port
  125K×2ⁿ (cap 1M), defense post 50K×(n+1), silo 1M, SAM 1.5M×(n+1), atom bomb 750K,
  hydrogen bomb 5M. Cities and ports can be upgraded by building on them again.
* **Nukes** need a ready silo (90-tick cooldown). Atom bomb: 10-tile kill radius, 25-tile blast;
  H-bomb: 40/60. Hit tiles become neutral fallout (very expensive to conquer), structures inside
  are destroyed, victims lose troops proportional to the land lost. SAMs shoot down nukes within
  70 tiles. Nuking an ally breaks the alliance.
* **Alliances**: request from the tile/leaderboard menu; the other side accepts or rejects (AI
  decides based on relations and relative strength). Allies can't attack each other and can donate
  troops/gold. Breaking an alliance makes you a *traitor* for 30 s (1.5× losses on defense).

## Controls

| Input | Action |
| --- | --- |
| Left click | Open the tile menu (attack / boat / build / nuke / ally) |
| Drag, mouse wheel, arrows, `+`/`-` | Pan and zoom |
| `A` / `B` | Quick attack / boat attack the hovered tile with the current % |
| `1`–`9`, `0` | Set attack % to 10–90, 100 |
| Hotbar buttons | Enter placement mode, then click where to build (hold Shift to place several) |
| `Enter` | Chat · `Esc` closes menus / cancels placement |

## Project layout

```
server/index.js        HTTP + WebSocket server, lobbies, intent handling
server/game/config.js  All balance numbers and formulas
server/game/map.js     Procedural map generator
server/game/game.js    Simulation: players, attacks, boats, structures, nukes, alliances
server/game/ai.js      Nation AI and bot AI
public/                Client: lobby UI + canvas renderer + input
```

## Credits

Game design and balance formulas are modelled on [OpenFront.io](https://github.com/openfrontio/OpenFrontIO)
(AGPL-3.0). This project is an independent re-implementation and shares no code with it.

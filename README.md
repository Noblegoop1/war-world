# War World

A browser-based, real-time **nation-vs-nation** strategy game built on the mechanics of
[OpenFront.io](https://github.com/openfrontio/OpenFrontIO) and pushed further: claim a spot on a
world map, expand tile by tile, wall your borders, field walking **Mechs**, research national
**doctrines**, and try to hold 80% of the land. Overreach and you run out of troops; sit still and
your neighbours swallow you. Play with friends online against dozens of AI nations and bot tribes.

War World reuses OpenFront's real map data, unit sprites and UI icons (CC BY‑SA 4.0) and reproduces
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
* **Build** (keys **1-0** or the bottom bar, then click a tile):
  * **City** — +250K max troops. Build on it again to upgrade. Joins the rail network when a
    Factory is in range.
  * **Port** — sea coast only. Sends trade ships to other players' ports; launches Warships.
  * **Factory** — becomes a train station and lays rail to every City / Port / Lab / Factory within
    110 tiles (rail also crosses water as bridges, and connects to *other nations'* stations).
    Trains spawn at factories and pay gold on arrival — 10K to your own station, 25K to another
    nation's, 35K to an ally's (the destination gets half). Upgrade to **level 2** to build Mechs;
    each further level makes Mechs tougher and longer-ranged.
  * **Defense Post** — attackers within 30 tiles lose 5x troops and move 3x slower; shells enemy
    ships within 75 tiles.
  * **Missile Silo** — launches atom / hydrogen bombs (90-tick reload) and, with the research,
    Bomber strikes.
  * **SAM Launcher** — shoots down incoming nukes within 70 tiles.
* **Walls** (key **8**) — click-and-drag on your own land to draw a polyline; the server turns it
  into a **3-tile-thick** wall that **snaps to the coast** when you end near it. Walls are the
  slowest build: each block goes up one after another. Enemy attacks must grind each tile's HP
  down and **cannot pass tiles behind it**, so a wall across a choke point seals it. Each tile
  costs more than the last (near-exponential in how much wall you own) and nukes / mech stomps
  raze it. AI nations run a **choke-point analysis** (narrowest cut between the threat and their
  interior, valued by threat x front length / cut length) before spending on a wall.
* **Mechs** (key **9**) — built at a **level-2+ Factory** (the highest-level one, or one you pick
  via its radial). Cost **2M+ gold, escalating**. Not autonomous: like a warship you click where
  it should **patrol**; it walks there (slowly — 0.35 tiles/tick, land-only unless you research
  Amphibious Mech) and circles the spot. Every cannon cooldown it fires a shell at the closest
  hostile mech, structure or dense land patch in range (12 tiles at L2, +3 per level), and every
  stomp cooldown it clears the ground under its feet. **Land hit by a mech becomes neutral**, not
  yours — send troops to claim it. Mechs are very tanky (40K HP at L2, +50% per level) but bleed
  HP while standing in enemy territory, faster where the enemy is strong or has a defense post.
  Nukes, other mechs and time inside enemy land kill them. Click a mech, then a tile, to re-route
  it. AI nations deploy and re-position them against the nation they're fighting.
* **Warships** (key **0**) — need a Port. Click water to set the patrol area (100-tile patrol
  radius); they hunt enemy transport boats, trade ships and warships with shells, repair near your
  ports, and with Coastal Bombardment shell coastal land too. Click one, then water, to move it.
* **Research Lab** (key **7**) — needs **3 Cities**, must be within rail range of a Factory, and
  away from Cities. When ready it offers **3 random doctrines** (TFT-augment style); pick one, it
  takes 60s, then the lab cools down. **Max 2 researches per game.** Everyone can see a nation's
  researches on its info card. All 30 doctrines are live — most are stat buffs (War Economy, Mass
  Production, Industrial Mobilization, Military Rail, Strategic Logistics, Military-Industrial
  Complex, Defensive Position, Coastal Defense Network, Hardened Infrastructure, Military
  District, Fighter Networks, Heavy / Assault / Long-Range / Rapid-Fire Mech, Mech Production,
  Mech Weapons, Coastal Bombardment, Nuclear Subs, Amphibious Warfare, D-Day, Close Air Support,
  Tactical Nukes, MIRV, Nuclear Deterrence) and some unlock units or change mechanics: **Submarine
  Warfare** (invisible subs firing missile volleys that bypass SAMs), **Naval Mines**, **Strategic
  Bombers** (click an enemy structure to bomb it), **Amphibious Mech**, **Naval Base**. AI nations
  pick by situation and *use* what they pick (war economy -> attack more, subs -> build subs, ...).
* **Conquering** a nation or tribe pays gold: its treasury (all of an AI's, half of a human's) +
  10K + 15 per tile. Tribes start weak, grow a little, and stay weak.
* **Expansion** uses OpenFront's frontier priority (terrain + already-owned neighbours + a little
  noise) so fronts stay smooth, plus a bias: a player's expansion leans ~20% toward their mouse
  while they have attacks running; AI nations lean toward the direction they want to grow.
* **Nation info card** — hover or click any nation: besides gold/troops/land it shows two headline
  numbers. **ATK POWER** = troops at home + Mechs + navy + silos + defenses + military research,
  and it **drops while that nation's forces are away fighting**. **ECONOMY** = gold per second from
  land, trade ports, trains and research.
* **Alliances** — request from a player's radial or the leaderboard. Allies can't attack each other
  and can donate troops/gold. Breaking one marks you a **traitor** for 30s (weaker defense). Nuking
  an ally breaks the alliance.
* **Win** by owning 80% of the land (configurable). Any player squeezed under 100 tiles is
  conquered outright — the attacker takes their land and gold.

**Keys:** `A` attack under cursor · `B` boat under cursor · `R` retaliate against your latest
attacker · `C` centre on your territory · `1-6` structures, `7` lab, `8` wall, `9` mech, `0`
warship, `N`/`H` nukes · `[` `]` or Shift+scroll attack ratio · `Enter` chat · `Esc` close ·
drag / wheel to pan & zoom. Right-click never opens the browser menu in-game.

## Maps

War World ships five OpenFront maps (World, Europe, Asia, Oceania, Pangaea) and can download ~35
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
* **Any VPS / Docker** — `docker build -t warworld . && docker run -p 80:3000 warworld`.

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
server/game/config.js  All balance numbers, formulas, colour palettes, research definitions
server/game/maps.js    Map catalog + loader (OpenFront .bin format) + procedural generator
server/game/game.js    Simulation core: players, tiles, attacks (OpenFront frontier priority +
                       focus bias), alliances, stats, tick packets; mixes in the modules below
server/game/units.js   Structures, 3-thick walls (planning, coast snapping, block-by-block build),
                       defense posts, research labs / picker
server/game/rails.js   Factories, rail network (8-connected A*), trains and their gold
server/game/mechs.js   Mechs: build from factories, patrol, cannon, stomp, territory damage
server/game/navy.js    Boats, trade ships, shells, warships, submarines, naval mines
server/game/nukes.js   Nukes on Bezier arcs, blast, SAMs, MIRV, deterrence, bombers
server/game/research.js  The 30 doctrines and every multiplier they apply
server/game/path.js    8-connected A* (octile), path resampling, Bezier helpers
server/game/ai.js      Nation AI (research-driven; factories, mechs, navy, choke-point walls,
                       nukes, bombers) and bot AI
public/                Client: menu/lobby UI, canvas renderer, radial menu, research picker, input
public/assets/         OpenFront icons & sprites (CC BY-SA 4.0)
server/maps/           Five bundled OpenFront maps (CC BY-SA 4.0)
ART_TODO.md            Every placeholder that needs real art / VFX / SFX, with paths and specs
```

## Roadmap

Everything designed so far is playable; what's left is polish: real art / VFX / SFX for the new
units (see `ART_TODO.md`), an audio system, and Carrier Doctrine (air units at sea).

## Credits

Game design, balance, map data, sprites and icons are from
[OpenFront.io](https://github.com/openfrontio/OpenFrontIO), licensed **CC BY-SA 4.0** (attribution:
OpenFront / OpenFront Inc.). Source code (AGPL-3.0) was not used — this is an independent
re-implementation of the same rules. See `public/assets/LICENSE.txt`.

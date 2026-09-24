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
* **Right-click** opens a **radial menu**: Build, Boat, Alliance / Donate / Break, **Declare war** /
  **Make peace**, and Info. Build
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
  * **Defense Post** — attackers within 30 tiles lose 5x troops and move 3x slower, and your own
    border tiles inside that radius are 1.5x harder again (the client draws them in pale stone so you
    can see which stretch is fortified). A post within 6 tiles of open water also shells **enemy
    warships** every 4 seconds for **0.25% of the ship's health** per shell — coastal guns harass
    ships, they don't sink them — and a ship under fire stops repairing at sea. Coastal Defense
    Network turns them on every ship afloat, at double range, for 1.5% a shell.
  * **Artillery Battery** — a siege gun with 45-tile reach that fires once every 45 seconds and hits
    like a truck: **25% of a Mech's health** or **10% of a warship's** per shell. It targets enemy
    Mechs first (this is the answer to a Mech parked on your border), then ships, then whichever
    attack is closest. It never takes ground.
  * **Airport** — one per nation and enormously expensive. It lays **roads** to your Cities within 110
    tiles (220 with Strategic Airlift), the way a Factory lays rail, and every City on those roads becomes
    an airfield. It flies **Airships**: each carries 5% of your troops (10% with Strategic Airlift) over
    SAMs, warships and coastal defenses and drops them on **any land tile on the map**, taking off from
    whichever airfield is closest to the target. SAMs cannot touch one and warships cannot reach one. The counters: a nation with
    **Interceptor Screen** gets a 45% shot at each airship that passes within range of its SAMs or its
    Airport, and **Airborne Mechs** shoot them down. Max 3 in the air, each costing more than the last. The
    catch is that your own SAMs cannot sit within 70 tiles of your Airport unless you research
    **Airbase Network** — opening the sky for your planes opens it for everyone's missiles.
  * **Repair Yard** (needs Field Engineering) — heals your Mechs and rebuilds damaged wall tiles
    within 40 tiles. Put it behind the front, not on it.
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
  via its radial). Cost **2M+ gold, escalating**. What they are for, in short:
  * **Guard (the default order).** A mech waits at its post; the moment an attack hits your land it
    drives to that front on your own roads (about 12 tiles a second at home, so it arrives in seconds),
    and there it **shells the attacking army itself** — every 2s a shell takes 3% of that attack plus
    5,000 troops — while **nothing within 6 tiles of it can be taken** as long as it stands: attackers
    grinding at that pocket chip the mech and bleed for it. When the attack is over it drives back.
  * **Assault (the spearhead).** Point it at a nation you are attacking and it walks at the head of
    your push. Your attacks within 40 tiles of it take ground **twice as fast for half the losses**, each
    of its shells also takes 2% of that nation's army, and the ground it stomps becomes **yours** (a
    bridgehead your attack pours through). Without an attack of yours on that nation, stomped ground is
    only flattened to empty land.
  * **Water.** Any mech can cross the sea on a slow barge (it can't fire while afloat and warships can
    shell it); water doctrines let it cross freely and fight at sea.
  * **Killing one.** Right-click an enemy mech → **Swarm**: troops run straight at it and each one that
    arrives takes 0.03 health off (about 1.3M troops for a fresh level-2 mech; its guns thin the swarm
    on the way in). Artillery, bombers, nukes and warships (at sea) work too. The AI swarms mechs that
    walk into its land and only builds mechs when one would pay: to guard against heavy attacks, or to
    lead a war or a rush.
  The older detail: Not autonomous: like a warship you click where
  it should **patrol**; it walks there (slowly — 0.35 tiles/tick, land-only unless you research
  Amphibious Mech) and circles the spot. Every cannon cooldown it fires a shell at the closest
  hostile mech, structure or dense land patch in range (12 tiles at L2, +3 per level), and every
  stomp cooldown it clears the ground under its feet. **Land hit by a mech becomes neutral**, not
  yours — send troops to claim it. Mechs are very tanky (40K HP at L2, +50% per level) but bleed
  HP while standing in enemy territory, faster where the enemy is strong or has a defense post.
  Nukes, other mechs and time inside enemy land kill them. Click a mech, then a tile, to re-route
  it. Mechs move **20% faster on friendly soil and 30% slower inside enemy land**, and one sitting at
  home with nothing threatening it holds its fire instead of shelling the countryside.
  A mech also **anchors the ground around it**: attacks within 30 tiles lose 3x troops and crawl
  at half speed, the same way a defense post works.
  Right-click your own mech for its **standing orders**: *Hold* (circle the patrol point, what a click
  sets), *Roam* (walk your border, favouring the stretch nearest a hostile neighbour), *Auto-defend*
  (answer incoming attacks, nearest first then whoever is throwing the most troops) and *Auto-assault*
  (pick a nation; the mech marches in and keeps wrecking whatever comes in range). AI nations pick the
  same orders by situation: defend when they're being pushed, assault the nation they're fighting,
  roam when there's no war.
* **Warships** (key **0**) — need a Port. Click water to set the patrol area (100-tile patrol
  radius); they hunt enemy transport boats, trade ships and warships with shells, repair near your
  ports, and with Coastal Bombardment shell coastal land too. Click one, then water, to move it.
* **Research Lab** (key **7**) — needs **3 Cities**, must be within rail range of a Factory, and
  away from Cities. When ready it offers **3 random doctrines** (TFT-augment style); pick one and it
  takes **3–5 minutes** depending on how strong it is (the card says which), then the lab cools down.
  **Hide doctrines** (under the cards) tucks the offer away so you can look around the map first;
  **Show doctrines** brings it back.
  **Upgrade the lab** (up to level 3) to research faster — ×0.8, then ×0.65 of the time; a 5-minute
  doctrine never drops below ~3¼ minutes. Each lab is worth **two doctrines**, and every extra lab
  costs **five times** the last. **Lose the lab and the research dies with it**: bomb it, nuke it or
  take the ground and the work stops, so where you put it matters. Your current research counts
  down on the left, under the attacks. On any nation's card, **hover a doctrine** for a one-line
  summary: green for what it gives them, red for what it costs them, purple for what it does to
  everyone else.
  There are **42 doctrines**. Most are stat changes; several unlock units or change how things work,
  including four answers to SAM umbrellas:
  * **Cluster Munitions** — the Cluster Strike: eight small missiles, ripple-fired a moment apart so
    they fly as a stream on one arc, then **bloom apart** over the target to eight impact points. A SAM
    stops one missile per reload, so against three SAMs five of the eight land.
  * **Decoy Warheads** — a SAM that engages your missile has a 55% chance to hit a decoy instead.
  * **Hypersonic Missiles** — twice the speed, and a SAM that scores still reloads 3× slower.
  * **SEAD Doctrine** — airship drops wreck every enemy SAM within 15 tiles; bombers sent at SAMs
    can't be shot down.
  Each multi-missile weapon flies differently so you can read it at a glance: the **MIRV** bus climbs
  to the top of its arc, flashes, and releases five warheads one after another that start slow and
  speed up as they fall; a **submarine volley** is one missile that climbs out of the sea, splits into
  three that hang and drop for a moment, then each lights up and races onto its own target.
  And for mech nations: **Amphibious Mechs** cross water, take 95% of a warship's health per shell
  and spot submarines within 30 tiles; **Airborne Mechs** move twice as fast over land and water and
  shoot down airships, at the cost of 80% of their damage against everything else.
* **The AI** keeps a short memory of every rival — what they've built, which doctrines they hold,
  whether they're growing, and what they've done to it (who attacked, whose SAMs shot its missiles
  down, who downed its airships). From that it picks a posture (expand, build, turtle, war) and
  chooses doctrines against what it actually faces: SAM walls draw anti-SAM research and airships
  aimed at the launchers; airlifts draw Interceptor Screen; navies draw Coastal Defense and
  Amphibious Mechs. Its missiles are routed around SAM umbrellas along their real flight path, and
  it paces strikes so games don't turn into wastelands.
  Underneath that is a **word memory**. Each AI looks at the nations around it (Easy now and then,
  Hard most of the time, **Impossible every look and every nation on the map**) and writes short words
  about each one with a confidence from 0 to 100%: *city_clump*, *clump_uncovered*, *sam_clump*,
  *no_air_defense*, *econ_buff*, *airship_threat*, *navy_heavy*, *betrayed_me*, *ally_winning*,
  *easy_prey*, *danger* and about eighty more. Words it stops seeing fade and are forgotten. Every
  choice is tagged with the words that make it worth doing: each doctrine lists the words it answers,
  the clump strike wants *city_clump + clump_uncovered + danger*, retaliation weighs *betrayed_me* or
  *nuked_me* against *strong_army* and *busy* — and only strikes back when the odds are good. What
  the objective words say about a nation is computed once and shared by every AI, so the whole thing
  costs a few milliseconds a tick.
  **The finish.** A winning AI keeps its foot down. An alliance is a tool: once a nation is far
  stronger than an ally next door (×4 ATK POWER on Easy down to ×1.5 on Impossible, a quarter less if
  it has nowhere else to grow), nobody dangerous is left for that ally to help with, and nobody strong
  is at its own back, it **breaks the alliance on the spot and rushes the former ally** with waves of
  its army, declaring war for the troop bonus (and wearing the traitor debuff for it). It also finishes
  off neighbours that are collapsing, and a nation that sits on a full army with nothing to do for a
  few turns forces a decision: the weakest non-ally it can reach, by land or by sea. Late in the game it
  no longer accepts alliances from nations it could simply eat.
  Allied AIs **tag-team**: if an ally is fighting a nation the AI can reach, it sends a little help;
  if the ally is clearly winning it joins the rush to grab the land. The AI **allies more eagerly in
  the first five minutes**, declares war on the neighbour its words rate most worth it when it is
  ready for war, and makes peace when it is losing or needs to turtle.
* **Colonising** — empty landmasses, including **small islands**, are worth taking. AI nations run a periodic scan for unclaimed
  regions and ship troops to the best one, scoring by size, distance and how isolated it is, so places
  like Greenland and Antarctica get settled instead of sitting empty all game. The harder the AI, the
  further it will sail for a free continent.
* **Nukes** kill population, not just land: a blast takes a share of the defender's standing army per
  tile it erases (up to 75%), and troops already at sea or mid-attack die with them. The ground is left
  **irradiated** — drawn as a sickly green scar — which makes it expensive to cross but still free land.
  Radiation decays over a couple of minutes, and both the AI and you can move straight back in.
* **Levels** — every building tops out at **level 3**. A Factory above level 2 also runs better: each
  level past 2 makes its trains pay 35% more. One doctrine can push a single building type to level 4
  (**Megacity Planning** for Cities, **Heavy Industry** for Factories) and that last step is a big one.
* **Economy** — there is more than one way to get rich. Passive income is a small flat base plus:
  **land**, which pays by the *square root* of your territory (ten times the land is about three
  times the gold, so conquest alone doesn't run away with it), and **Cities**, which pay by level
  (0.7K/s at level 1, 2.5K/s at level 3, a big jump at level 4). Go 90 seconds without attacking a
  nation and a **peace dividend** multiplies all of that by 1.3. Trade ships between **allies** pay
  both sides **75% more**. Hover your gold for a live breakdown by source.
* **Prices** — Cities, Ports and Factories double in price with each one you own (125K, 250K, …)
  up to 2M. Defense Posts 75K each more (max 600K), SAMs 1.5M then 3M, Silo 1.5M, Airport 8M,
  Warships 300K each more (max 1.5M), Submarines 750K each more (max 3M), Mechs 2M + 2.5M per mech
  already owned. Every price shown in the build bar comes from the server, doctrine discounts included.
* **Unit caps** — you can field 3 Mechs, 3 Warships, 2 Submarines and 3 Airships (some doctrines
  raise these). **Every level-3 Port adds one Warship and one Submarine to the cap, and every level-3
  Factory adds one Mech**; a level-4 building (Heavy Industry) adds one more. Levelling production is
  how a navy or mech corps grows.
* **Declaring war** (radial on their land, or the nation card) — your attacks on that nation carry
  **15% more troops**, but your passive income drops **20%** while any war you declared lasts. A war
  runs at least 60 seconds before you can **make peace**, and allying the nation ends it. The target
  is told, and the nation card shows who is at war with whom.
* **Conquering** a nation or tribe pays **half its treasury** + 10K + 15 per tile. Tribes start
  weak, grow a little, and stay weak.
* **Expansion** uses OpenFront's frontier priority (terrain + already-owned neighbours + a little
  noise) so fronts stay smooth, plus a bias: a player's expansion leans ~20% toward their mouse
  while they have attacks running; AI nations lean toward the direction they want to grow.
* **Nation info card** — hover or click any nation: besides gold/troops/land it shows two headline
  numbers. **ATK POWER** = troops at home + Mechs + navy + silos + defenses + military research,
  and it **drops while that nation's forces are away fighting**. **ECONOMY** = gold per second from
  base, land, Cities, trade ships, trains, conquest and plunder. **Hover either number** — on any
  nation, AI or human — for the full breakdown, including peace-dividend and war penalties.
* **Alliances** — request from a player's radial or the leaderboard. Allies can't attack each other,
  can donate troops/gold, and earn 75% more from trade ships sent to each other. Breaking one marks you a **traitor** for 30s (weaker defense). Nuking
  an ally breaks the alliance.
* **Win** by owning 80% of the land (configurable). Any player squeezed under 100 tiles is
  conquered outright — the attacker takes their land and gold.

The **troop bar** shows your army, not just what's at home: the solid part is troops standing on your
land, the striped part is what you've committed to attacks, boats and garrisons — still yours, still
coming back. The rate above it turns **amber** when your cap is what's throttling growth rather than
your land, so it's a cue to build Cities or take ground.

**Unit levels and refits:** a Mech is built at its Factory's level, a Warship or Submarine at its
Port's (+35% health and +25% damage per level). Upgrading the building doesn't upgrade what's already
in the field — **idle** units below the new level head home on their own (anything in a fight stays
put), spend 30 seconds in the yard fully repaired, and go back to their orders. Force it with
**Recall for refit** on the building, or **Refit** on a unit.

**Info on anything:** right-click a building or a unit (yours or anyone's) → **Info** for its live
numbers — health, damage, reload, range, speed on each kind of ground, gold per second, what it
engages. Aiming a missile outlines **every SAM umbrella** on the map (red for rivals, dashed while
reloading); anything to do with mechs outlines every mech's 30-tile ground-holding radius.

**Selecting units:** click any mech or ship — the hit area follows the icon, so you don't have to zoom
in. **Shift-drag** a box to select several at once; with a unit button armed (Mech, Warship, Submarine)
the box only picks up that kind. Clicking a building picks the building, not the ground under it.

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
running. The host can pause, change speed, or end the game for everyone; if the host leaves, control
passes to the next player still connected.

What each player receives is filtered for them: your doctrine choices, prices and unit caps, your own
submarines and naval mines (enemies can't see them), and messages meant for you go only to you. Every
player gets a distinct colour however many join. Every command is checked against the player who
sent it (you can only move, refit or recall your own units), clients are rate-limited so one can't
flood the server, and a bad message or an error inside one tick is logged and skipped instead of
taking the game down. Tested with 64 human clients in one game.

## Host it on a website

The server is one Node process that reads `PORT` from the environment and keeps every game in memory,
so it needs a host that runs a **long-lived process with WebSockets** — not a serverless / static host
(Vercel, Netlify, GitHub Pages won't work). Push this folder to GitHub, then pick one:

* **Railway (easiest, ~$5/mo, never sleeps)** — sign in with GitHub → *New Project* → *Deploy from
  GitHub repo* → pick the repo (it builds the `Dockerfile`) → *Settings → Networking → Generate
  Domain*. Share that https URL.
* **Fly.io** — `fly launch --copy-config --yes` then `fly deploy` (uses `fly.toml` + `Dockerfile`).
* **A VPS (best value for a lot of players)** — e.g. Hetzner / DigitalOcean with 2 vCPU and 2-4 GB:
  `docker build -t warworld . && docker run -d --restart unless-stopped -p 3000:3000 warworld`, then
  put Caddy in front of it for a domain and HTTPS.
* **Render (free)** — *New + → Blueprint* → pick the repo (`render.yaml`). Fine for trying it with a
  couple of friends, but the free tier has a tenth of a CPU (big maps with many AI nations will
  stutter) and it sleeps after ~15 minutes without traffic.

**Sizing** (measured): one full-size World game with 50 nations and tribes uses ~250-320 MB of memory
and about 4% of a modern CPU core on average, with short spikes; each further game adds roughly
60-120 MB. Compact maps use about half. Set `MAX_LOBBIES` so games fit in memory — about 2 on a
512 MB instance, 5 on 1 GB, 12 on 2 GB (the default of 50 assumes a big machine).

Every redeploy restarts the process and ends running games (state is in memory), so deploy between
sessions. Choose a region close to your players.

## Settings

The lobby's options page works like OpenFront's host screen: cards and switches, host-only.

* **Map** — a card per map. **Difficulty** — Easy to Impossible (start troops, growth, reaction speed,
  targeting, how often the AI looks at its rivals and how early it strikes).
* **Mode** — **Free for all**, **Teams**, or **Zombie** (shown as "coming next"). Teams can be 2–7 teams,
  Duos / Trios / Quads (teams of 2, 3, 4) or **Humans vs Nations**. Humans are spread across teams
  first, then nations fill in; tribes stay on their own. Teammates are permanent allies (no attacking,
  nothing to break), there are no alliances across teams, members share their team's colour, the
  leaderboard shows team standings on top, and a team wins when its members together hold the land needed.
* **Options** — Tribes and Nations sliders (or every nation the map defines), Instant build,
  **Random spawn** (everyone is placed for them), Infinite gold / troops, Compact map,
  **Water nukes** (bombs can be aimed at the sea — how you hit a fleet), and the **Doomsday clock**:
  from 10 minutes in (or halfway through a set game length) a bar of land share rises 1% every 30s;
  anyone under it who isn't the leader gets a minute's warning, then loses troops, then land, until gone,
  so games always end. Checkbox + number options: **Game length** (when time runs out the biggest side
  wins), **Gold multiplier**, **Starting gold** (millions), **Alliance duration** (alliances end after that
  long; ask again to renew) and **Overtime after** (the land needed to win then drops 1% every 30s).
* **Disable units** — switch off any of City, Defense Post, Port, Warship, Boat, Missile Silo, SAM,
  Atom / Hydrogen bomb, MIRV, Factory, Research Lab, Mech, Wall, Artillery, Repair Yard, Airport or
  Submarine. They vanish from the build bar, the server refuses them, and doctrines for them are never offered.
* **Lobby & advanced** — game name, public lobby, max humans, random-map seed, spawn-phase length,
  game speed and % of land to win.

## Project layout

```
server/index.js        HTTP + WebSocket server, lobbies, host controls, intent handling, flag proxy
server/game/config.js  All balance numbers, formulas, colour palettes, research definitions
server/game/maps.js    Map catalog + loader (OpenFront .bin format) + procedural generator
server/game/game.js    Simulation core: players, tiles, attacks (OpenFront frontier priority +
                       focus bias), alliances, stats, tick packets; mixes in the modules below
server/game/units.js   Structures, 3-thick walls (planning, coast snapping, block-by-block build),
                       defense posts, artillery batteries, repair yards, research labs / picker
server/game/rails.js   Factories, rail network (8-connected A*), trains and their gold
server/game/mechs.js   Mechs: build from factories, patrol, cannon, stomp, territory damage
server/game/navy.js    Boats, trade ships, shells, warships, submarines, naval mines
server/game/nukes.js   Nukes on Bezier arcs, blast, fallout, SAMs, MIRV, deterrence, bombers
server/game/air.js     Airports and airships: the way past a SAM + navy turtle
server/game/refit.js   Unit levels and refits (units go home to catch up with an upgraded building)
server/game/inspect.js The numbers behind every Info panel, computed from the live config
server/game/research.js  The 42 doctrines, their tooltip lines, and every multiplier they apply
server/game/path.js    8-connected A* (octile), path resampling, Bezier helpers
server/game/ai.js      Nation AI (research-driven; factories, mechs + standing orders, navy,
                       colonising empty landmasses, choke-point walls, nukes, bombers, wars,
                       word memory of every rival) and bot AI
server/game/intel.js   The AI vocabulary: what a nation looks like from outside, as words
server/game/modes.js   Teams, random spawn, doomsday clock, game length / overtime, alliance duration, disabled units
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

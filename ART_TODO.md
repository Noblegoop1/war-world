# War World — Art / VFX / SFX to-do

Everything below currently uses a **placeholder** (a drawn shape or a reused OpenFront icon). Drop the
finished file at the listed path and it's picked up automatically — no code change needed unless noted.
All sprites are drawn on the map at ~1 tile = 1 px at zoom 1 and scaled up to ~6× when zoomed in, so keep
them small and readable (pixel-art works best, like OpenFront's 5–13 px unit sprites).

Colour-swap convention (same as OpenFront's sprites): paint the parts that should take the **owner's
colour** in pure grey **RGB 180,180,180**, the **darker border colour** in **RGB 70,70,70**, and any
**highlight** in **RGB 130,130,130**. The client recolours those three greys per nation.

## Priority 1 — Mechs (currently: dark hexagon with a crosshair glyph + HP bar)

| Asset | Path | Notes |
| --- | --- | --- |
| Mech idle/walking sprite | `public/assets/sprites/mech.png` | 16–24 px, top-down. Use the grey colour-swap convention. Facing doesn't matter yet (no rotation). |
| Mech engaged/firing variant | `public/assets/sprites/mech_engaged.png` | Same size. Shown while the red "engaged" ring pulses. Optional but recommended. |
| Mech destroyed / wreck | `public/assets/sprites/mech_wreck.png` | 16–24 px, greyscale. Left on the tile for a few seconds when a mech dies. |
| Mech HP bar style | — | Currently a plain green→yellow→red bar above the unit. If you want a custom frame, send a 32×6 PNG frame. |
| Heavy Mech Doctrine skin | `public/assets/sprites/mech_heavy.png` | Bulkier silhouette for nations with the Heavy Mech research. Optional. |
| Assault Mech Doctrine skin | `public/assets/sprites/mech_assault.png` | Optional. |
| Mech shell (in flight) | `public/assets/sprites/mech_shell.png` | 4–6 px. Currently an orange dot. |
| **VFX:** mech footstep dust, cannon muzzle flash, shell impact, **stomp shockwave ring**, mech explosion | `public/assets/sprites/mech_*.png` sprite sheets (horizontal frames) | Stomp/impact currently draw a plain expanding ring. Not wired yet — I'll add an animation player once assets exist. |
| **SFX:** mech deploy, mech footsteps loop, mech fire, mech destroyed | `public/assets/sfx/mech_*.ogg` | No audio system yet; I'll add one when the first files land. |
| Hotbar / radial icon for "Mech" | `public/assets/icons/MechIcon.svg` | White silhouette, 24×24. Replaces the crosshair. |

## Priority 2 — Walls (currently: flat dark-stone tile fill)

| Asset | Path | Notes |
| --- | --- | --- |
| Wall tile texture | `public/assets/tiles/wall.png` | 8×8 or 16×16, tileable. Rendered per tile. |
| Wall damaged states (2–3 levels) | `public/assets/tiles/wall_dmg1.png`, `wall_dmg2.png` | Shown as the segment's HP drops (server already tracks HP). |
| Wall end-caps / corners | optional | Only if you want it to look like a proper fortification line. |
| **VFX:** wall breach crumble | sprite sheet | When a segment hits 0 HP. |
| **SFX:** wall build (per drag), wall hit, wall breach | `public/assets/sfx/wall_*.ogg` | |
| Hotbar / radial icon for "Wall" | `public/assets/icons/WallIcon.svg` | White silhouette. Replaces the wrench. |

## Priority 3 — Research Lab & picker

| Asset | Path | Notes |
| --- | --- | --- |
| Lab structure glyph | `public/assets/icons/LabIcon.svg` | White silhouette inside the hexagon shape. Replaces the "i". |
| Research card art (1 per doctrine, 42 total) | `public/assets/research/<id>.png` | 240×120 landscape banners for the TFT-style cards. IDs: `war_economy`, `mass_production`, `industrial_mobilization`, `military_rail`, `strategic_logistics`, `military_industrial`, `defensive_position`, `coastal_defense`, `hardened_infra`, `military_district`, `fighter_networks`, `heavy_mech`, `assault_mech`, `mech_production`, `mech_weapons`, `longrange_mech`, `rapidfire_mech`, `amphibious_mech`, `coastal_bombardment`, `submarine_warfare`, `nuclear_subs`, `amphibious_warfare`, `naval_mines`, `naval_base`, `dday`, `strategic_bombers`, `close_air_support`, `tactical_nukes`, `mirv`, `nuclear_deterrence`, `field_engineering`, `megacity`, `heavy_industry`, `strategic_airlift`, `airbase_network`, `airborne_doctrine`, `interceptor_screen`, `cluster_munitions`, `decoy_warheads`, `hypersonic_missiles`, `sead_doctrine`, `airborne_mechs`. Doctrines don't change unit art — only the cards. |
| Research-complete flourish | sprite sheet / CSS-able PNG | Plays over the lab when a research finishes. |
| **SFX:** picker open, card hover, card pick, research complete | `public/assets/sfx/research_*.ogg` | |

## Priority 4 — Navy, air, rail (all live; currently placeholders)

| Asset | Path | Notes |
| --- | --- | --- |
| Warship | `public/assets/sprites/warship.png` exists (OpenFront, 11 px). Custom optional. | Shells are white dots; Coastal Bombardment shells orange. Impact VFX wanted. |
| Submarine | `public/assets/sprites/submarine.png` | ~9 px. Currently a dark ellipse with the owner's outline + cyan volley bar. Wants a faint "periscope wake" variant for the owner's own view and a missile sprite (cyan dot now). |
| Naval mine | `public/assets/sprites/mine.png` | 5–7 px, dark sphere. Currently a small black circle. Mine explosion VFX. |
| Bomber | `public/assets/sprites/bomber.png` | 10–14 px top-down, colour-swap greys. Currently an owner-coloured arrowhead. Bomb-drop + shot-down VFX. |
| Trains | `public/assets/sprites/trainEngine.png`, `trainCarriage.png`, `trainCarriageLoaded.png` exist (OpenFront). Custom optional. | Rails are drawn as brown lines with sleepers at high zoom — a rail tile texture (`public/assets/tiles/rail.png`, 8×8) would replace that. |
| Factory glyph | `public/assets/icons/FactoryIconWhite.svg` exists (OpenFront). Custom optional. | Level badge is a white number in a black circle. |
| Attack front marker | `public/assets/icons/SwordIconWhite.svg` exists (OpenFront). Custom optional. | Crossed swords + troop count that follows each attack's front. |
| Artillery Battery | `public/assets/icons/ArtilleryIcon.svg` + optional `public/assets/sprites/artillery.png` | Currently a triangle with the sword glyph. Wants a muzzle-flash VFX and a shell-in-flight sprite. |
| Repair Yard | `public/assets/icons/RepairIcon.svg` | Currently a diamond with the troop glyph. A repair "pulse" VFX over healed mechs/walls would read well. |
| ~~Airship~~ | `public/assets/icons/AirshipIconWhite.png` | **Done** — supplied by you. Keyed to white-on-transparent and tinted to the owner's colour on the map, with a dark copy behind it for an outline. |
| ~~Airport~~ | `public/assets/icons/AirportIconWhite.png` | **Done** — supplied by you. Keyed to white-on-transparent; the client tints it like any other icon. |
| Fallout / radiation | `public/assets/tiles/fallout.png` | Currently a flat green-grey scar with a checker dither. A tileable radiated texture (and a slow shimmer) would sell it far better. |
| Cluster Strike | `public/assets/icons/ClusterIconWhite.svg` + a bomblet sprite | Hotbar currently reuses the explosion glyph; bomblets fly as small atom sprites. |
| Decoy / SAM fooled | VFX | A decoy currently shows as a white ring where the SAM engaged. |
| Refit | `public/assets/icons/RefitIcon.svg` | Units in the yard get a yellow "REFIT" text chip; ships show "L2"/"L3" chips. |
| Info panel | — | Plain table; a frame / per-type header art would lift it. |
| Mech order badges | — | ROAM / DEFEND / ASSAULT are drawn as text chips under the mech. Small icons would be nicer. |
| Fortified border | — | Border tiles under a defense post are drawn in pale stone. A proper battlement texture would be better. |
| Nuke arc | — | Dashed red Bézier + target ring; a proper contrail sprite sheet would look better. |

## UI polish (nice-to-have)

* Custom ATK POWER / ECONOMY badge icons (currently ⚔ and 💰 emoji).
* Declare war / Make peace radial icons (currently reuse the sword and handshake icons; the nation card
  uses ⚔ and 🕊 emoji) — `public/assets/icons/WarIcon.svg`, `PeaceIcon.svg`, white silhouettes 24×24.
* "Hide / Show doctrines" button on the research picker is plain text; an eye / eye-off icon would suit it.
* Options page: difficulty cards use the ☠ text glyph (red, with a CSS glow for Impossible) instead of real
  skull / flaming-skull icons — `public/assets/icons/SkullIcon.svg`, `SkullFireIcon.svg`. The map cards
  are name-only; a small thumbnail per map (`public/assets/maps/<id>.png`, ~240×120) would match OpenFront.
  Mode cards could use icons for Free for All / Teams / Zombie.
* Missile trails are procedural lines (grey smoke for single bombs, orange sparks for cluster bomblets,
  white-hot streaks for MIRV warheads, cyan for submarine missiles). Real exhaust/smoke sprites and a
  MIRV separation flash would sell it.
* Zombie mode: hives are a green circle with the ☣ glyph; zombie land is a procedural green speckle;
  the great-wave marker is a dashed green ring; infected ships get a green ring; the horde-strength cards use
  ☣ glyphs. Wanted: a hive sprite (animated, 32×32), a zombie-land texture/overlay, a wave-incoming icon, a
  cure (syringe) icon for the cure panel, and a horde flag for the leaderboard.
* World history lines use emoji (🤝 🗡 ⚔ 🕊 ☠ ☢ 💉 ☣) as event icons.
* Swarms (troops running at a mech) are drawn as a cluster of coloured dots with a count; mech barges as
  a brown hull ellipse under the mech; airport roads as grey lines with a dashed centre line and the
  runway as a dark strip. All placeholders.
* Nation card background texture.
* Game logo for the menu (currently plain text "WAR WORLD").
* Favicon (`public/favicon.ico`).

---

**Raster icons:** drop a dark-on-light PNG in and say which unit it is — the converter at
`tools/mkicon.js` keys the background out by luminance, forces the shape white, trims the margin
and re-encodes, which is how the Airport and Airship icons were made. Icon filenames carrying an
extension (e.g. `AirportIconWhite.png`) are loaded as-is; anything without one is assumed to be `.svg`.
Non-square art is fitted, not stretched.

**When you hand me files:** tell me the path you used. Sprite sheets should be a single horizontal strip
of equal-width frames (e.g. 8 frames of 16×16 = 128×16) — say the frame count and I'll set the timing.

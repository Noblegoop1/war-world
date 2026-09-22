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
| **VFX:** mech footstep dust, mech cannon muzzle flash, mech explosion | `public/assets/sprites/mech_*.png` sprite sheets (horizontal frames) | Not wired yet — I'll add an animation player once assets exist. |
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
| Research card art (1 per doctrine, 12 total) | `public/assets/research/<id>.png` | 240×120 landscape banners for the TFT-style cards. IDs: `war_economy`, `mass_production`, `defensive_position`, `heavy_mech`, `assault_mech`, `mech_production`, `mech_weapons`, `longrange_mech`, `dday`, `coastal_bombardment`, `submarine_warfare`, `strategic_bombers`. |
| Research-complete flourish | sprite sheet / CSS-able PNG | Plays over the lab when a research finishes. |
| **SFX:** picker open, card hover, card pick, research complete | `public/assets/sfx/research_*.ogg` | |

## Priority 4 — Staged units (need art before I wire the deep mechanics)

| Asset | Path | Notes |
| --- | --- | --- |
| Warship (for Coastal Bombardment) | `public/assets/sprites/warship.png` exists (OpenFront, 11 px). Custom optional. | Bombardment shell + coastal explosion VFX needed. |
| Submarine | `public/assets/sprites/submarine.png` | ~9 px, mostly hidden — needs a "periscope wake" faint variant for the owner's own view. Missile volley sprite + underwater launch VFX. Cooldown bar frame. |
| Strategic bomber / air units | `public/assets/sprites/bomber.png`, `fighter.png` | Only if we go for the air-power researches. |

## UI polish (nice-to-have)

* Custom ATK POWER / ECONOMY badge icons (currently ⚔ and 💰 emoji).
* Nation card background texture.
* Game logo for the menu (currently plain text "WAR WORLD").
* Favicon (`public/favicon.ico`).

---

**When you hand me files:** tell me the path you used. Sprite sheets should be a single horizontal strip
of equal-width frames (e.g. 8 frames of 16×16 = 128×16) — say the frame count and I'll set the timing.

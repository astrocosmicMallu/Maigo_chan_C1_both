# 迷子ちゃん — MAIGO-CHAN

A first-person WebGL horror prototype. One rainy dead-end alley in Tokyo, a lost child, and a
flashlight you should not point at her back.

Everything visual is procedural — **no external models, textures or CDNs at runtime**.
Three.js r160 and its addons are vendored in `js/vendor/`.

The title theme is a real recording, not a synthesiser: **Erik Satie — Gymnopédie No. 1**,
performed by Michael Laucke, from Wikimedia Commons. The composition is public domain
(Satie died in 1925) and the performances were released into the public domain by the
performer, so there is no attribution obligation — this paragraph is courtesy, not licence.
It lives in `assets/` as AAC (universal) and Ogg Vorbis (smaller), 172 s, mono, looped.

---

## Run

```bash
./serve.sh
# then open http://localhost:8080/
```

`serve.sh` is idempotent: it does nothing if the app is already being served, clears a stale
process holding the port, checks every entry-point file exists, then runs `serve.py` on
`0.0.0.0:8080`. Use `PORT=9000 ./serve.sh` to change the port.

`serve.py` is a five-line static server with three opinions that matter:

- `Access-Control-Allow-Origin: *` — module scripts are fetched in CORS mode, and a sandboxed
  preview iframe has an opaque origin, so plain `http.server` can be blocked there
- explicit `text/javascript` for `.js` — some systems map it to `application/octet-stream`,
  which makes the browser refuse the module outright
- `Cache-Control: no-store` — so a fix is never hidden behind a cached `index.html`

**If the title screen ever stops at “GENERATING WET ASPHALT…”,** the page is open over
`file://` or the module was blocked. A classic (non-module) watchdog in `index.html` now prints
the actual reason under the button after 20 seconds instead of pretending to load.

**Voice check:** `http://localhost:8080/voice-test.html` — two buttons play the full Japanese
line with no gameplay, useful for judging the synthesised voice.

---

## Controls

| Input | Action |
| --- | --- |
| Click / `Enter` | enter the alley, then choose an identity |
| `W A S D` / arrows | walk (velocity + head-bob, no sprint) |
| Mouse | look (pointer lock; drag fallback) |
| Mouse / `A` `D` / `1` `2` | at the board: aim at a poster — the identity you point at is the one you get |
| Click / `E` | at the board: become the person on the poster you are looking at |
| `F` | flashlight on/off |
| `E` | interact (vending machine, neon door) |
| `Q` | offer the candy |
| `1` `2` `3` | adult compliance protocols |
| `Y` / `N` | answer Maigo-chan |
| `Esc` | pause / release the mouse |

---

## Files

```
index.html          canvas mount, HUD, subtitles, in-world look card, jumpscare, endings
styles.css          dark UI, bilingual subtitle system, game-over glitch, title screen
js/main.js          clock, input, camera, state engine, story flow, heart rate, prewarm
js/world.js         renderer, ACES filmic, post-processing, procedural alley, GLTF pipeline
js/maigo.js         SDF-sculpted Maigo-chan: mesh, hair shell, face, uniform, bag
js/sdf.js           signed-distance field primitives + surface-nets mesher
js/anatomy.js       the body and head sculpt, region masks, character bake
js/prims.js         hand-built geometry (spheres, discs, lathes, blobs) — no THREE primitives
js/audio.js         Web Audio: ambience, foley, two formant voices, piano, heart, jump scare
js/mechanics.js     triggers, lead AI, freeze trap, forbidden back-ray, protocols, chase
js/textures.js      canvas textures — asphalt, concrete, posters, vending fronts, hair
js/geo.js           procedural geometry kit (loft, ribbon, blob, extruded slab, tubes)
js/assets.js        base64 faces + missing-person portraits
js/vendor/          three.module.js + GLTFLoader, EffectComposer, passes, shaders
```

---

## The two identities

**Student (女子高生)** — the candy loop. `E` at a vending machine gives you a wrapped candy;
`Q` offers it to her and ends the game peacefully.

**Office worker (会社員)** — no candy. Three protocols, and only one survives:

1. *"I have a child at home"* → she sees through the lie, chase begins (+50% speed).
2. *Offer jacket / blanket* → **Rust Shift**: concrete turns to rusted metal, she stops more often.
3. *Grab her hand* → only works once the neon convenience-store door has appeared, and only
   within 4 m of it.

---

## Systems worth knowing

- **Identity selection happens at the board.** The camera dollies in until the missing-persons
  board fills the frame and your torch dims to a reading glow. There is no menu and no second
  window: you point the mouse at a poster (or tap `A`/`D`) and the card under it lights up —
  name, age, last-seen time and the ability that comes with it. `E` or a click becomes that
  person. The card is a label on the world, not an overlay you choose from.
- **Two voices.** Maigo-chan speaks in a thin, high child's formant voice; your own replies
  ("はい。家まで送ります。" / "いいえ。関わらない。") are synthesised an octave and a half lower
  through the same engine, so the two are clearly different people. Both run through a
  de-esser and a soft-knee compressor — the crackle in earlier builds came from high-Q
  formant filters and exponential envelopes cutting off at 1e-4.
- **Heart rate** is a mechanic, not decoration: it rises as she gets closer (2 m ≈ 150 bpm,
  14 m ≈ 64 bpm), spikes when she is chasing you, and settles when the alley is empty and the
  dread is low.
- **The title screen is scored.** The first click or key press anywhere starts the theme —
  browsers refuse to make sound before a gesture, so there is no way to have it earlier — and
  it keeps playing under the board until you pick an identity, then fades over three seconds.
- **The title screen is a scene, not a card.** The alley renders live behind the menu — rain,
  the failing sodium lamp, the neon door — with the camera drifting a few centimetres and the
  torchlight breathing. The first click or key press starts the rain bed and the piano, because
  browsers refuse to make sound before a gesture.
- **Flickering light.** The sodium lamp sags and stutters on a schedule, wall sconces breathe
  independently of each other, and both get worse as dread rises.
- **Freeze trap** — every 15–20 s she stops dead. You have 300 ms to stop moving. Moving the
  mouse during a freeze scrapes gravel and kills you.
- **Forbidden back-ray** — a hidden 0.44 × 0.56 m plane is pinned to her back. If the flashlight
  cone intersects it for 0.5 s, she feels the light. Toggle `F` or look away.
- **Chase** — 17 s of pursuit, `2.025 m/s` against your walk speed; the distance bar is the
  only warning you get.
- **Rust Shift** — crossfaded wall/floor materials, fog `0x1a0f0c`, re-tinted sodium lamps.

---

## Injecting real assets

`js/world.js`:

```js
export const MODEL_URLS = {
  maigo: '',           // https://…/maigo_chan.glb
  concreteWall: '',    // https://…/concrete_panel.glb
  utilityPole: '',     // https://…/utility_pole.glb
  vendingMachine: '',  // https://…/vending_machine.glb
};
export const ASSET_URLS = MODEL_URLS; // alias
```

Paste a URL and the loader streams it with `GLTFLoader`, then traverses every mesh and
force-overrides its material (colour, metalness, roughness, normal scale, env intensity) into
the game's palette. Empty string → the procedural fallback ships as-is.

`Maigo` also exposes `load(url)` if you want to hot-swap only the character at runtime.

---

## Quality tiers

`?quality=high|low|min` or automatic (`world.software` → `min` on SwiftShader/software GL, and a
runtime governor drops the pixel ratio — then shadows — if the frame rate sags below 46 fps.

| tier | DPR | shadows | rain | env map | lights |
| --- | --- | --- | --- | --- | --- |
| high | ≤1.6 | PCFSoft | 1400 | PMREM | all |
| low | 0.72 | off | 480 | PMREM | sconces off |
| min (auto on software GL) | 0.5 | off | 0 | off | minimal |

Developer shortcuts: `?stage=board|explore|dialogue|follow|chase` skips boot and jumps to a
scene, e.g. `http://localhost:8080/?quality=min&stage=dialogue`.

---

## Notes

- The poster art, faces and portraits are base64 JPEGs in `js/assets.js`; replace the keys
  `horrorFace`, `posterStudent`, `posterSalaryman` to swap the art.
- The Japanese line is **synthesised live** (glottal source → three parallel formant filters →
  consonant bursts), not `speechSynthesis`. It never depends on an installed OS voice.
- The character is not a GLTF import: her body and head are sculpted as a signed-distance field
  (`js/anatomy.js`), meshed with surface nets into ~85 k triangles and split by region into
  skin / blouse / skirt / socks / shoes / collar meshes. Hair is a parametric shell with a face
  opening plus ~70 card strands.
- Her shaders and lights are compiled during the loading screen (`prewarm()` in `main.js`).
  Adding her to the scene changes the light count, which would otherwise recompile every
  material in the alley at the exact moment you pick an identity.
- Tested in Chromium (SwiftShader and hardware GL). 60 fps target on a discrete GPU at high.

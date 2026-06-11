# Figma → WebApp Animator: render-driven UI animation playbook

The repeatable recipe for turning a Figma "Make" export (or any Vite/React app) into a
**render-driven UI animation** inside max.js: a single-file page driven by animator
channels (`reveal` 0→1) with **real 3D depth** via the layer stack, keyframed in Max,
rendered, finished in After Effects.

This is the *how-to-do-it-again-fast* companion to **`figma-webapp-tests.md`** (the
bug/issue log — read that for the *why* behind every "don't" below). Reference impl:
`C:\Users\ogulc\Projects\Mullet\app_itself` (RevealStage, serve-dist.cjs, page entries).

---

## The 6 hard rules (each one cost us an hour — see issue log)

1. **Single-file HTML only.** Disk-path pages don't resolve sibling `./assets/*`
   (Issue 2/3). Inline everything → one `.html`, zero external requests.
2. **Serve over `http://127.0.0.1` if you use layers.** `layerCount > 1` appends
   `?maxjs-layer=i&maxjs-layers=N`; this build can't resolve a query on a disk path →
   0 layers mount (Issue 9). HTTP passes the query through. Localhost is
   mixed-content-exempt, so the https panel embeds it fine.
3. **`Cache-Control: no-store` on the server** (serve-dist.cjs) → rebuilds to the same
   filename refetch. Disk paths cache stale forever (Issue 4); http+no-store fixes it.
4. **Never change `presentation`/`url` twice rapidly in one MAXScript block** — it
   races the async remount into an orphaned empty-`src` iframe that only delete+recreate
   fixes (Issue 6). One change, then a sync (a time-slider nudge), then the next.
5. **Drive animation from the param, never wall-clock.** `reveal` state must be a pure
   function of the channel value → scrub-accurate + render-deterministic (AE-safe).
6. **Real depth = layer stack, not CSS `translateZ`.** Inside an iframe, `translateZ`
   never joins the scene; elements stay stuck to the plane (Issue 10). Use `layerCount`
   + `layerGap`.

---

## One-time project setup

```bash
npm i react@18.3.1 react-dom@18.3.1          # Figma marks these optional peerDeps
npm i -D vite-plugin-singlefile
```

`vite.config.ts`:
```ts
import { viteSingleFile } from 'vite-plugin-singlefile'
export default defineConfig({
  base: './',
  plugins: [/* react(), tailwind(), */ viteSingleFile()],
  build: {
    assetsInlineLimit: 100000000,   // inline images too (no external requests)
    cssCodeSplit: false,
    // singlefile sets inlineDynamicImports -> rollup allows only ONE input,
    // so build one page per invocation, chosen by env:
    rollupOptions: { input: path.resolve(__dirname, process.env.BUILD_ENTRY || 'index.html') },
  },
})
```

Drop in `serve-dist.cjs` (20-line static server, `no-store`, ignores query string).
Note `.cjs` — Figma packages are `"type":"module"`.

---

## Per-page authoring (one screen = one artifact)

For each screen you want to animate, add three files:

- `src/pages/<Name>Standalone.tsx` — boots straight into the screen with seed props +
  chrome, wrapped in `<RevealStage>`. Mark the scroll area `data-reveal-scroll`.
- `src/pages/<name>-main.tsx` — `createRoot(...).render(<NameStandalone/>)` + global css.
- `<name>.html` (project root) — entry pointing at `/src/pages/<name>-main.tsx`.

**`RevealStage.tsx` is reusable as-is** (copy from the Mullet project). It:
- auto-discovers blocks (top bar → each section → bottom nav) with **zero edits to the
  app components**;
- staggers them in (fade + rise) from a `reveal` 0..1 channel, top→bottom;
- assigns each block a **layer** (back = info, mid = `cursor:pointer` cards, front =
  buttons + bottom nav) and, since the page is cross-origin, hides non-owned layers
  itself (reads `?maxjs-layer`/`{type:'maxjs:layer'}`, `visibility:hidden` to keep
  layout aligned, transparent bg on front layers).

Tune the look in one place — `layerForBlock()` (which block goes to which layer) and the
`DUR`/`RISE_PX` constants (stagger feel).

### Scalable variant: one page, every screen via `?screen=`

For a whole app, skip per-screen html files — use a single generic stage
(`AppStage.tsx` in the Mullet project) that renders any screen by `?screen=<name>`
(read from `location.search`), each wrapped in the same `RevealStage`. One build
(`app.html`), and every node just points at `app.html?screen=<name>`. This only works
because we serve over HTTP (Rule 2) — the screen query AND the viewer's appended
`?maxjs-layer=…` coexist fine (`app.html?screen=earn&maxjs-layer=0&maxjs-layers=3`).
Switch a node's screen live with no rebuild:
```maxscript
$'WebApp Animator001'.url = "http://127.0.0.1:9877/app.html?screen=earn"
```

---

## Build, serve, wire

```bash
BUILD_ENTRY=<name>.html npm run build        # -> dist/<name>.html (self-contained)
node serve-dist.cjs dist 9877                # leave running while authoring/rendering
```

Create a **WebApp Animator** (Create → Geometry → max.js) and configure it. The
MAXScript creatable class is `WebApp_Animator`:

```maxscript
(
  local n = $'WebApp Animator001'                       -- or: n = WebApp_Animator()
  n.url = "http://127.0.0.1:9877/<name>.html"           -- HTTP, not a disk path
  n.pixelWidth = 440;  n.pixelHeight = 1020             -- portrait phone
  n.presentation = 0                                    -- 0 CSS3D (crisp, viewport/screen-cap)
  n.interactive = false                                 -- render, no input
  n.layerCount = 3;  n.layerGap = 5.0                   -- real depth; keyframe layerGap to fan out
  n.param1Name = "reveal"
  animate on ( at time 0f n.param1 = 0.0; at time 60f n.param1 = 1.0 )   -- continuous, smooth tangents
  completeRedraw()
)
```

- **reveal** (param1): keyframe 0→1 over the shot; retime by moving the 2 keys.
- **layerGap**: static for a fixed depth, or keyframe to inflate/flatten the 3D stack.
- **presentation**: `0` CSS3D = crisp text, shows in **viewport/screen capture** but NOT
  render-to-image. Flip to `1` Texture (Web Panels menu) if you output via
  render-to-image — `reveal`/layers behave the same.

If `layerCount` silently drifts (panel spinner), re-set it; the iframe layer query
(`maxjs-layers=N`) in the CDP target list is ground truth for what actually mounted.

---

## Quick verify (CDP on `:9222`, only when something looks off)

```bash
curl -s http://127.0.0.1:9222/json        # list frames; each layer = its own iframe target
# expect N targets ...?maxjs-layer=0&maxjs-layers=N ... home/<name>.html
```
A child iframe isn't a top-level target — eval its DOM (`#root` childCount), don't
`Page.captureScreenshot` it. Full diagnostic patterns in `figma-webapp-tests.md`.

---

## New-screen checklist

- [ ] `src/pages/<Name>Standalone.tsx` (+ `<RevealStage>`, `data-reveal-scroll`)
- [ ] `src/pages/<name>-main.tsx` + `<name>.html`
- [ ] `BUILD_ENTRY=<name>.html npm run build`
- [ ] server running on `:9877`
- [ ] node `url` = `http://127.0.0.1:9877/<name>.html`, `layerCount`/`layerGap` set
- [ ] `reveal` channel keyed 0→1
- [ ] scrub 0→60; confirm N layer targets in CDP

### Driving interactions / a full sequence (navigation + taps)

For a choreographed shot (reveal → navigate → interact), don't click manually — clicks
become channels. Reference impl: `SequenceStage.tsx` (one full-app node, all screens).

- `reveal` 0..1 — assemble the CURRENT screen (RevealStage keyed by screen so each nav
  re-assembles).
- `screen` stepped int — navigate (`['home','grow','earn'][floor(v)]`). Swap the screen
  while `reveal` is at 0 (blank) so there's no pop.
- `tap` stepped int — on each increment, synthesize a real DOM click on the current
  screen's target (`element.click()` found by text), which plays the app's OWN animation
  (portfolio expand, gacha spin). Works even with `interactive:false` (it's an in-page
  click, not viewport input) and even under layers (every instance fires on its own copy,
  staying consistent). Use `#step` tangents on `screen`/`tap`; smooth on `reveal`.

Determinism caveat: `reveal` is a pure function of the param (render-safe). App-internal
interactions (gacha 3s spin, motion springs) are **wall-clock** — they look right in
realtime/playback capture but won't freeze-frame cleanly in a frame-by-frame render.
Capture those beats via playback, or rebuild the specific effect as a param if you need
frame-exact.

Choreography is authored as keyframes in Max (`animate on ( at time <f> n.paramN = v )`),
holds = flat spans between keys. See the 1000-frame Mullet_Sequence setup for a template.

### Crispness: supersample CSS3D panels

CSS3D iframes rasterize at their intrinsic CSS-pixel size, then the 3D transform
upscales that bitmap → soft text when the panel is shown larger than its pixel size.
Fix = supersample: size the node `pixelWidth/Height = design × SS` and render the design
at natural size but `zoom: SS` (same on-screen size, SS× backing pixels). `transform:
scale` does NOT help (it stretches the same bitmap); `zoom` re-rasterizes.

Reference: `src/pages/supersample.ts` — `?ss=<n>` on the node URL applies it. The app's
`100vh`/`h-screen` sizing fights `zoom`, so pin the design box (`html{width/height:
iframe/SS; zoom:SS}`) and override the viewport-height usages (`.h-screen{height:100%}`,
`[data-reveal-scroll]>*{min-height:100%}`). Set node `pixelWidth=440*SS`, `pixelHeight=
1020*SS`, url `...?ss=SS`; leave `displaySize` (same world size, just denser). SS=2 is a
good default.

### Gotcha: section discovery vs injected `<style>` siblings

RevealStage descends the single-child chain to the section container. Some screens render
inline `<style>` (keyframes) as a *sibling* of the section box, so the root has 2 children
and the descent stops early → the whole screen reveals/layers as ONE lump. Fix: ignore
`STYLE`/`SCRIPT` when counting children in the descent (already in `RevealStage.collect`).
Symptom to watch: a screen that fades in as a block instead of per-section, or a layer
showing almost no text.

### Faking DOF + glow in CSS3D (no framebuffer / texture needed)

True framebuffer post-FX (bloom/DOF) needs Texture mode, which is broken for module/MUI
bundles (Issue 11). But you can get the LOOK in crisp CSS3D, in-panel:

- **DOF** — blur each layer instance by its distance from a focal layer (`filter: blur`
  on the stage div, inside each CSS3D iframe so it composites fine). Channel `dof`
  (amount) + `focus` (focal layer index, -1 = front). Keyframe `focus` 2→0 to rack focus
  front→back. Discrete per-layer, but reads as real depth-of-field with 3 layers.
- **Glow** — scan for the brand accent colour (`rgb(200,255,0)`) and set a matching
  `box-shadow`/`text-shadow`; channel `glow` (amount). Keyframe to pulse.

Both are pure functions of the channels (render-deterministic) and live in
`RevealStage.applyFx()`. This is 2D compositing post, not scene-3D-accurate (the UI isn't
affected by scene depth/lights) — for that you still need the Texture-mode renderer fix.

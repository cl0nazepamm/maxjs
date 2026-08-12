// debug_bridge.js — VIEWER-ONLY inspection surface, published at
// `globalThis.__maxjs`. Read access to the live renderer, scene and fx state
// for an external CDP client (or the devtools console).
//
// WHY THIS EXISTS
// The renderer, scene, camera and fx controller are declared in boot.js's
// function scope and are reachable from no global — `window.maxJS` exposes the
// subsystem APIs but not the three.js objects. An attached CDP session could
// therefore see nothing: a full sweep of `globalThis` reaches ~120 objects and
// none of them is the renderer, so `Runtime.evaluate` had nothing to grab and
// the only alternative was a heap snapshot.
//
// VIEWER-ONLY, STRUCTURALLY
// Snapshot exports boot from `js/snapshot_boot.js` and never import anything
// under `js/editor/`, so this module cannot reach a published scene. Keep it
// that way: do not import it from snapshot_boot.js or any js/ module outside
// js/editor/. It is deliberately not gated on a flag — the import graph IS the
// gate, which is the only kind that cannot be left switched on by accident.
//
// TWO RULES FOR ANYTHING ADDED HERE
//  1. Handles come from call-time thunks, never aliased at module scope. A
//     renderer backend switch REBUILDS the renderer (see the RULE in
//     context.js); a captured reference goes stale and reads a dead device.
//  2. Every helper returns plain JSON. CDP `returnByValue` serialises the
//     result, and a live three object graph is both cyclic and enormous —
//     returning one truncates the response or kills the round-trip.

function installDebugBridge({
    ctx = null,
    getRenderer = () => null,
    getScene = () => null,
    getCamera = () => null,
    getControls = () => null,
    getFx = () => null,
    THREE = null,
} = {}) {
    const num = (v, digits = 2) => (Number.isFinite(v) ? +v.toFixed(digits) : null);
    const MB = (bytes) => (Number.isFinite(bytes) ? +(bytes / 1048576).toFixed(1) : null);

    // ── resource identity ────────────────────────────────────────────────
    // three's Info.memoryMap is a real Map (not a WeakMap), keyed by every
    // tracked GPU resource — textures, uniform groups, programmable stages.
    // It is the only enumerable view of what the renderer is holding, which
    // makes it the one place a leak is directly observable.
    const memoryMap = () => getRenderer()?.info?.memoryMap ?? null;

    const resourceKey = (r) => {
        const w = r?.image?.width ?? r?.width;
        const h = r?.image?.height ?? r?.height;
        const size = (w != null && h != null) ? `${w}x${h}` : null;
        return [
            r?.constructor?.name || 'Unknown',
            size,
            r?.isFramebufferTexture ? 'FB' : null,
            r?.isDepthTexture ? 'DEPTH' : null,
            r?.isRenderTargetTexture ? 'RTT' : null,
            r?.name ? `name=${r.name}` : null,
        ].filter(Boolean).join(' | ');
    };

    const tally = (items) => {
        const counts = {};
        for (const r of items) {
            const k = resourceKey(r);
            counts[k] = (counts[k] || 0) + 1;
        }
        return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
    };

    const resourceSet = () => {
        const mm = memoryMap();
        const out = new Set();
        if (mm && typeof mm.forEach === 'function') mm.forEach((_v, k) => out.add(k));
        return out;
    };

    // Marks pin the resources they record. That adds no retention in practice:
    // memoryMap already holds every one of them strongly, so a mark can only
    // outlive a resource the renderer itself has already dropped. clear() is
    // still provided so a long session does not accumulate dead marks.
    const marks = new Map();

    // ── render targets ───────────────────────────────────────────────────
    // Walked from the renderer rather than read off a list, because targets
    // live in per-config caches (renderer._renderContexts) with no public
    // enumeration. Depth is bounded and big arrays are skipped so this stays
    // cheap enough to call every frame if needed.
    const collectRenderTargets = (limit = 400) => {
        const root = getRenderer();
        if (!root) return [];
        const found = new Set();
        const seen = new WeakSet();
        const walk = (o, d) => {
            if (!o || typeof o !== 'object' || d > 7 || found.size >= limit) return;
            if (seen.has(o)) return;
            seen.add(o);
            let keys;
            try { keys = Object.keys(o); } catch { return; }
            if (keys.length > 400) return;
            for (const k of keys) {
                let v;
                try { v = o[k]; } catch { continue; }
                if (!v || typeof v !== 'object') continue;
                if (v.isRenderTarget) found.add(v);
                if (Array.isArray(v) && v.length > 200) continue;
                walk(v, d + 1);
            }
        };
        walk(root, 0);
        return [...found];
    };

    const bytesPerPixel = (texture) => {
        // HalfFloatType=1016, FloatType=1015 in three's constants.
        if (texture?.type === 1016) return 8;
        if (texture?.type === 1015) return 16;
        return 4;
    };

    const describeTarget = (t) => {
        const layers = Array.isArray(t.textures) ? t.textures.length : 1;
        const samples = t.samples > 1 ? t.samples : 1;
        const est = t.width * t.height * bytesPerPixel(t.texture) * layers * samples;
        return {
            size: `${t.width}x${t.height}`,
            layers,
            samples: t.samples || 0,
            depth: !!t.depthBuffer,
            type: t.texture?.type === 1016 ? 'HalfFloat'
                : t.texture?.type === 1015 ? 'Float' : 'UnsignedByte',
            // Includes the sample-count multiplier, which three's own
            // info.memory.texturesSize does NOT (_getTextureMemorySize is
            // width*height*depth*bytesPerPixel only) — so an MSAA target costs
            // several times what the built-in counter reports.
            estMB: MB(est),
        };
    };

    const api = {
        version: 1,

        // Live handles. Getters, so a backend switch is transparent.
        ctx,
        get renderer() { return getRenderer(); },
        get scene() { return getScene(); },
        get camera() { return getCamera(); },
        get controls() { return getControls(); },
        get fx() { return getFx(); },
        get THREE() { return THREE; },

        /** Renderer identity + how the drawing buffer relates to the CSS box. */
        rendererInfo() {
            const r = getRenderer();
            if (!r) return { error: 'no renderer' };
            const c = r.domElement || null;
            const box = c ? `${c.clientWidth}x${c.clientHeight}` : null;
            const buf = c ? `${c.width}x${c.height}` : null;
            return {
                type: r.constructor?.name ?? null,
                backend: r.backend?.constructor?.name ?? null,
                samples: r.samples ?? null,
                pixelRatio: typeof r.getPixelRatio === 'function' ? r.getPixelRatio() : null,
                devicePixelRatio: globalThis.devicePixelRatio ?? null,
                cssBox: box,
                drawingBuffer: buf,
                // Effective scale of buffer vs CSS box. Divide by
                // devicePixelRatio to recover the applied renderScale.
                bufferPerCssPx: c && c.clientWidth ? num(c.width / c.clientWidth, 4) : null,
                toneMapping: r.toneMapping ?? null,
                outputColorSpace: r.outputColorSpace ?? null,
                shadowMap: r.shadowMap ? { enabled: r.shadowMap.enabled, type: r.shadowMap.type } : null,
            };
        },

        /** three's own counters, plus the memoryMap size the counters omit. */
        memory() {
            const r = getRenderer();
            if (!r) return { error: 'no renderer' };
            const mm = memoryMap();
            return {
                memory: r.info?.memory ? { ...r.info.memory } : null,
                render: r.info?.render ? { ...r.info.render } : null,
                texturesMB: MB(r.info?.memory?.texturesSize),
                // Tracked resources of ALL kinds. Grows well past the texture
                // count because uniform groups and programmable stages are in
                // here too — and those are where a rebuild leak shows first.
                trackedResources: mm?.size ?? null,
            };
        },

        /** Scene-graph census. Cheap; safe to poll. */
        sceneInfo() {
            const s = getScene();
            if (!s) return { error: 'no scene' };
            let meshes = 0, batched = 0, instanced = 0, instancedTotal = 0, skinned = 0;
            let lines = 0, points = 0, lights = 0, groups = 0, tris = 0;
            let noFrustum = 0, autoMatrix = 0, hidden = 0, shadowCasters = 0;
            const mats = new Set(), geos = new Set(), lightTypes = {}, matTypes = {};
            s.traverse((o) => {
                if (o.isBatchedMesh) batched++;
                else if (o.isInstancedMesh) { instanced++; instancedTotal += o.count || 0; }
                else if (o.isSkinnedMesh) skinned++;
                else if (o.isMesh) meshes++;
                else if (o.isPoints) points++;
                else if (o.isLine) lines++;
                else if (o.isLight) { lights++; lightTypes[o.type] = (lightTypes[o.type] || 0) + 1; }
                else if (o.type === 'Group' || o.type === 'Object3D') groups++;
                if (!o.frustumCulled) noFrustum++;
                if (o.matrixAutoUpdate) autoMatrix++;
                if (o.visible === false) hidden++;
                if (o.castShadow) shadowCasters++;
                if (o.material) {
                    for (const m of [].concat(o.material)) {
                        if (!m) continue;
                        mats.add(m);
                        matTypes[m.type] = (matTypes[m.type] || 0) + 1;
                    }
                }
                if (o.geometry && !geos.has(o.geometry)) {
                    geos.add(o.geometry);
                    const g = o.geometry;
                    const n = g.index ? g.index.count : (g.attributes?.position?.count || 0);
                    tris += n / 3 * (o.isInstancedMesh ? (o.count || 1) : 1);
                }
            });
            return {
                meshes, batchedMeshes: batched, instancedMeshes: instanced,
                instancedTotalCount: instancedTotal, skinnedMeshes: skinned,
                lines, points, lights, groups,
                uniqueMaterials: mats.size, uniqueGeometries: geos.size,
                trianglesApprox: Math.round(tris),
                frustumCullDisabled: noFrustum, matrixAutoUpdateOn: autoMatrix,
                hiddenObjects: hidden, shadowCasters,
                lightTypes, materialTypes: matTypes,
            };
        },

        /**
         * Materials grouped by identity. `instances > 1` for a single key means
         * redundant clones — each distinct material compiles its own program,
         * so this is the first place to look when program count is high.
         */
        materials() {
            const s = getScene();
            if (!s) return { error: 'no scene' };
            const byName = new Map();
            const bySignature = new Map();
            const all = new Set();
            s.traverse((o) => {
                if (!o.material) return;
                const sig = o.userData?.maxjsMaterialSignature ?? '(none)';
                for (const m of [].concat(o.material)) {
                    if (!m) continue;
                    all.add(m);
                    const nameKey = `${m.type}/${m.name || '(unnamed)'}`;
                    if (!byName.has(nameKey)) byName.set(nameKey, new Set());
                    byName.get(nameKey).add(m);
                    if (!bySignature.has(sig)) bySignature.set(sig, new Set());
                    bySignature.get(sig).add(m);
                }
            });
            const redundant = [...byName.values()].reduce((acc, set) => acc + Math.max(0, set.size - 1), 0);
            return {
                totalInstances: all.size,
                distinctSignatures: bySignature.size,
                redundantClones: redundant,
                byName: [...byName.entries()]
                    .map(([material, set]) => ({ material, instances: set.size }))
                    .sort((a, b) => b.instances - a.instances),
                bySignature: [...bySignature.entries()]
                    .map(([sig, set]) => ({ signature: String(sig).slice(0, 80), instances: set.size }))
                    .sort((a, b) => b.instances - a.instances),
            };
        },

        /** Every reachable render target, largest first, MSAA included in estMB. */
        renderTargets() {
            const targets = collectRenderTargets().map(describeTarget)
                .sort((a, b) => (b.estMB || 0) - (a.estMB || 0));
            return {
                count: targets.length,
                reportedByRenderer: getRenderer()?.info?.memory?.renderTargets ?? null,
                estTotalMB: +targets.reduce((s, t) => s + (t.estMB || 0), 0).toFixed(1),
                targets,
            };
        },

        /** Tracked GPU resources tallied by kind+size. The leak view. */
        resources() {
            const set = resourceSet();
            return { total: set.size, byKind: tally([...set]) };
        },

        // ── leak diffing ─────────────────────────────────────────────────
        /** Record the current resource set under `label`. */
        mark(label = 'default') {
            const set = resourceSet();
            marks.set(label, set);
            return { label, tracked: set.size };
        },

        /**
         * What appeared and disappeared since `mark(label)`. Run a resize (or
         * any rebuild) between the two calls: anything in `added` that is not
         * matched in `removed` survived the rebuild and is a leak candidate.
         */
        diff(label = 'default') {
            const before = marks.get(label);
            if (!before) return { error: `no mark named "${label}" — call __maxjs.mark(label) first` };
            const after = resourceSet();
            const added = [...after].filter((r) => !before.has(r));
            const removed = [...before].filter((r) => !after.has(r));
            return {
                label,
                trackedBefore: before.size,
                trackedAfter: after.size,
                net: after.size - before.size,
                addedCount: added.length,
                removedCount: removed.length,
                added: tally(added),
                removed: tally(removed),
            };
        },

        clearMarks() {
            const n = marks.size;
            marks.clear();
            return { cleared: n };
        },

        /**
         * Escape hatch: read an arbitrary dotted path off this bridge and
         * return it JSON-safely. `__maxjs.pick('renderer.info.render')`.
         * Objects are shallow-flattened to primitives so a live node graph can
         * never be serialised whole.
         */
        pick(path = '', depth = 1) {
            let node = api;
            for (const part of String(path).split('.').filter(Boolean)) {
                if (node == null) return { error: `path stopped at "${part}"` };
                node = node[part];
            }
            const flatten = (v, d) => {
                if (v == null) return v;
                const t = typeof v;
                if (t === 'string' || t === 'number' || t === 'boolean') return v;
                if (t === 'function') return `[function ${v.name || 'anonymous'}]`;
                if (t !== 'object') return String(v);
                if (d <= 0) return `[${v.constructor?.name || 'object'}]`;
                if (Array.isArray(v)) return v.slice(0, 50).map((x) => flatten(x, d - 1));
                const out = {};
                let keys;
                try { keys = Object.keys(v).slice(0, 60); } catch { return `[${v.constructor?.name}]`; }
                for (const k of keys) {
                    try { out[k] = flatten(v[k], d - 1); } catch { out[k] = '[throws]'; }
                }
                return out;
            };
            return flatten(node, Math.max(0, Math.min(4, depth)));
        },

        /** Everything cheap, in one round-trip. */
        summary() {
            return {
                renderer: api.rendererInfo(),
                memory: api.memory(),
                scene: api.sceneInfo(),
                renderTargets: (() => { const rt = api.renderTargets(); return { count: rt.count, estTotalMB: rt.estTotalMB }; })(),
                materials: (() => { const m = api.materials(); return m.error ? m : { totalInstances: m.totalInstances, redundantClones: m.redundantClones }; })(),
            };
        },
    };

    globalThis.__maxjs = api;
    return api;
}

export { installDebugBridge };

// maxjs_webapp.js — WebApp Animator origin nodes synced from Max.
// Each TJS_WebApp node mounts one or more web UI instances whose transforms
// follow the Max node and whose named param channels are driven by Max
// animation curves. Params arrive via the webapp_update JSON message
// (change-detected in C++ at the current time, so curves/wires/expressions
// all work); transforms ride the binary UpdateWebApp delta command.
//
// Presentations:
//   - css3d:   crisp DOM overlay (front root) — or, with Depth Occlude on,
//              a behind-canvas root + punch-through compositing so scene
//              geometry occludes the DOM per pixel.
//   - texture: drawElementImage → CanvasTexture plane (in-scene pixels;
//              post FX, depth, and render output all apply).
//
// Layer stacks: layerCount > 1 mounts N instances of the page offset along
// the panel normal by layerGap (animatable, world units). Each instance is
// told its layer via ?maxjs-layer=i URL query, a {type:'maxjs:layer'}
// message, and (same-origin/shadow hosts) an injected per-instance
// stylesheet driven by data-maxjs-layer tags.
//
// Param delivery to pages, per update:
//   - CSS variable --param-<name> + dataset on each host element
//   - same-origin iframes: --param-<name> on the content documentElement
//   - iframes: postMessage({ type: 'maxjs:params', params })
//   - texture/shadow pages: window-level maxjs:params + maxjs-params

import {
    createCSS3DDivHost,
    createCSS3DHost,
    formatParamValue,
    postParamsToIframe,
    resolveWebappUrl,
    teardownWebappHost,
    writeHostParam,
    writeIframeContentParam,
} from './webapp_host.js';
import { createHTMLTexture } from './html_texture.js';

const MAX_LAYER_COUNT = 8;
const MAX_PUNCH_RECTS = 8;

function layerUrl(url, index, count) {
    if (!url || count <= 1) return url;
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}maxjs-layer=${index}&maxjs-layers=${count}`;
}

// Per-instance stylesheet for layer stacks. Contract: tag top-level
// containers data-maxjs-layer="0..N-1" (background → foreground); untagged
// content belongs to layer 0. `html` matches both real documents (srcdoc)
// and the <html> element injected into texture-mode shadow roots.
function layerCss(index, count) {
    if (count <= 1) return '';
    const identity = `html{--maxjs-layer-index:${index};--maxjs-layer-count:${count};}`;
    // Layer containers pass pointer hit-testing through (the forwarder walks
    // layers near→far and needs elementFromPoint to skip transparent regions);
    // interactive elements opt back in automatically, anything else via
    // data-maxjs-interactive.
    const hitTest = '[data-maxjs-layer]{pointer-events:none !important;}' +
        '[data-maxjs-layer] :is(button,a,input,select,textarea,summary,label,[data-maxjs-interactive]){pointer-events:auto;}';
    if (index === 0) {
        return `${identity}${hitTest}[data-maxjs-layer]:not([data-maxjs-layer="0"]){display:none !important;}`;
    }
    return `${identity}${hitTest}body > :not([data-maxjs-layer="${index}"]):not(script):not(style){display:none !important;}` +
        'html,body{background:transparent !important;}';
}

export function createMaxJSWebAppSystem({ THREE, parent, getProjectBaseUrl, onPunchRectsChanged }) {
    const root = new THREE.Group();
    root.name = '__maxjs_webapp_origins__';
    root.matrixAutoUpdate = false;
    root.userData.maxjsExcludeFromRuntimeSnapshot = true;
    parent?.add?.(root);

    // Depth-occluded CSS3D panels render behind the canvas in their own scene
    // (one CSS3DRenderer cannot serve two roots — it writes element display
    // state per render call). behindBasis mirrors the parent basis transform.
    const behindScene = new THREE.Scene();
    const behindBasis = new THREE.Group();
    behindBasis.name = '__maxjs_webapp_behind_basis__';
    behindBasis.matrixAutoUpdate = false;
    behindScene.add(behindBasis);
    let behindMountCount = 0;

    const entryMap = new Map();
    // The C++ gizmo is an upright panel in the node's local XZ plane facing -Y;
    // a CSS3D/texture plane lies in local XY facing +Z, so bake in +90° X.
    const ROT_X_90 = new THREE.Matrix4().makeRotationX(Math.PI / 2);
    const occluderGeometry = new THREE.PlaneGeometry(1, 1);  // unit rect, shared

    // Web Panels UI subscription. webapp_update fires 30-60 Hz during
    // playback, so notifications are rAF-coalesced and fire only when a
    // structural field the panel list shows actually changed — transform
    // and param-channel traffic never reaches subscribers.
    const subscribers = new Set();
    let notifyQueued = false;
    function notifySubscribers() {
        if (notifyQueued) return;
        notifyQueued = true;
        requestAnimationFrame(() => {
            notifyQueued = false;
            refreshPunchState();
            for (const fn of subscribers) {
                try { fn(); } catch (error) { console.warn('[max.js webapp] subscriber failed', error); }
            }
        });
    }
    function structuralSignature(entry) {
        const d = entry.data;
        if (!d) return '';
        return [entry.name, d.url, d.presentation, d.interactive, d.width, d.height,
            d.depthOcclude ? 1 : 0, d.layerCount, entry.visible ? 1 : 0].join('|');
    }

    // ── Punch-through state (Depth Occlude × post FX) ───────────────────
    // FX pipeline inactive → occluder meshes punch alpha-0 holes directly in
    // the direct-render path. FX pipeline active → occluders hide and their
    // matrixWorlds feed the webPanelPunch analytic mask instead.
    let punchPipelineActive = false;
    let punchSuppressed = false;
    let lastPunchRectCount = -1;

    function collectPunchRects() {
        const rects = [];
        outer:
        for (const entry of entryMap.values()) {
            if (!entry.data?.depthOcclude || !entry.visible) continue;
            for (const inst of entry.instances) {
                if (!inst.occluder) continue;
                rects.push({
                    object: inst.occluder,
                    getOpacity: () => entry.data?.opacity ?? 1,
                });
                if (rects.length >= MAX_PUNCH_RECTS) {
                    console.warn(`[max.js webapp] depth-occlude rect cap (${MAX_PUNCH_RECTS}) reached — extra layers/panels keep occluder-mesh mode only`);
                    break outer;
                }
            }
        }
        return rects;
    }

    function refreshPunchState() {
        const occludersVisible = !punchPipelineActive && !punchSuppressed;
        for (const entry of entryMap.values()) {
            const show = occludersVisible && entry.visible && !!entry.data?.depthOcclude;
            for (const inst of entry.instances) {
                if (inst.occluder) inst.occluder.visible = show;
            }
        }
        const rects = (punchPipelineActive && !punchSuppressed) ? collectPunchRects() : [];
        if (rects.length !== lastPunchRectCount) {
            lastPunchRectCount = rects.length;
            onPunchRectsChanged?.(rects);
        } else if (rects.length > 0) {
            onPunchRectsChanged?.(rects);  // same count, possibly different objects
        }
    }

    function setPunchPipelineActive(active) {
        active = !!active;
        if (active === punchPipelineActive) return;
        punchPipelineActive = active;
        refreshPunchState();
    }

    // Force-disable all punching (e.g. during render-to-image capture so the
    // output never ships alpha holes — CSS3D panels are absent from canvas
    // output either way).
    function setPunchSuppressed(suppressed) {
        suppressed = !!suppressed;
        if (suppressed === punchSuppressed) return;
        punchSuppressed = suppressed;
        refreshPunchState();
    }

    function getBehindScene() {
        if (behindMountCount === 0) return null;
        if (parent) {
            behindBasis.matrix.copy(parent.matrixWorld);
            behindBasis.matrixWorldNeedsUpdate = true;
        }
        return behindScene;
    }

    // ── Data shaping ─────────────────────────────────────────────────────

    function normalizeData(data) {
        const presentation = data?.presentation === 'texture' ? 'texture' : 'css3d';
        const layerCount = Math.min(MAX_LAYER_COUNT, Math.max(1, Math.round(Number(data?.layerCount) || 1)));
        const layerGap = Number.isFinite(Number(data?.layerGap)) ? Number(data.layerGap) : 5;
        return {
            url: typeof data?.url === 'string' ? data.url : '',
            width: Math.max(1, Math.round(Number(data?.width) || 1280)),
            height: Math.max(1, Math.round(Number(data?.height) || 720)),
            displaySize: Math.max(0.001, Number(data?.displaySize) || 50),
            opacity: data?.opacity == null ? 1 : Math.min(1, Math.max(0, Number(data.opacity) || 0)),
            interactive: data?.interactive === true,
            presentation,
            // Depth occlusion is a CSS3D-compositing concept; texture panels
            // are already depth-correct scene pixels.
            depthOcclude: presentation === 'css3d' && data?.depthOcclude === true,
            layerCount,
            layerGap,
            params: (data?.params && typeof data.params === 'object') ? data.params : {},
        };
    }

    function needsRemount(prev, next) {
        return !prev
            || prev.url !== next.url
            || prev.presentation !== next.presentation
            || prev.width !== next.width
            || prev.height !== next.height
            || prev.interactive !== next.interactive
            || prev.depthOcclude !== next.depthOcclude
            || prev.layerCount !== next.layerCount;
        // layerGap intentionally absent — animated gap repositions in place.
    }

    // ── Transforms ───────────────────────────────────────────────────────

    function composeTransform(entry) {
        const d = entry.data;
        if (!d) return;
        entry.group.matrix.copy(entry.maxMatrix).multiply(ROT_X_90);
        entry.group.matrixWorldNeedsUpdate = true;
        if (entry.behindGroup) {
            entry.behindGroup.matrix.copy(entry.group.matrix);
            entry.behindGroup.matrixWorldNeedsUpdate = true;
        }

        const s = d.displaySize / d.width;
        const objScale = entry.presentation === 'texture' ? s / 0.001 : s;
        const aspect = d.height / d.width;
        for (let i = 0; i < entry.instances.length; i++) {
            const inst = entry.instances[i];
            const z = i * d.layerGap;
            if (inst.obj) {
                inst.obj.position.set(0, 0, z);
                inst.obj.scale.setScalar(objScale);
                inst.obj.visible = entry.visible;
            }
            if (inst.occluder) {
                inst.occluder.position.set(0, 0, z);
                inst.occluder.scale.set(d.displaySize, d.displaySize * aspect, 1);
            }
        }
    }

    // ── Param / opacity application ──────────────────────────────────────

    function applyOpacity(entry, force = false) {
        if (!entry.data) return;
        const opacity = entry.data.opacity;
        if (!force && opacity === entry.lastOpacity) return;
        entry.lastOpacity = opacity;
        for (const inst of entry.instances) {
            if (!inst.host && !inst.obj) continue;
            if (entry.presentation === 'css3d') {
                if (inst.host) inst.host.style.opacity = String(opacity);
            } else if (inst.obj?.material) {
                inst.obj.material.transparent = true;
                inst.obj.material.opacity = opacity;
            }
        }
    }

    function applyParams(entry, force = false) {
        if (!entry.data) return;
        const params = entry.data.params;
        const json = JSON.stringify(params);
        if (!force && json === entry.lastParamsJson) return;
        entry.lastParamsJson = json;

        let anyTexture = false;
        for (const inst of entry.instances) {
            if (!inst.host) continue;
            for (const [name, value] of Object.entries(params)) {
                const formatted = formatParamValue(value);
                writeHostParam(inst.host, name, formatted);
                if (inst.isIframe && inst.sameOrigin) writeIframeContentParam(inst.host, name, formatted);
            }
            if (inst.htmlTex) {
                inst.htmlTex.updateParams(params);
                anyTexture = true;
            } else if (inst.isIframe) {
                postParamsToIframe(inst.host, params);
            } else if (inst.divHost) {
                anyTexture = true;  // div-host scripts live in the main window — window-level delivery
            }
        }
        if (anyTexture) {
            // Shadow-hosted pages run in the main window — canonical contract
            // message alongside the html-texture 'maxjs-params' convention
            // (already posted by updateParams above).
            try { window.postMessage({ type: 'maxjs:params', params }, '*'); } catch {}
        }
    }

    function postLayerIdentity(entry, inst, index) {
        if (!inst.isIframe || !entry.data) return;
        const count = entry.data.layerCount;
        try { inst.host.contentWindow?.postMessage({ type: 'maxjs:layer', index, count }, '*'); } catch {}
    }

    function applyAll(entry) {
        composeTransform(entry);
        applyOpacity(entry, true);
        applyParams(entry, true);
        refreshPunchState();
    }

    // ── Mounting ─────────────────────────────────────────────────────────

    function teardownInstance(inst) {
        if (!inst) return;
        if (inst.occluder) {
            try { inst.occluder.parent?.remove(inst.occluder); } catch {}
            try { inst.occluder.material?.dispose(); } catch {}
            inst.occluder = null;
        }
        if (inst.htmlTex) {
            try { inst.obj?.parent?.remove(inst.obj); } catch {}
            try { inst.obj?.geometry?.dispose(); } catch {}
            try { inst.obj?.material?.dispose(); } catch {}
            try { inst.htmlTex.cleanup(); } catch {}
            inst.htmlTex = null;
            inst.obj = null;
            inst.host = null;
            return;
        }
        teardownWebappHost(inst);
        inst.obj = null;
        inst.host = null;
    }

    function teardownEntryInstances(entry) {
        for (const inst of entry.instances) teardownInstance(inst);
        entry.instances.length = 0;
        if (entry.behindGroup) {
            try { entry.behindGroup.parent?.remove(entry.behindGroup); } catch {}
            entry.behindGroup = null;
            behindMountCount = Math.max(0, behindMountCount - 1);
        }
    }

    function makeOccluder(entry) {
        // Writes depth + RGBA(0,0,0,0): in the direct-render path this punches
        // the alpha hole natively. Hidden whenever the FX pipeline is active —
        // its depth write would pollute GTAO/DOF and re-seal coverage alpha;
        // the webPanelPunch mask takes over there.
        const material = new THREE.MeshBasicMaterial({
            color: 0x000000,
            opacity: 0,
            transparent: false,
            blending: THREE.NoBlending,
            side: THREE.DoubleSide,
            depthWrite: true,
        });
        const mesh = new THREE.Mesh(occluderGeometry, material);
        mesh.name = `webapp_occluder_${entry.handle}`;
        mesh.userData.maxjsExcludeFromRuntimeSnapshot = true;
        mesh.raycast = () => {};  // invisible to scene raycasters (selection, html textures)
        return mesh;
    }

    function buildTextureInstance(entry, url, index) {
        // Same pipeline as the max.js HTML texture map: Chromium rasterizes
        // the live DOM into a CanvasTexture via drawElementImage, so the
        // panel is real scene pixels. Each instance owns its texture (no
        // shared material-slot cache — independent params per node/layer).
        const d = entry.data;
        const handle = createHTMLTexture(THREE, url, {
            width: d.width,
            height: d.height,
            params: d.params,
            injectCss: layerCss(index, d.layerCount),
        });
        const geometry = new THREE.PlaneGeometry(d.width * 0.001, d.height * 0.001);
        const material = new THREE.MeshBasicMaterial({
            map: handle.texture,
            transparent: true,
            side: THREE.DoubleSide,
        });
        const host = handle.texture.userData.maxjsHTMLHost;
        // The global raycast forwarder treats any tagged map as clickable;
        // untag when the node isn't interactive so it doesn't eat viewport input.
        if (!d.interactive) delete handle.texture.userData.maxjsHTMLHost;
        return {
            obj: new THREE.Mesh(geometry, material),
            host,
            isIframe: false,
            sameOrigin: true,
            presentation: 'texture',
            htmlTex: handle,
            occluder: null,
        };
    }

    async function buildCSS3DInstance(entry, url, index) {
        const d = entry.data;
        // Experimental preserve-3d sub-mode: opt in by appending
        // maxjs-host=div to the node URL. The page is shadow-injected onto a
        // div so inner translateZ floats in true scene depth.
        const useDivHost = /[?&]maxjs-host=div\b/i.test(d.url) || /[?&]maxjs-host=div\b/i.test(url);
        const spec = {
            url: layerUrl(url, index, d.layerCount),
            width: d.width,
            height: d.height,
            interactive: d.interactive,
            behind: d.depthOcclude,
            adoptLocal: d.depthOcclude,
            injectCss: layerCss(index, d.layerCount),
        };
        const built = useDivHost
            ? await createCSS3DDivHost(spec)
            : await createCSS3DHost(spec);
        built.htmlTex = null;
        built.occluder = null;
        return built;
    }

    async function remount(entry) {
        const version = ++entry.mountVersion;
        teardownEntryInstances(entry);
        refreshPunchState();

        const data = entry.data;
        const resolved = resolveWebappUrl(data.url, getProjectBaseUrl?.());

        let built = null;
        try {
            if (data.presentation === 'texture') {
                built = [];
                for (let i = 0; i < data.layerCount; i++) {
                    built.push(buildTextureInstance(entry, layerUrl(resolved, i, data.layerCount), i));
                }
            } else {
                built = await Promise.all(
                    Array.from({ length: data.layerCount }, (_, i) => buildCSS3DInstance(entry, resolved, i)),
                );
            }
        } catch (error) {
            console.warn('[max.js webapp] host mount failed', error);
            return;
        }

        if (version !== entry.mountVersion || !entryMap.has(entry.handle)) {
            for (const inst of built) teardownInstance(inst);
            return;
        }

        entry.presentation = data.presentation;
        entry.instances = built;

        const behind = data.presentation === 'css3d' && data.depthOcclude;
        if (behind) {
            entry.behindGroup = new THREE.Group();
            entry.behindGroup.matrixAutoUpdate = false;
            behindBasis.add(entry.behindGroup);
            behindMountCount += 1;
        }

        for (let i = 0; i < built.length; i++) {
            const inst = built[i];
            inst.obj.name = `webapp_origin_${entry.handle}_L${i}`;
            inst.obj.userData.maxjsExcludeFromRuntimeSnapshot = true;
            if (behind) {
                entry.behindGroup.add(inst.obj);
                inst.occluder = makeOccluder(entry);
                entry.group.add(inst.occluder);
            } else {
                entry.group.add(inst.obj);
            }

            if (inst.isIframe) {
                const idx = i;
                inst.host.addEventListener('load', () => {
                    if (entry.mountVersion !== version) return;
                    applyOpacity(entry, true);
                    applyParams(entry, true);
                    postLayerIdentity(entry, inst, idx);
                });
            }
        }

        applyAll(entry);
    }

    // ── Sync entry points ────────────────────────────────────────────────

    function upsertEntry(data) {
        const handle = data?.h;
        if (!Number.isFinite(handle)) return;

        let entry = entryMap.get(handle);
        if (!entry) {
            const group = new THREE.Group();
            group.matrixAutoUpdate = false;
            root.add(group);
            entry = {
                handle,
                name: '',
                group,
                behindGroup: null,
                instances: [],
                presentation: 'css3d',
                mountVersion: 0,
                maxMatrix: new THREE.Matrix4(),
                visible: true,
                data: null,
                lastParamsJson: '',
                lastOpacity: -1,
                lastStructuralSig: '',
            };
            entryMap.set(handle, entry);
        }

        if (Array.isArray(data.t) && data.t.length === 16) {
            entry.maxMatrix.fromArray(data.t);
        }
        if (data.v != null) entry.visible = !!data.v;
        if (typeof data.n === 'string' && data.n) entry.name = data.n;

        const previous = entry.data;
        entry.data = normalizeData(data);

        const signature = structuralSignature(entry);
        if (signature !== entry.lastStructuralSig) {
            entry.lastStructuralSig = signature;
            notifySubscribers();
        }

        if (needsRemount(previous, entry.data)) {
            remount(entry);
            return;
        }

        composeTransform(entry);
        applyOpacity(entry);
        applyParams(entry);
    }

    function destroyEntry(handle) {
        const entry = entryMap.get(handle);
        if (!entry) return;
        entry.mountVersion += 1;  // cancel any in-flight mount
        teardownEntryInstances(entry);
        try { entry.group.parent?.remove(entry.group); } catch {}
        entryMap.delete(handle);
        notifySubscribers();
    }

    function applyWebApps(webappData = []) {
        const incoming = new Set();
        for (const data of webappData) {
            if (Number.isFinite(data?.h)) incoming.add(data.h);
        }
        for (const handle of [...entryMap.keys()]) {
            if (!incoming.has(handle)) destroyEntry(handle);
        }
        for (const data of webappData) upsertEntry(data);
    }

    function applyWebAppUpdates(webappData = []) {
        for (const data of webappData) upsertEntry(data);
    }

    function applyWebAppTransformBinary(handle, matrix, visible) {
        const entry = entryMap.get(handle);
        if (!entry) return;
        entry.maxMatrix.fromArray(matrix);
        if (entry.visible !== visible) {
            entry.visible = visible;
            notifySubscribers();
        }
        composeTransform(entry);
    }

    // ── Introspection (Web Panels UI, pointer forwarding) ────────────────

    function listPanels() {
        const out = [];
        for (const entry of entryMap.values()) {
            const d = entry.data;
            if (!d) continue;
            out.push({
                handle: entry.handle,
                name: entry.name || `WebApp ${entry.handle}`,
                url: d.url,
                presentation: d.presentation,
                depthOcclude: d.depthOcclude,
                layerCount: d.layerCount,
                opacity: d.opacity,
                interactive: d.interactive,
                visible: entry.visible,
            });
        }
        out.sort((a, b) => a.handle - b.handle);
        return out;
    }

    function subscribe(fn) {
        subscribers.add(fn);
        return () => subscribers.delete(fn);
    }

    // Interactive depth-occluded panels: the canvas covers them, so input is
    // raycast-forwarded (dom_panel_forwarding.js) against the occluder rects.
    function listForwardTargets() {
        const out = [];
        for (const entry of entryMap.values()) {
            const d = entry.data;
            if (!d?.depthOcclude || !d.interactive || !entry.visible) continue;
            for (const inst of entry.instances) {
                if (!inst.occluder || !inst.host) continue;
                out.push({
                    object: inst.occluder,
                    width: d.width,
                    height: d.height,
                    layered: d.layerCount > 1,
                    getDocument() {
                        try { return inst.sameOrigin ? inst.host.contentDocument : null; } catch { return null; }
                    },
                    getWindow() {
                        try { return inst.host.contentWindow; } catch { return null; }
                    },
                });
            }
        }
        return out;
    }

    function dispose() {
        for (const handle of [...entryMap.keys()]) destroyEntry(handle);
        if (root.parent) root.parent.remove(root);
    }

    return {
        applyWebApps,
        applyWebAppUpdates,
        applyWebAppTransformBinary,
        destroyEntry,
        listPanels,
        listForwardTargets,
        subscribe,
        getBehindScene,
        setPunchPipelineActive,
        setPunchSuppressed,
        dispose,
    };
}

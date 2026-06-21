// ipr_client.js — injected into the snapshot page by the Blender add-on's
// overlay server to turn a static snapshot into a LIVE viewer.
//
// Translation-layer payoff: it decodes Blender's MXJB delta frames with the
// SAME web/js/protocol.js the 3ds Max WebView uses, then applies them through
// maxjsPlayer. Nothing in web/ is forked — this is additive glue served from
// the add-on, talking only to its own /maxjs/delta endpoint.

import * as THREE from 'three';
import { applyDeltaFrame } from '/js/protocol.js';

const POLL_MS = 60;

// Re-localization identical to scene_applier.js applyTransform (not exported,
// so mirrored here): MXJB transforms are WORLD matrices in Max/Z-up space; for
// parented nodes we express them relative to the parent within the basis root.
const _s = {
    raw: new THREE.Matrix4(),
    rootInv: new THREE.Matrix4(),
    parentInRoot: new THREE.Matrix4(),
    parentInv: new THREE.Matrix4(),
};

function applyTransform(obj, t, maxRoot) {
    _s.raw.fromArray(t);
    if (obj.parent && maxRoot && obj.parent !== maxRoot) {
        maxRoot.updateMatrixWorld(true);
        obj.parent.updateMatrixWorld(true);
        _s.rootInv.copy(maxRoot.matrixWorld).invert();
        _s.parentInRoot.copy(_s.rootInv).multiply(obj.parent.matrixWorld);
        _s.parentInv.copy(_s.parentInRoot).invert();
        _s.raw.premultiply(_s.parentInv);
    }
    obj.matrixAutoUpdate = false;
    obj.matrix.copy(_s.raw);
    obj.matrixWorldNeedsUpdate = true;
}

function makeHandlers(player) {
    return {
        onTransform(h, m) {
            const o = player.nodeMap?.get(h);
            if (o) applyTransform(o, m, player.maxRoot);
        },
        onVisibility(h, vis) {
            const o = player.nodeMap?.get(h);
            if (o) o.visible = vis;
        },
        onMaterialScalar(h, { color, rough, metal, opacity }) {
            const o = player.nodeMap?.get(h);
            if (!o) return;
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            for (const mat of mats) {
                if (!mat) continue;
                if (mat.color?.setRGB) mat.color.setRGB(color[0], color[1], color[2]);
                if ("roughness" in mat) mat.roughness = rough;
                if ("metalness" in mat) mat.metalness = metal;
                if (opacity < 0.999) { mat.transparent = true; mat.opacity = opacity; }
                mat.needsUpdate = true;
            }
        },
        onLight(h, d) {
            const L = player.lightHandleMap?.get(h);
            if (!L) return;
            if (L.color && d.color) L.color.setRGB(d.color[0], d.color[1], d.color[2]);
            if ("intensity" in L) L.intensity = d.intensity;
            if ("visible" in L) L.visible = d.visible;
            if ("angle" in L && d.angle) L.angle = d.angle;
            if ("penumbra" in L) L.penumbra = d.penumbra;
        },
        // Camera is intentionally not applied: the viewer keeps its own
        // OrbitControls so the user can look around while Blender drives content.
    };
}

function applyBlob(buffer, handlers) {
    const dv = new DataView(buffer);
    let o = 0;
    const nextCursor = dv.getUint32(o, true); o += 4;
    const count = dv.getUint32(o, true); o += 4;
    for (let i = 0; i < count; i++) {
        const len = dv.getUint32(o, true); o += 4;
        const frame = buffer.slice(o, o + len); o += len;
        try { applyDeltaFrame(frame, handlers); }
        catch (e) { console.warn("[max.js IPR] frame decode failed", e); }
    }
    return { nextCursor, count };
}

function badge(text, ok) {
    let el = document.getElementById("maxjs-ipr-badge");
    if (!el) {
        el = document.createElement("div");
        el.id = "maxjs-ipr-badge";
        el.style.cssText = "position:fixed;left:10px;bottom:10px;z-index:99999;" +
            "font:12px/1.4 system-ui,sans-serif;padding:4px 9px;border-radius:6px;" +
            "background:rgba(0,0,0,.6);color:#fff;pointer-events:none;backdrop-filter:blur(4px)";
        document.body.appendChild(el);
    }
    el.textContent = text;
    el.style.color = ok ? "#7CFC9B" : "#FFB454";
}

async function waitForPlayer() {
    for (let i = 0; i < 600; i++) {
        if (window.maxjsPlayer?.nodeMap) return window.maxjsPlayer;
        await new Promise((r) => setTimeout(r, 100));
    }
    return window.maxjsPlayer || null;
}

async function main() {
    const player = await waitForPlayer();
    if (!player) { badge("max.js IPR: no player", false); return; }
    const handlers = makeHandlers(player);
    let since = 0;
    let frames = 0;
    badge("max.js IPR ● live", true);

    async function poll() {
        try {
            const res = await fetch(`/maxjs/delta?since=${since}`, { cache: "no-store" });
            if (res.status === 200) {
                const { nextCursor, count } = applyBlob(await res.arrayBuffer(), handlers);
                since = nextCursor;
                if (count) { frames += count; badge(`max.js IPR ● live · ${frames} frames`, true); }
            }
        } catch (e) {
            badge("max.js IPR ○ disconnected", false);
        }
        setTimeout(poll, POLL_MS);
    }
    poll();
}

main();

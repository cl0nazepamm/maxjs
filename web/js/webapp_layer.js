// webapp_layer.js — mounts a webapp (HTML page or URL) into the MaxJS viewport.
// Two presentation modes:
//   - css3d:  iframe wrapped in a CSS3DObject (crisp DOM, clickable, overlay only).
//   - texture: HTMLMesh from three/addons (DOM rasterized to a plane mesh, composites with WebGL).
// Animation:
//   - anchor: a named Max node provides per-frame transform via matrixWorld decomposition.
//   - params: each declared param writes to host as CSS variable, dataset attribute, and postMessage.
//
// Phase 1 supports static params (spec.params[name].value). Live Max-driven params land in phase 2.

import * as overlay from './css3d_overlay.js';

const DEFAULT_SIZE = { width: 1280, height: 720 };
const DEFAULT_SCALE = 0.001;

function readNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function readSize(size) {
    return {
        width:  readNumber(size?.width,  DEFAULT_SIZE.width),
        height: readNumber(size?.height, DEFAULT_SIZE.height),
    };
}

function formatParamValue(value) {
    if (typeof value === 'number') return String(value);
    if (typeof value === 'boolean') return value ? '1' : '0';
    if (Array.isArray(value) && value.every(n => typeof n === 'number')) {
        if (value.length === 3) return `rgb(${value.map(v => Math.round(v * 255)).join(',')})`;
        return value.join(',');
    }
    return String(value ?? '');
}

function writeStaticParam(host, name, formatted) {
    try { host.style.setProperty(`--param-${name}`, formatted); } catch {}
    try { host.dataset[name] = formatted; } catch {}
}

function postParamsToIframe(iframe, params) {
    try {
        iframe?.contentWindow?.postMessage({ type: 'maxjs:params', params }, '*');
    } catch {}
}

async function buildCSS3DHost(spec, ctx) {
    const { CSS3DObject } = await overlay.acquire();
    const size = readSize(spec.size);
    const iframe = document.createElement('iframe');
    iframe.style.width = `${size.width}px`;
    iframe.style.height = `${size.height}px`;
    iframe.style.border = '0';
    iframe.style.background = 'transparent';
    iframe.style.pointerEvents = spec.interactive ? 'auto' : 'none';
    iframe.setAttribute('frameborder', '0');
    iframe.setAttribute('allowtransparency', 'true');
    const url = resolveUrl(spec.url, ctx);
    if (url) iframe.src = url;
    const obj = new CSS3DObject(iframe);
    const scale = readNumber(spec.scale, DEFAULT_SCALE);
    obj.scale.setScalar(scale);
    return { obj, host: iframe, isIframe: true };
}

async function buildTextureHost(spec, ctx, THREE) {
    const { HTMLMesh } = await import('three/addons/interactive/HTMLMesh.js');
    const size = readSize(spec.size);
    const host = document.createElement('div');
    host.style.position = 'fixed';
    host.style.left = '-99999px';
    host.style.top = '0';
    host.style.width = `${size.width}px`;
    host.style.height = `${size.height}px`;
    host.style.background = 'transparent';
    host.style.pointerEvents = 'none';
    document.body.appendChild(host);

    const url = resolveUrl(spec.url, ctx);
    if (url) {
        try {
            const html = await fetch(url, { cache: 'no-store' }).then(r => r.text());
            const doc = new DOMParser().parseFromString(html, 'text/html');
            for (const styleEl of doc.querySelectorAll('style, link[rel="stylesheet"]')) {
                host.appendChild(styleEl.cloneNode(true));
            }
            host.appendChild(doc.body.cloneNode(true));
        } catch (error) {
            host.textContent = `webapp fetch failed: ${error?.message || error}`;
        }
    }

    const mesh = new HTMLMesh(host);
    const scale = readNumber(spec.scale, DEFAULT_SCALE);
    mesh.scale.setScalar(scale / 0.001);
    return { obj: mesh, host, isIframe: false };
}

function resolveUrl(rawUrl, ctx) {
    if (!rawUrl) return '';
    if (/^https?:\/\//i.test(rawUrl) || /^data:/i.test(rawUrl)) return rawUrl;
    const state = ctx.project?.getState?.();
    const baseUrl = state?.projectRootUrl;
    if (!baseUrl) return rawUrl;
    try {
        const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
        return new URL(rawUrl.replace(/\\/g, '/'), base).toString();
    } catch {
        return rawUrl;
    }
}

export function createWebappLayer(ctx, THREE, spec) {
    if (!spec || typeof spec !== 'object') {
        throw new Error('createWebappLayer: spec is required');
    }
    const presentation = spec.presentation === 'texture' ? 'texture' : 'css3d';
    let entry = null;       // { obj, host, isIframe }
    let anchorAdapter = null;
    let anchorResolved = false;
    let disposed = false;
    const tmpMatrix = new THREE.Matrix4();
    const tmpPos = new THREE.Vector3();
    const tmpQuat = new THREE.Quaternion();
    const tmpScale = new THREE.Vector3();

    async function mount() {
        if (disposed) return;
        try {
            entry = presentation === 'css3d'
                ? await buildCSS3DHost(spec, ctx)
                : await buildTextureHost(spec, ctx, THREE);
            if (disposed) {
                teardownEntry(entry);
                entry = null;
                return;
            }
            entry.obj.matrixAutoUpdate = true;
            ctx.js.add(entry.obj);
            applyStaticParams();
        } catch (error) {
            ctx.runtime.error('webapp_layer mount failed', error);
        }
    }

    function applyStaticParams() {
        if (!entry || !spec.params) return;
        const staticPayload = {};
        for (const [name, decl] of Object.entries(spec.params)) {
            if (!decl) continue;
            if (decl.value !== undefined) {
                const formatted = formatParamValue(decl.value);
                writeStaticParam(entry.host, name, formatted);
                staticPayload[name] = decl.value;
            }
        }
        if (entry.isIframe && Object.keys(staticPayload).length > 0) {
            const iframe = entry.host;
            const send = () => postParamsToIframe(iframe, staticPayload);
            if (iframe.contentDocument?.readyState === 'complete') send();
            else iframe.addEventListener('load', send, { once: true });
        }
    }

    function resolveAnchor() {
        if (anchorResolved || !spec.anchor) return;
        const found = ctx.maxScene.findByName(spec.anchor, { exact: true });
        if (found && found.length > 0) {
            anchorAdapter = found[0];
            anchorResolved = true;
        }
    }

    function applyAnchorTransform() {
        if (!entry || !anchorAdapter) return;
        const sourceMatrix = anchorAdapter.matrixWorld;
        if (!sourceMatrix) return;
        tmpMatrix.copy(sourceMatrix);
        tmpMatrix.decompose(tmpPos, tmpQuat, tmpScale);
        entry.obj.position.copy(tmpPos);
        entry.obj.quaternion.copy(tmpQuat);
        // Preserve declared host scale; multiply in anchor scale.
        const baseScale = readNumber(spec.scale, DEFAULT_SCALE);
        const sizeScale = presentation === 'texture' ? baseScale / 0.001 : baseScale;
        entry.obj.scale.set(tmpScale.x * sizeScale, tmpScale.y * sizeScale, tmpScale.z * sizeScale);
    }

    function teardownEntry(target) {
        if (!target) return;
        try { target.obj.parent?.remove(target.obj); } catch {}
        if (typeof target.obj.dispose === 'function') {
            try { target.obj.dispose(); } catch {}
        }
        if (target.host?.parentNode) {
            try { target.host.parentNode.removeChild(target.host); } catch {}
        }
    }

    // Kick off mounting asynchronously; ctx.runtime is fine to use.
    const mountPromise = mount();

    return {
        async init() {
            await mountPromise;
        },
        update(ctxArg, dt) {
            if (!entry) return;
            if (!anchorResolved) resolveAnchor();
            if (anchorAdapter) applyAnchorTransform();
        },
        dispose() {
            disposed = true;
            if (entry) {
                teardownEntry(entry);
                entry = null;
            }
            if (presentation === 'css3d') overlay.release();
        },
    };
}

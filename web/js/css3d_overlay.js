// css3d_overlay.js — lazy singletons wrapping CSS3DRenderers on DOM divs.
// Two roots:
//   - front (z-index 1, above the WebGL canvas): normal overlay panels.
//   - behind (z-index -1, under the alpha:true canvas): depth-occluded
//     panels — punch-through compositing makes scene geometry occlude the
//     DOM per pixel. The behind layer renders a SEPARATE scene because one
//     CSS3DRenderer writes element display state per render call, so two
//     renderers cannot share one object set.
// webapp_layer.js / maxjs_webapp.js acquire; index.html ticks each frame.

let cssRenderer = null;
let rootEl = null;
let behindRenderer = null;
let behindRootEl = null;
let refCount = 0;
let loaderPromise = null;
let cachedCSS3DObject = null;
let cachedCSS3DRendererCtor = null;

async function loadRenderer() {
    if (loaderPromise) return loaderPromise;
    loaderPromise = import('three/addons/renderers/CSS3DRenderer.js')
        .then(mod => {
            cachedCSS3DObject = mod.CSS3DObject;
            cachedCSS3DRendererCtor = mod.CSS3DRenderer;
            return mod;
        });
    return loaderPromise;
}

function ensureRoot() {
    if (rootEl) return rootEl;
    const el = document.createElement('div');
    el.id = 'maxjs-css3d-root';
    el.style.position = 'absolute';
    el.style.inset = '0';
    el.style.pointerEvents = 'none';
    el.style.zIndex = '1';
    el.style.overflow = 'hidden';
    document.body.appendChild(el);
    rootEl = el;
    return el;
}

function applyRootRect(el, rect) {
    if (!el) return;
    const x = Number(rect?.x);
    const y = Number(rect?.y);
    const width = Number(rect?.width);
    const height = Number(rect?.height);
    if (
        Number.isFinite(x) &&
        Number.isFinite(y) &&
        Number.isFinite(width) &&
        Number.isFinite(height) &&
        width > 0 &&
        height > 0
    ) {
        el.style.inset = 'auto';
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        el.style.width = `${width}px`;
        el.style.height = `${height}px`;
        return;
    }
    el.style.inset = '0';
    el.style.left = '';
    el.style.top = '';
    el.style.width = '';
    el.style.height = '';
}

export async function acquire() {
    const mod = await loadRenderer();
    if (!cssRenderer) {
        const el = ensureRoot();
        cssRenderer = new mod.CSS3DRenderer({ element: el });
        cssRenderer.setSize(window.innerWidth, window.innerHeight);
    }
    refCount += 1;
    return { CSS3DObject: cachedCSS3DObject, root: rootEl };
}

export function release() {
    if (refCount > 0) refCount -= 1;
    // Keep renderer alive even at 0 — cheap and avoids churn if a layer remounts.
}

function ensureBehindRoot() {
    if (behindRootEl) return behindRootEl;
    const el = document.createElement('div');
    el.id = 'maxjs-css3d-behind-root';
    el.style.position = 'absolute';
    el.style.inset = '0';
    el.style.pointerEvents = 'none';
    el.style.zIndex = '-1';
    el.style.overflow = 'hidden';
    document.body.appendChild(el);
    behindRootEl = el;
    return el;
}

export async function acquireBehind() {
    await loadRenderer();
    if (!behindRenderer) {
        const el = ensureBehindRoot();
        behindRenderer = new cachedCSS3DRendererCtor({ element: el });
        behindRenderer.setSize(window.innerWidth, window.innerHeight);
    }
    refCount += 1;
    return { CSS3DObject: cachedCSS3DObject, root: behindRootEl };
}

export function tick(scene, camera) {
    if (cssRenderer) cssRenderer.render(scene, camera);
}

export function tickBehind(scene, camera) {
    if (behindRenderer && scene) behindRenderer.render(scene, camera);
}

export function setSize(width, height) {
    if (cssRenderer) cssRenderer.setSize(width, height);
    if (behindRenderer) behindRenderer.setSize(width, height);
}

export function setViewportRect(rect) {
    applyRootRect(rootEl, rect);
    applyRootRect(behindRootEl, rect);
}

export function isActive() {
    return cssRenderer !== null;
}

export function getRoot() {
    return rootEl;
}

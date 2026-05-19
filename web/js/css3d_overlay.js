// css3d_overlay.js — lazy singleton wrapping a CSS3DRenderer that draws
// CSS3DObjects from the main Three.js scene on a DOM div over the WebGL canvas.
// webapp_layer.js acquires the overlay; index.html ticks it each frame.

let cssRenderer = null;
let rootEl = null;
let refCount = 0;
let loaderPromise = null;
let cachedCSS3DObject = null;

async function loadRenderer() {
    if (loaderPromise) return loaderPromise;
    loaderPromise = import('three/addons/renderers/CSS3DRenderer.js')
        .then(mod => {
            cachedCSS3DObject = mod.CSS3DObject;
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

export function tick(scene, camera) {
    if (cssRenderer) cssRenderer.render(scene, camera);
}

export function setSize(width, height) {
    if (cssRenderer) cssRenderer.setSize(width, height);
}

export function isActive() {
    return cssRenderer !== null;
}

export function getRoot() {
    return rootEl;
}

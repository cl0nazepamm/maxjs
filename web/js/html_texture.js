// MaxJS HTML Texture helper.
//
// Produces a THREE.CanvasTexture backed by a live HTML document rasterized
// every paint via the WICG CanvasDrawElement API (drawElementImage).
//
// The Chromium flag `--enable-features=CanvasDrawElement` is enabled in
// maxjs_main.cpp InitWebView2 so WebView2 ships the API on startup.
//
// DOM requirements, all of which bit us during the prototype:
//   1. The canvas must have the `layoutsubtree` attribute so its descendants
//      are laid out and painted by the browser.
//   2. The source element must be a DIRECT CHILD of the canvas. We use an
//      <iframe> as that child so the user's HTML document is isolated from
//      the host page and relative URLs resolve cleanly.
//   3. `opacity:0` on the canvas propagates alpha 0 into the rasterized
//      pixels — the texture ends up fully transparent black. Hide the canvas
//      via a 1px overflow:hidden wrapper instead, keeping the canvas at full
//      opacity so paint records are real.
//   4. `canvas.onpaint` is the spec-correct trigger. Fall back to a
//      MutationObserver + RAF debouncer if the hook isn't present.
//   5. drawElementImage signature is (element, x, y) — no width/height.

function hasDrawElement(ctx2d) {
    return typeof ctx2d?.drawElementImage === 'function';
}

let _hostIdCounter = 0;

// Fetch an HTML document and inject its entire <html> tree into `host`'s
// shadow root for style isolation (otherwise injected `<style>` rules and
// universal `*` selectors leak into the host page).
//
// Scripts inside shadow DOM execute when re-created as live nodes, BUT
// `document.getElementById(...)` etc. inside them would target the main
// document, not the shadow tree. We wrap each user script in an IIFE that
// shadows `document` with a small proxy that delegates query methods to
// the shadow root and forwards everything else to the real document.
async function injectHtmlDocument(host, url) {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP ' + response.status + ' for ' + url);
    const text = await response.text();
    const parsed = new DOMParser().parseFromString(text, 'text/html');

    // <base href> so relative URLs resolve against the source file's dir.
    const baseHref = url.replace(/[^/]*$/, '');
    const baseEl = parsed.createElement('base');
    baseEl.setAttribute('href', baseHref);
    parsed.head.insertBefore(baseEl, parsed.head.firstChild);

    const hostId = 'maxjs-html-host-' + (++_hostIdCounter);
    host.id = hostId;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.appendChild(parsed.documentElement);

    // Re-create scripts so they execute. Wrap user code with a `document`
    // proxy bound to the host's shadow root. Inline modules / external
    // src= scripts skip the wrapper since they have their own scope.
    for (const oldScript of shadow.querySelectorAll('script')) {
        const fresh = document.createElement('script');
        for (const attr of oldScript.attributes) fresh.setAttribute(attr.name, attr.value);
        const code = oldScript.textContent || '';
        const isInline = !oldScript.hasAttribute('src');
        if (isInline && code) {
            fresh.textContent =
                "(function(document){" + code + "}).call(this," +
                "(function(){" +
                    "var __sr=window.document.getElementById(" + JSON.stringify(hostId) + ").shadowRoot;" +
                    "var __real=window.document;" +
                    "return new Proxy(__sr,{get:function(t,k){" +
                        "if(k==='body')return t.querySelector('body')||t;" +
                        "if(k==='head')return t.querySelector('head')||t;" +
                        "if(k==='documentElement')return t.querySelector('html')||t;" +
                        "var v=t[k];" +
                        "if(typeof v==='function')return v.bind(t);" +
                        "if(v!==undefined)return v;" +
                        "var r=__real[k];" +
                        "return typeof r==='function'?r.bind(__real):r;" +
                    "}});" +
                "})());";
        } else if (code) {
            fresh.textContent = code;
        }
        oldScript.parentNode.replaceChild(fresh, oldScript);
    }
}

export function createHTMLTexture(THREE, url, options = {}) {
    const width  = Math.max(64, Math.min(4096, options.width  || 1024));
    const height = Math.max(64, Math.min(4096, options.height || 1024));
    const initialParams = options.params;
    // 'shadow' (default) uses DOMParser + shadow root + script proxy.
    // Works for hand-authored HTML/CSS + vanilla JS with broad CSS feature
    // support (gradients, backdrop-filter, background-clip text, borders).
    // 'iframe' uses a real iframe via srcdoc — natural style/script
    // isolation, but `drawElementImage` drops many CSS features during
    // rasterization (gradients, transparent-over-transparent, complex
    // compositing). Opt-in only.
    const mode = options.mode || 'shadow';

    const wrap = document.createElement('div');
    wrap.className = 'maxjs-html-texture-wrap';
    // Keep the canvas + host at full layout size so drawElementImage has
    // a real paint record, but clip the wrapper to 1×1 so nothing leaks
    // visually. A previous revision used `transform: scale(0)` — the
    // WICG spec ignores transforms during rasterization, so the texture
    // still rendered, BUT scale(0) on an ancestor collapses every
    // descendant's getBoundingClientRect() to (0,0,0,0). That broke any
    // user code inside the texture that measured layout (e.g. xp.html's
    // window-drag reads `win.getBoundingClientRect().left` as its start
    // offset, which pinned it to 0 and teleported windows on drag).
    // overflow:hidden clips visually without affecting descendants'
    // measured rects.
    wrap.style.cssText =
        'position:fixed;top:0;left:0;' +
        'width:1px;height:1px;overflow:hidden;' +
        'pointer-events:none;z-index:-1;';

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.setAttribute('layoutsubtree', '');
    canvas.style.cssText =
        'display:block;width:' + width + 'px;height:' + height + 'px;';
    wrap.appendChild(canvas);

    // In iframe mode, the source element is an <iframe> — real browser
    // isolation. In shadow mode, it's a <div> with a shadow root we inject
    // the parsed HTML into.
    let host;
    if (mode === 'iframe') {
        host = document.createElement('iframe');
        host.style.cssText =
            'width:' + width + 'px;height:' + height + 'px;' +
            'border:0;display:block;background:#000;';
        // Fetch HTML text and inject via srcdoc — the iframe's document
        // then lives at about:srcdoc and is same-origin with the parent,
        // avoiding cross-origin-frame blocks from loading an asset URL.
        // A <base href> is injected so relative asset URLs inside the HTML
        // still resolve against the source file's directory.
        fetch(url, { cache: 'no-store' }).then(r => {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.text();
        }).then(text => {
            const baseHref = url.replace(/[^/]*$/, '');
            const baseTag = '<base href="' + baseHref + '">';
            const patched = /<head[^>]*>/i.test(text)
                ? text.replace(/<head[^>]*>/i, m => m + baseTag)
                : '<head>' + baseTag + '</head>' + text;
            host.srcdoc = patched;
        }).catch(err => {
            console.warn('[maxjs html_texture] iframe fetch failed:', url, err);
        });
    } else {
        host = document.createElement('div');
        host.className = 'maxjs-html-texture-host';
        host.style.cssText =
            'width:' + width + 'px;height:' + height + 'px;' +
            'box-sizing:border-box;overflow:hidden;background:#000;color:#fff;';
    }
    canvas.appendChild(host);
    document.body.appendChild(wrap);

    const ctx2d = canvas.getContext('2d');
    ctx2d.fillStyle = '#000';
    ctx2d.fillRect(0, 0, width, height);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    // Tag for the global raycast click handler — it walks all hit
    // materials, looks for any map whose userData.maxjsHTMLHost is set,
    // converts the UV hit to shadow-tree pixel coords, and dispatches.
    texture.userData = texture.userData || {};
    texture.userData.maxjsHTMLHost = host;
    texture.userData.maxjsHTMLWidth = width;
    texture.userData.maxjsHTMLHeight = height;
    // Match bitmap-slot defaults (periodic wrap, centered transform). The
    // CanvasTexture default is ClampToEdge, which on meshes whose UVs
    // extend beyond [0,1] (e.g. Max primitive teapot) stretches edge
    // pixels infinitely instead of tiling.
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.center.set(0.5, 0.5);
    texture.repeat.set(1, 1);
    texture.offset.set(0, 0);
    texture.rotation = 0;
    texture.updateMatrix();

    let warned = false;
    let rafHandle = 0;
    let observer = null;
    let disposed = false;
    let loaded = false;

    function redraw() {
        if (disposed || !loaded) return;
        if (!hasDrawElement(ctx2d)) {
            if (!warned) {
                console.warn(
                    '[maxjs html_texture] drawElementImage not available. ' +
                    'Ensure --enable-features=CanvasDrawElement is set in InitWebView2.'
                );
                warned = true;
            }
            return;
        }
        try {
            ctx2d.clearRect(0, 0, width, height);
            ctx2d.drawElementImage(host, 0, 0);
            texture.needsUpdate = true;
        } catch (e) {
            if (!warned) {
                console.warn('[maxjs html_texture] drawElementImage failed:', e);
                warned = true;
            }
        }
    }

    function scheduleRedraw() {
        if (disposed || rafHandle) return;
        rafHandle = requestAnimationFrame(() => {
            rafHandle = 0;
            redraw();
        });
    }

    function attachObserver() {
        if (mode === 'iframe') return; // iframes have their own render pipeline
        observer = new MutationObserver(scheduleRedraw);
        observer.observe(host, {
            subtree: true,
            childList: true,
            characterData: true,
            attributes: true,
        });
    }

    function postParams(params) {
        if (!params) return;
        try {
            if (mode === 'iframe') {
                host.contentWindow?.postMessage({ type: 'maxjs-params', params }, '*');
            } else {
                // Fired as a window event so user scripts running inside
                // `host` receive a single event regardless of instance.
                window.postMessage({ type: 'maxjs-params', params }, '*');
            }
        } catch (_) { /* ignore */ }
    }

    // Continuous redraw loop. Canvas pixel updates inside the shadow root
    // don't trigger MutationObserver and may not trigger canvas.onpaint on
    // the outer canvas, so we just drive the redraw at the host's animation
    // frame rate. drawElementImage on a 1024² host is sub-millisecond on
    // typical hardware and keeps any embedded animation (CSS or canvas)
    // perfectly in sync with the 3D texture.
    let loopHandle = 0;
    function loop() {
        if (disposed) return;
        redraw();
        loopHandle = requestAnimationFrame(loop);
    }

    function onReady() {
        loaded = true;
        if ('onpaint' in canvas) canvas.onpaint = redraw;
        attachObserver();
        postParams(initialParams);
        loop();
    }

    if (mode === 'iframe') {
        host.addEventListener('load', onReady, { once: true });
    } else {
        injectHtmlDocument(host, url).then(onReady).catch(err => {
            console.warn('[maxjs html_texture] failed to load', url, err);
        });
    }

    function cleanup() {
        if (disposed) return;
        disposed = true;
        if (rafHandle) { cancelAnimationFrame(rafHandle); rafHandle = 0; }
        if (loopHandle) { cancelAnimationFrame(loopHandle); loopHandle = 0; }
        if (observer) { try { observer.disconnect(); } catch (_) {} observer = null; }
        if ('onpaint' in canvas) canvas.onpaint = null;
        try { wrap.remove(); } catch (_) {}
        try { texture.dispose(); } catch (_) {}
    }

    function updateParams(nextParams) {
        postParams(nextParams);
        scheduleRedraw();
    }

    return { texture, cleanup, updateParams };
}

// Module-scope dedup cache. Same HTML file @ same resolution = one wrapper,
// reused across every material slot and mesh that references it.
//
// We do NOT refcount — material templates in the scene sync path don't have
// a reliable dispose hook and would leak refs. Instead, handles live as long
// as their URL is in play. If the user swaps to a different .html file the
// old handle stays alive until the plugin unloads. Acceptable for v1; a
// proper dispose hook is a v2 item.
const _htmlTextureCache = new Map();

export function getOrCreateHTMLTexture(THREE, url, options = {}) {
    const width = options.width || 1024;
    const height = options.height || 1024;
    const key = (options.cacheKey || url) + ':' + width + 'x' + height;
    const existing = _htmlTextureCache.get(key);
    if (existing) {
        if (options.params !== undefined) existing.updateParams(options.params);
        return existing;
    }
    const handle = createHTMLTexture(THREE, url, options);
    _htmlTextureCache.set(key, handle);
    return handle;
}

export function releaseHTMLTexture(_handle) {
    // Intentional no-op in v1 — see comment on _htmlTextureCache.
}

export function disposeAllHTMLTextures() {
    for (const handle of _htmlTextureCache.values()) {
        try { handle.cleanup(); } catch (_) {}
    }
    _htmlTextureCache.clear();
}

// ──────────────────────────────────────────────────────────────────────
//  Click forwarding (texmap interaction)
// ──────────────────────────────────────────────────────────────────────

// Return cumulative offset of `el` inside `host` using offsetLeft/offsetTop
// along the offsetParent chain. Independent of CSS transforms — pure layout.
function offsetWithinHost(el, host) {
    let x = 0, y = 0;
    let cur = el;
    while (cur && cur !== host && cur !== null) {
        x += cur.offsetLeft || 0;
        y += cur.offsetTop || 0;
        cur = cur.offsetParent;
    }
    return { x, y };
}

// Walk the host and return the deepest element whose layout box contains
// (px, py) in host-local pixel coordinates. Handles both shadow-DOM hosts
// (divs with shadowRoot) and iframe hosts (use contentDocument).
function hitTestHost(host, px, py) {
    // Iframe: use elementFromPoint against the content document directly.
    if (host.tagName === 'IFRAME') {
        const doc = host.contentDocument;
        if (!doc) return null;
        const el = doc.elementFromPoint(px, py);
        return el || null;
    }
    const sr = host.shadowRoot;
    if (!sr) return null;
    let hit = null;
    const all = sr.querySelectorAll('*');
    for (const el of all) {
        const w = el.offsetWidth, h = el.offsetHeight;
        if (!w || !h) continue;
        const { x, y } = offsetWithinHost(el, host);
        if (px >= x && px < x + w && py >= y && py < y + h) {
            hit = el;
        }
    }
    return hit;
}

// Walk a material's map slots looking for tagged HTML textures.
const _MAP_KEYS = [
    'map', 'emissiveMap', 'roughnessMap', 'metalnessMap', 'normalMap',
    'bumpMap', 'displacementMap', 'aoMap', 'lightMap', 'alphaMap',
    'clearcoatMap', 'clearcoatRoughnessMap', 'clearcoatNormalMap',
    'sheenColorMap', 'sheenRoughnessMap', 'transmissionMap', 'thicknessMap',
    'iridescenceMap', 'specularIntensityMap', 'specularColorMap',
];
function findHTMLTextureOnMaterial(material) {
    if (!material) return null;
    for (const k of _MAP_KEYS) {
        const tex = material[k];
        if (tex && tex.userData && tex.userData.maxjsHTMLHost) return tex;
    }
    return null;
}

// Forward pointer + mouse events from the 3D viewport into the DOM tree
// backing an HTML texture. Raycast hits a mesh whose material has any
// HTML-texture map slot → convert UV hit to host-pixel coords → re-dispatch
// the pointer stream on the matching DOM element inside the shadow tree (or
// iframe contentDocument).
//
// Forwards the full stream so drag + dblclick work:
//   pointerdown → mousedown            (once, on the initial hit target)
//   pointermove → mousemove            (every move while pointer is held)
//   pointerup   → mouseup → click      (release; click only if not dragged)
//   second click within 400ms → dblclick
//
// While a drag session is active, subsequent pointermove events are
// redispatched to the SAME host even if the pointer strays — that's what
// lets `document.addEventListener('mousemove', …)` handlers inside xp.html
// keep receiving motion while a window is being dragged.
//
// `getCameraScene` is a function so it stays current across active-camera
// switches. Returns a teardown function.
export function attachHTMLClickForwarding(THREE, renderer, getCameraScene) {
    const ndc = new THREE.Vector2();
    const raycaster = new THREE.Raycaster();
    const el = renderer?.domElement;
    if (!el) return () => {};

    // Active drag session. Non-null between pointerdown-on-htmltex and
    // pointerup. While set, move/up events are routed to this host and
    // camera controls are suppressed via stopPropagation.
    let active = null;

    // Dblclick tracker.
    let lastClickTarget = null;
    let lastClickTime = 0;
    const DBLCLICK_MS = 400;
    // Movement beyond this (in HTML pixels) between down and up cancels the
    // click — matches browser convention for "this was a drag, not a tap."
    const DRAG_CANCELS_CLICK_PX = 5;

    function pickHTMLTexture(event, restrictMesh) {
        const cs = getCameraScene();
        if (!cs?.camera) return null;
        const root = restrictMesh || cs.scene;
        if (!root) return null;
        const rect = el.getBoundingClientRect();
        ndc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        ndc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(ndc, cs.camera);
        const hits = raycaster.intersectObject(root, true);
        for (const hit of hits) {
            if (!hit.uv || !hit.object?.material) continue;
            const mats = Array.isArray(hit.object.material) ? hit.object.material : [hit.object.material];
            for (const m of mats) {
                const tex = findHTMLTextureOnMaterial(m);
                if (!tex) continue;
                const host = tex.userData.maxjsHTMLHost;
                const w = tex.userData.maxjsHTMLWidth || 1024;
                const h = tex.userData.maxjsHTMLHeight || 1024;
                return {
                    mesh: hit.object,
                    host, tex, w, h,
                    px: hit.uv.x * w,
                    py: (1 - hit.uv.y) * h, // flip V: Three UV bottom-left → DOM top-left
                };
            }
        }
        return null;
    }

    function baseInit(px, py, ev, buttons) {
        const ix = Math.round(px);
        const iy = Math.round(py);
        return {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: window,
            clientX: ix, clientY: iy,
            screenX: ix, screenY: iy,
            pageX: ix, pageY: iy,
            button: 0,
            buttons: buttons,
            ctrlKey: !!ev?.ctrlKey,
            shiftKey: !!ev?.shiftKey,
            altKey: !!ev?.altKey,
            metaKey: !!ev?.metaKey,
        };
    }

    function dispatchPointer(target, type, px, py, ev, buttons, pointerId) {
        const init = baseInit(px, py, ev, buttons);
        init.pointerId = pointerId ?? 1;
        init.pointerType = 'mouse';
        init.isPrimary = true;
        target.dispatchEvent(new PointerEvent(type, init));
    }

    function dispatchMouse(target, type, px, py, ev, buttons, detail) {
        const init = baseInit(px, py, ev, buttons);
        init.detail = detail || 0;
        target.dispatchEvent(new MouseEvent(type, init));
    }

    function onPointerDown(event) {
        if (event.button !== 0) return; // LMB only
        const pick = pickHTMLTexture(event);
        if (!pick) return;
        const target = hitTestHost(pick.host, pick.px, pick.py);
        if (!target) return;

        // Block OrbitControls / camera listeners on the same canvas from
        // treating this press as the start of a rotate/pan gesture.
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === 'function') {
            event.stopImmediatePropagation();
        }

        active = {
            mesh: pick.mesh,
            host: pick.host,
            w: pick.w, h: pick.h,
            startTarget: target,
            startPx: pick.px, startPy: pick.py,
            lastPx: pick.px, lastPy: pick.py,
            pointerId: event.pointerId ?? 1,
            moved: false,
        };

        // Keep subsequent moves flowing to this canvas even if the real
        // pointer drifts outside it.
        try { el.setPointerCapture?.(event.pointerId); } catch (_) { /* ignore */ }

        dispatchPointer(target, 'pointerdown', pick.px, pick.py, event, 1, active.pointerId);
        dispatchMouse(target, 'mousedown', pick.px, pick.py, event, 1, 1);
    }

    function onPointerMove(event) {
        if (!active) return;
        const pick = pickHTMLTexture(event, active.mesh);
        if (!pick) return; // pointer slid off the htmltex mesh — freeze
        event.stopPropagation();

        const { px, py } = pick;
        if (
            Math.abs(px - active.startPx) > DRAG_CANCELS_CLICK_PX ||
            Math.abs(py - active.startPy) > DRAG_CANCELS_CLICK_PX
        ) {
            active.moved = true;
        }
        active.lastPx = px;
        active.lastPy = py;

        // Dispatch against the start target so bubbling still reaches any
        // capturing listeners bound via document.addEventListener('mousemove',
        // handler, true) on the shadow root — that's the pattern xp.html
        // uses for window dragging.
        dispatchPointer(active.startTarget, 'pointermove', px, py, event, 1, active.pointerId);
        dispatchMouse(active.startTarget, 'mousemove', px, py, event, 1, 0);
    }

    function onPointerUp(event) {
        if (!active) return;
        event.stopPropagation();
        try { el.releasePointerCapture?.(event.pointerId); } catch (_) { /* ignore */ }

        const pick = pickHTMLTexture(event, active.mesh);
        let px = active.lastPx, py = active.lastPy;
        let releaseTarget = active.startTarget;
        if (pick) {
            px = pick.px;
            py = pick.py;
            releaseTarget = hitTestHost(active.host, px, py) || active.startTarget;
        }

        dispatchPointer(active.startTarget, 'pointerup', px, py, event, 0, active.pointerId);
        dispatchMouse(active.startTarget, 'mouseup', px, py, event, 0, 1);

        // Browser click rule: fire click only if the release lands on the
        // same target (or its subtree) and the press wasn't a drag.
        const sameTarget =
            releaseTarget === active.startTarget ||
            active.startTarget.contains?.(releaseTarget) ||
            releaseTarget.contains?.(active.startTarget);

        if (!active.moved && sameTarget) {
            const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
            const isDbl =
                lastClickTarget === active.startTarget &&
                (now - lastClickTime) < DBLCLICK_MS;
            dispatchMouse(active.startTarget, 'click', px, py, event, 0, isDbl ? 2 : 1);
            if (isDbl) {
                dispatchMouse(active.startTarget, 'dblclick', px, py, event, 0, 2);
                lastClickTarget = null;
                lastClickTime = 0;
            } else {
                lastClickTarget = active.startTarget;
                lastClickTime = now;
            }
        } else {
            // A drag, or released outside the start target — resets the
            // dblclick window so it doesn't chain with a prior single click.
            lastClickTarget = null;
            lastClickTime = 0;
        }

        active = null;
    }

    function onPointerCancel(event) {
        if (!active) return;
        try { el.releasePointerCapture?.(event.pointerId); } catch (_) { /* ignore */ }
        dispatchPointer(active.startTarget, 'pointercancel', active.lastPx, active.lastPy, event, 0, active.pointerId);
        active = null;
    }

    // Capture phase so we run before OrbitControls / other gesture handlers
    // attached to the same canvas. Only events whose raycast hits an HTML
    // texture get stopPropagation'd — others pass through untouched.
    el.addEventListener('pointerdown', onPointerDown, true);
    el.addEventListener('pointermove', onPointerMove, true);
    el.addEventListener('pointerup', onPointerUp, true);
    el.addEventListener('pointercancel', onPointerCancel, true);

    return () => {
        el.removeEventListener('pointerdown', onPointerDown, true);
        el.removeEventListener('pointermove', onPointerMove, true);
        el.removeEventListener('pointerup', onPointerUp, true);
        el.removeEventListener('pointercancel', onPointerCancel, true);
    };
}


// dom_panel_forwarding.js — pointer input for depth-occluded web panels.
//
// Depth-occluded CSS3D panels live BEHIND the WebGL canvas, so real DOM
// events can never reach them. This module re-creates the html_texture.js
// click-forwarding pattern for them: capture-phase listeners on the renderer
// canvas, an analytic ray–rect pick against each panel's occluder transform
// (the occluders disable THREE raycast so selection/htmltex raycasters never
// see them — we do the plane math directly), a full-scene raycast to honor
// depth (geometry in front of the panel wins and the event falls through to
// camera controls), then synthetic event dispatch:
//   - same-origin pages (srcdoc-adopted local files): real PointerEvent /
//     MouseEvent stream via elementFromPoint — buttons, drags, dblclick work.
//   - cross-origin pages: postMessage({ type: 'maxjs:pointer', ... }) — the
//     page opts in with a small documented receiver.
//
// Coexists with attachHTMLClickForwarding (texture-mode panels + material
// HTML textures): each forwarder only blocks canvas events for its own hits.

export function attachDomPanelForwarding({ THREE, renderer, getCameraScene, getTargets }) {
    const el = renderer?.domElement;
    if (!el) return () => {};

    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const invMatrix = new THREE.Matrix4();
    const localOrigin = new THREE.Vector3();
    const localEnd = new THREE.Vector3();
    const localDir = new THREE.Vector3();

    let active = null;            // drag session
    let lastClickTarget = null;
    let lastClickTime = 0;
    let suppressNativeClickUntil = 0;
    const DBLCLICK_MS = 400;
    const DRAG_CANCELS_CLICK_PX = 5;

    function now() {
        return (typeof performance !== 'undefined') ? performance.now() : Date.now();
    }

    // Analytic pick: panel-local unit rect [-0.5,0.5]^2 at z=0. Affine maps
    // preserve the ray parameter, so local t equals world distance (direction
    // is normalized in world space).
    function intersectTarget(target) {
        // NOTE: do not gate on obj.visible — occluders are intentionally
        // hidden while the FX pipeline punches analytically, but the panel
        // is still on screen and must keep receiving input.
        const obj = target.object;
        if (!obj) return null;
        invMatrix.copy(obj.matrixWorld).invert();
        localOrigin.copy(raycaster.ray.origin).applyMatrix4(invMatrix);
        localEnd.copy(raycaster.ray.origin).add(raycaster.ray.direction).applyMatrix4(invMatrix);
        localDir.subVectors(localEnd, localOrigin);
        if (localDir.z === 0) return null;
        const t = -localOrigin.z / localDir.z;
        if (!(t > 0) || !Number.isFinite(t)) return null;
        const hx = localOrigin.x + localDir.x * t;
        const hy = localOrigin.y + localDir.y * t;
        if (Math.abs(hx) > 0.5 || Math.abs(hy) > 0.5) return null;
        return {
            target,
            dist: t,
            px: (hx + 0.5) * target.width,
            py: (0.5 - hy) * target.height,  // plane-local +Y up → DOM +Y down
        };
    }

    function pickPanel(event, restrictTarget) {
        const cs = getCameraScene();
        if (!cs?.camera) return null;
        const rect = el.getBoundingClientRect();
        ndc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        ndc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(ndc, cs.camera);

        const targets = restrictTarget ? [restrictTarget] : (getTargets?.() || []);
        const panelHits = [];
        for (const target of targets) {
            const hit = intersectTarget(target);
            if (hit) panelHits.push(hit);
        }
        if (panelHits.length === 0) return null;
        panelHits.sort((a, b) => a.dist - b.dist);

        // Depth honor: scene geometry nearer than a panel swallows the event
        // (the panel is occluded there — exactly what the punch shows).
        let sceneDist = Infinity;
        if (cs.scene) {
            const hits = raycaster.intersectObject(cs.scene, true);
            if (hits.length > 0) sceneDist = hits[0].distance;
        }

        // Walk panels near→far. Layer-stack instances mark their containers
        // pointer-events:none, so elementFromPoint returns html/body for
        // transparent regions — fall through to the next layer behind.
        for (const hit of panelHits) {
            if (sceneDist < hit.dist - 1e-4) return null;  // geometry blocks this and everything deeper
            if (!hit.target.layered || restrictTarget) return hit;  // single pages take any hit; drags stay on their panel
            const doc = hit.target.getDocument?.();
            if (!doc) return hit;  // cross-origin — can't introspect, take it
            let el = null;
            try { el = doc.elementFromPoint(hit.px, hit.py); } catch { el = null; }
            if (el && el !== doc.body && el !== doc.documentElement) return hit;
        }
        return null;
    }

    function eventWindowFor(target) {
        return target?.ownerDocument?.defaultView || window;
    }

    function blockCanvasEvent(event) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
    }

    function baseInit(target, px, py, ev, buttons) {
        const ix = Math.round(px);
        const iy = Math.round(py);
        return {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: eventWindowFor(target),
            clientX: ix, clientY: iy,
            screenX: ix, screenY: iy,
            button: 0,
            buttons,
            ctrlKey: !!ev?.ctrlKey,
            shiftKey: !!ev?.shiftKey,
            altKey: !!ev?.altKey,
            metaKey: !!ev?.metaKey,
        };
    }

    function dispatchPointer(target, type, px, py, ev, buttons, pointerId) {
        const init = baseInit(target, px, py, ev, buttons);
        init.pointerId = pointerId ?? 1;
        init.pointerType = 'mouse';
        init.isPrimary = true;
        const view = eventWindowFor(target);
        const EventCtor = view.PointerEvent || PointerEvent;
        target.dispatchEvent(new EventCtor(type, init));
    }

    function dispatchMouse(target, type, px, py, ev, buttons, detail) {
        const init = baseInit(target, px, py, ev, buttons);
        init.detail = detail || 0;
        const view = eventWindowFor(target);
        const EventCtor = view.MouseEvent || MouseEvent;
        target.dispatchEvent(new EventCtor(type, init));
    }

    // Cross-origin fallback: the page implements the documented receiver
    // (elementFromPoint + dispatchEvent) — see docs/WEBAPP_ANIMATOR.md.
    function postPointer(target, kind, px, py, ev) {
        try {
            target.getWindow?.()?.postMessage({
                type: 'maxjs:pointer',
                kind,
                x: Math.round(px),
                y: Math.round(py),
                button: 0,
                ctrlKey: !!ev?.ctrlKey,
                shiftKey: !!ev?.shiftKey,
                altKey: !!ev?.altKey,
            }, '*');
        } catch {}
    }

    function resolveDomTarget(pick) {
        const doc = pick.target.getDocument?.();
        if (!doc) return null;
        try { return doc.elementFromPoint(pick.px, pick.py) || doc.documentElement; } catch { return null; }
    }

    function onPointerDown(event) {
        if (event.button !== 0) return;
        const pick = pickPanel(event);
        if (!pick) return;

        blockCanvasEvent(event);
        suppressNativeClickUntil = now() + 800;

        const domTarget = resolveDomTarget(pick);
        active = {
            target: pick.target,
            domTarget,
            startPx: pick.px, startPy: pick.py,
            lastPx: pick.px, lastPy: pick.py,
            pointerId: event.pointerId ?? 1,
            moved: false,
        };
        try { el.setPointerCapture?.(event.pointerId); } catch {}

        if (domTarget) {
            dispatchPointer(domTarget, 'pointerdown', pick.px, pick.py, event, 1, active.pointerId);
            dispatchMouse(domTarget, 'mousedown', pick.px, pick.py, event, 1, 1);
        } else {
            postPointer(pick.target, 'down', pick.px, pick.py, event);
        }
    }

    function onPointerMove(event) {
        if (!active) return;
        blockCanvasEvent(event);
        const pick = pickPanel(event, active.target);
        if (!pick) return;  // slid off the panel — freeze at last position

        if (Math.abs(pick.px - active.startPx) > DRAG_CANCELS_CLICK_PX ||
            Math.abs(pick.py - active.startPy) > DRAG_CANCELS_CLICK_PX) {
            active.moved = true;
        }
        active.lastPx = pick.px;
        active.lastPy = pick.py;

        if (active.domTarget) {
            dispatchPointer(active.domTarget, 'pointermove', pick.px, pick.py, event, 1, active.pointerId);
            dispatchMouse(active.domTarget, 'mousemove', pick.px, pick.py, event, 1, 0);
        } else {
            postPointer(active.target, 'move', pick.px, pick.py, event);
        }
    }

    function onPointerUp(event) {
        if (!active) return;
        blockCanvasEvent(event);
        suppressNativeClickUntil = now() + 800;
        try { el.releasePointerCapture?.(event.pointerId); } catch {}

        const pick = pickPanel(event, active.target);
        const px = pick ? pick.px : active.lastPx;
        const py = pick ? pick.py : active.lastPy;

        if (active.domTarget) {
            dispatchPointer(active.domTarget, 'pointerup', px, py, event, 0, active.pointerId);
            dispatchMouse(active.domTarget, 'mouseup', px, py, event, 0, 1);

            if (!active.moved && pick) {
                const t = now();
                const isDbl = lastClickTarget === active.domTarget && (t - lastClickTime) < DBLCLICK_MS;
                dispatchMouse(active.domTarget, 'click', px, py, event, 0, isDbl ? 2 : 1);
                if (isDbl) {
                    dispatchMouse(active.domTarget, 'dblclick', px, py, event, 0, 2);
                    lastClickTarget = null;
                    lastClickTime = 0;
                } else {
                    lastClickTarget = active.domTarget;
                    lastClickTime = t;
                }
            } else {
                lastClickTarget = null;
                lastClickTime = 0;
            }
        } else {
            postPointer(active.target, 'up', px, py, event);
            if (!active.moved && pick) postPointer(active.target, 'click', px, py, event);
        }

        active = null;
    }

    function onPointerCancel(event) {
        if (!active) return;
        blockCanvasEvent(event);
        try { el.releasePointerCapture?.(event.pointerId); } catch {}
        if (active.domTarget) {
            dispatchPointer(active.domTarget, 'pointercancel', active.lastPx, active.lastPy, event, 0, active.pointerId);
        }
        active = null;
    }

    function onNativeClick(event) {
        if (now() > suppressNativeClickUntil) return;
        blockCanvasEvent(event);
    }

    el.addEventListener('pointerdown', onPointerDown, true);
    el.addEventListener('pointermove', onPointerMove, true);
    el.addEventListener('pointerup', onPointerUp, true);
    el.addEventListener('pointercancel', onPointerCancel, true);
    el.addEventListener('click', onNativeClick, true);

    return () => {
        el.removeEventListener('pointerdown', onPointerDown, true);
        el.removeEventListener('pointermove', onPointerMove, true);
        el.removeEventListener('pointerup', onPointerUp, true);
        el.removeEventListener('pointercancel', onPointerCancel, true);
        el.removeEventListener('click', onNativeClick, true);
    };
}

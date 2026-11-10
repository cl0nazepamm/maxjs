// Drag-to-hide behavior for the rail and right dock.

// ── Drag-to-hide rail + dock ────────────────────────
// Each panel has a thin vertical grabber on its inner edge.
// side='left' (rail): drag left = hide, drag right = reveal.
// side='right' (dock): mirrored — drag right = hide, drag left = reveal.
// Release with <4px travel toggles visibility (click-to-dismiss).
function setupDragHide(panel, handle, side, storageKey) {
    let hidden = false;
    try { hidden = localStorage.getItem(storageKey) === '1'; } catch {}
    panel.classList.toggle('is-hidden', hidden);

    let dragging = false;
    let startX = 0;
    let width = 0;
    const sign = side === 'left' ? -1 : 1;

    handle.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        dragging = true;
        startX = e.clientX;
        width = panel.offsetWidth;
        handle.setPointerCapture(e.pointerId);
        handle.classList.add('dragging');
        panel.style.transition = 'none';
        e.preventDefault();
    });

    handle.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        const max = width - 4;
        // Base offset: where the panel is relative to its resting visible position.
        const base = hidden ? sign * max : 0;
        // Clamp so panel never goes past fully visible (0) or fully hidden (sign*max).
        let next = base + dx;
        next = side === 'left'
            ? Math.min(0, Math.max(-max, next))
            : Math.max(0, Math.min(max, next));
        panel.style.transform = `translateX(${next}px)`;
    });

    const endDrag = (e) => {
        if (!dragging) return;
        dragging = false;
        try { handle.releasePointerCapture(e.pointerId); } catch {}
        handle.classList.remove('dragging');
        panel.style.transition = '';
        panel.style.transform = '';

        const dx = e.clientX - startX;
        const threshold = 40;
        let nextHidden = hidden;
        if (Math.abs(dx) < 4) {
            nextHidden = !hidden;          // treat as click → toggle
        } else if (hidden && dx * sign < -threshold) {
            nextHidden = false;            // dragged toward center past threshold → reveal
        } else if (!hidden && dx * sign > threshold) {
            nextHidden = true;             // dragged toward edge past threshold → hide
        }
        hidden = nextHidden;
        panel.classList.toggle('is-hidden', hidden);
        try { localStorage.setItem(storageKey, hidden ? '1' : '0'); } catch {}
    };
    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);
}


function installDockDragHide() {
    const rail = document.getElementById('rightRail');
    const railHandle = document.querySelector('.rail-drag-handle');
    const dock = document.getElementById('rightDock');
    const dockHandle = document.querySelector('.dock-drag-handle');
    if (rail && railHandle) setupDragHide(rail, railHandle, 'left', 'maxjs-rail-hidden');
    if (dock && dockHandle) setupDragHide(dock, dockHandle, 'right', 'maxjs-dock-hidden');
}

export { installDockDragHide, setupDragHide };

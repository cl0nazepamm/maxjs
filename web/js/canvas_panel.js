// Canvas panel — design-side HTML overlays on the MaxJS viewport.
//
// A first-class MaxJS feature (not a layer). Opens from the burger menu
// and lets users load HTML files from their project folder and composite
// them over or under the 3D viewport. Pure DOM overlays — no rasterization,
// no shadow root, no texture indirection. Full CSS / JS / React support
// because the HTML is a real descendant of the page body.
//
// Layer manager stays for game logic / FX; Canvas is the design-side UI.

// React + ReactDOM are resolved via the importmap in index.html, so both
// the Canvas panel and shader_lab_fx share the SAME React instance — no
// "two copies of React" hook dispatcher mismatch.
let _reactLoad = null;
async function ensureReact() {
    if (!_reactLoad) {
        _reactLoad = (async () => {
            const [React, ReactDOMClient] = await Promise.all([
                import('react'),
                import('react-dom/client'),
            ]);
            return { React: React.default ?? React, ReactDOMClient };
        })();
    }
    return _reactLoad;
}

// Turn a relative path (like "panel.html") into a fetchable asset URL
// rooted at the active Max project directory. We can't know the project
// directory from the web side directly, but project_runtime already
// discovers it via the inline-layer scanner; we reuse that convention by
// asking the project runtime for its base url. If unavailable, fall back
// to the maxjs-assets origin with the relative path which won't resolve
// but will produce a clear fetch error.
function resolveProjectUrl(projectBaseUrl, relativePath) {
    if (!relativePath) return '';
    const clean = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
    if (/^https?:\/\//i.test(clean)) return clean;
    if (projectBaseUrl) {
        const base = projectBaseUrl.endsWith('/') ? projectBaseUrl : projectBaseUrl + '/';
        return base + clean;
    }
    return clean;
}

// Internal registry of mounted overlays (so React state and DOM stay in
// sync). Each entry: { id, path, name, mode, visible, element }.
const overlays = new Map();
let _overlayCounter = 0;

function mountOverlay(projectBaseUrl, path, mode = 'front') {
    const id = `canvas-overlay-${++_overlayCounter}`;
    const url = resolveProjectUrl(projectBaseUrl, path);
    const zIndex = mode === 'behind' ? '-1' : '9998';

    const el = document.createElement('div');
    el.className = 'maxjs-canvas-overlay';
    el.dataset.mode = mode;
    el.style.cssText = [
        'position:fixed',
        'inset:0',
        'pointer-events:none',
        'overflow:visible',
        'z-index:' + zIndex,
        'transform:translate(0px,0px)',
        'transform-origin:0 0',
    ].join(';');

    // Fetch the HTML and inject. We preserve <script> execution by re-
    // creating script tags as live nodes (innerHTML alone doesn't run
    // scripts). Styles scoped via a generated container class, not a
    // shadow root — overlays coexist with the host page's CSS.
    fetch(url, { cache: 'no-store' })
        .then(r => {
            if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
            return r.text();
        })
        .then(text => {
            const parsed = new DOMParser().parseFromString(text, 'text/html');
            const baseHref = url.replace(/[^/]*$/, '');

            // Base href so relative URLs resolve against the HTML file dir.
            const baseEl = document.createElement('base');
            baseEl.setAttribute('href', baseHref);
            el.appendChild(baseEl);

            // Clone head <style> and <link> stylesheets so the overlay's
            // CSS applies. User is responsible for scoping their own
            // selectors via class names since we don't use shadow DOM.
            for (const node of parsed.head.querySelectorAll('style, link[rel="stylesheet"]')) {
                el.appendChild(node.cloneNode(true));
            }

            // Body contents sit in a pointer-events:none wrapper so empty
            // areas pass clicks through to the 3D viewport. The user's
            // HTML sets `pointer-events: auto` on specific interactive
            // elements (cards, buttons, HUDs) the way a normal overlay
            // does, giving per-element click targeting.
            const body = document.createElement('div');
            body.className = 'maxjs-canvas-body';
            body.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
            for (const child of Array.from(parsed.body.childNodes)) {
                body.appendChild(child.cloneNode(true));
            }
            el.appendChild(body);

            // Re-create scripts as live nodes so they execute.
            for (const oldScript of body.querySelectorAll('script')) {
                const fresh = document.createElement('script');
                for (const attr of oldScript.attributes) fresh.setAttribute(attr.name, attr.value);
                if (oldScript.textContent) fresh.textContent = oldScript.textContent;
                oldScript.parentNode.replaceChild(fresh, oldScript);
            }
        })
        .catch(err => {
            el.innerHTML =
                '<div style="position:absolute;inset:0;display:flex;' +
                'align-items:center;justify-content:center;color:#f66;' +
                'font:14px system-ui;background:rgba(10,10,31,.6);' +
                'pointer-events:auto;padding:24px;text-align:center">' +
                'Failed to load<br>' + String(err.message || err) +
                '</div>';
        });

    document.body.appendChild(el);

    const entry = {
        id,
        path,
        name: path.split(/[\\/]/).pop() || path,
        mode,
        visible: true,
        element: el,
        offsetX: 0,
        offsetY: 0,
        moving: false,
        _dragCleanup: null,
    };
    overlays.set(id, entry);
    return entry;
}

function applyOverlayTransform(entry) {
    entry.element.style.transform =
        'translate(' + entry.offsetX + 'px,' + entry.offsetY + 'px)';
}

function unmountOverlay(id) {
    const entry = overlays.get(id);
    if (!entry) return;
    try { entry._dragCleanup?.(); } catch (_) {}
    try { entry.element.remove(); } catch (_) {}
    overlays.delete(id);
}

function setOverlayVisible(id, visible) {
    const entry = overlays.get(id);
    if (!entry) return;
    entry.visible = !!visible;
    entry.element.style.display = entry.visible ? '' : 'none';
}

function setOverlayMode(id, mode) {
    const entry = overlays.get(id);
    if (!entry) return;
    entry.mode = mode;
    entry.element.dataset.mode = mode;
    entry.element.style.zIndex = mode === 'behind' ? '-1' : '9998';
}

// Attach drag-to-move pointer handlers on the overlay's wrapper. While
// moving, the wrapper forces `pointer-events: auto` over its full area
// so the user can grab anywhere (including empty transparent areas). On
// mouseup the wrapper reverts to click-through so normal interaction
// resumes.
function enterMoveMode(entry, onChange) {
    if (entry.moving) return;
    entry.moving = true;
    entry.element.style.pointerEvents = 'auto';
    entry.element.style.cursor = 'move';
    entry.element.style.outline = '2px dashed rgba(90,170,255,.6)';
    entry.element.style.outlineOffset = '-2px';

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let baseOffsetX = 0;
    let baseOffsetY = 0;

    function onDown(e) {
        dragging = true;
        startX = e.clientX;
        startY = e.clientY;
        baseOffsetX = entry.offsetX;
        baseOffsetY = entry.offsetY;
        entry.element.setPointerCapture?.(e.pointerId);
        e.preventDefault();
        e.stopPropagation();
    }
    function onMove(e) {
        if (!dragging) return;
        entry.offsetX = baseOffsetX + (e.clientX - startX);
        entry.offsetY = baseOffsetY + (e.clientY - startY);
        applyOverlayTransform(entry);
        e.preventDefault();
        e.stopPropagation();
    }
    function onUp(e) {
        if (!dragging) return;
        dragging = false;
        try { entry.element.releasePointerCapture?.(e.pointerId); } catch (_) {}
        onChange?.();
        e.preventDefault();
        e.stopPropagation();
    }

    entry.element.addEventListener('pointerdown', onDown, true);
    entry.element.addEventListener('pointermove', onMove, true);
    entry.element.addEventListener('pointerup', onUp, true);
    entry.element.addEventListener('pointercancel', onUp, true);

    entry._dragCleanup = () => {
        entry.element.removeEventListener('pointerdown', onDown, true);
        entry.element.removeEventListener('pointermove', onMove, true);
        entry.element.removeEventListener('pointerup', onUp, true);
        entry.element.removeEventListener('pointercancel', onUp, true);
        entry.element.style.pointerEvents = 'none';
        entry.element.style.cursor = '';
        entry.element.style.outline = '';
        entry.element.style.outlineOffset = '';
        entry._dragCleanup = null;
    };
}

function exitMoveMode(entry) {
    if (!entry.moving) return;
    entry.moving = false;
    entry._dragCleanup?.();
}

function setOverlayMoving(id, moving, onChange) {
    const entry = overlays.get(id);
    if (!entry) return;
    if (moving) enterMoveMode(entry, onChange);
    else exitMoveMode(entry);
}

function resetOverlayOffset(id) {
    const entry = overlays.get(id);
    if (!entry) return;
    entry.offsetX = 0;
    entry.offsetY = 0;
    applyOverlayTransform(entry);
}

// React component for the panel. Receives the live overlays Map through
// getter functions (React re-renders on mutation by incrementing a
// version counter).
function buildApp(React) {
    const { useState, useEffect, useCallback } = React;
    const h = React.createElement;

    return function CanvasApp({ projectBaseUrl, onHide }) {
        const [path, setPath] = useState('');
        const [entries, setEntries] = useState(() => Array.from(overlays.values()));
        const [error, setError] = useState('');

        const refresh = useCallback(() => {
            setEntries(Array.from(overlays.values()));
        }, []);

        const onLoad = useCallback((e) => {
            e.preventDefault();
            const trimmed = path.trim();
            if (!trimmed) {
                setError('Enter a file path (e.g. panel.html)');
                return;
            }
            setError('');
            mountOverlay(projectBaseUrl, trimmed, 'front');
            setPath('');
            refresh();
        }, [path, projectBaseUrl, refresh]);

        const onToggle = useCallback((id) => {
            const entry = overlays.get(id);
            if (!entry) return;
            setOverlayVisible(id, !entry.visible);
            refresh();
        }, [refresh]);

        const onModeChange = useCallback((id, mode) => {
            setOverlayMode(id, mode);
            refresh();
        }, [refresh]);

        const onToggleMove = useCallback((id) => {
            const entry = overlays.get(id);
            if (!entry) return;
            setOverlayMoving(id, !entry.moving, refresh);
            refresh();
        }, [refresh]);

        const onResetOffset = useCallback((id) => {
            resetOverlayOffset(id);
            refresh();
        }, [refresh]);

        const onRemove = useCallback((id) => {
            unmountOverlay(id);
            refresh();
        }, [refresh]);

        return h('div', null,
            h('div', { className: 'sidepanel-header' },
                h('div', null,
                    h('div', { className: 'sidepanel-title' }, 'Canvas'),
                    h('div', { className: 'sidepanel-subtitle' }, 'HTML overlays on the viewport'),
                ),
                h('div', { style: { display: 'flex', gap: '4px' } },
                    h('button', { type: 'button', onClick: onHide }, 'Hide'),
                ),
            ),
            h('div', { className: 'sidepanel-body' },
                h('section', { className: 'fx-section' },
                    h('div', { className: 'fx-section-header' },
                        h('div', { className: 'fx-section-title' }, 'Load HTML'),
                    ),
                    h('form', {
                        onSubmit: onLoad,
                        style: {
                            display: 'flex',
                            gap: '6px',
                            padding: '4px 0 8px',
                        },
                    },
                        h('input', {
                            type: 'text',
                            placeholder: 'panel.html',
                            value: path,
                            onChange: (e) => setPath(e.target.value),
                            style: {
                                flex: 1,
                                background: '#1a1a1a',
                                color: '#ddd',
                                border: '1px solid rgba(255,255,255,0.12)',
                                borderRadius: '4px',
                                padding: '6px 10px',
                                font: '12px system-ui',
                            },
                        }),
                        h('button', { type: 'submit' }, 'Load'),
                    ),
                    error && h('div', {
                        style: { color: '#f66', fontSize: '11px', padding: '2px 0' },
                    }, error),
                    h('div', {
                        style: { fontSize: '11px', color: '#666', lineHeight: '1.4' },
                    }, 'Path is relative to the active Max project folder. The overlay renders as a real DOM element on top of the 3D viewport — full CSS, JS, and React support.'),
                ),
                h('section', { className: 'fx-section' },
                    h('div', { className: 'fx-section-header' },
                        h('div', { className: 'fx-section-title' },
                            'Mounted (' + entries.length + ')'),
                    ),
                    entries.length === 0
                        ? h('div', {
                            style: { fontSize: '11px', color: '#666', padding: '4px 0' },
                        }, 'Nothing loaded yet.')
                        : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
                            ...entries.map(entry =>
                                h('div', {
                                    key: entry.id,
                                    style: {
                                        display: 'flex',
                                        flexDirection: 'column',
                                        gap: '4px',
                                        padding: '8px 10px',
                                        background: 'rgba(255,255,255,0.03)',
                                        border: '1px solid rgba(255,255,255,0.08)',
                                        borderRadius: '6px',
                                    },
                                },
                                    h('div', {
                                        style: {
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'space-between',
                                            gap: '6px',
                                        },
                                    },
                                        h('div', {
                                            style: {
                                                fontSize: '12px',
                                                fontWeight: 600,
                                                color: '#ddd',
                                                overflow: 'hidden',
                                                textOverflow: 'ellipsis',
                                                whiteSpace: 'nowrap',
                                            },
                                        }, entry.name),
                                        h('button', {
                                            type: 'button',
                                            onClick: () => onRemove(entry.id),
                                            style: { fontSize: '11px' },
                                        }, '×'),
                                    ),
                                    h('div', {
                                        style: { display: 'flex', gap: '4px', fontSize: '11px' },
                                    },
                                        h('button', {
                                            type: 'button',
                                            onClick: () => onToggle(entry.id),
                                            className: entry.visible ? 'active' : '',
                                            style: { flex: 1, fontSize: '11px' },
                                        }, entry.visible ? 'Visible' : 'Hidden'),
                                        h('button', {
                                            type: 'button',
                                            onClick: () => onModeChange(entry.id, 'front'),
                                            className: entry.mode === 'front' ? 'active' : '',
                                            style: { flex: 1, fontSize: '11px' },
                                        }, 'Front'),
                                        h('button', {
                                            type: 'button',
                                            onClick: () => onModeChange(entry.id, 'behind'),
                                            className: entry.mode === 'behind' ? 'active' : '',
                                            style: { flex: 1, fontSize: '11px' },
                                        }, 'Behind'),
                                    ),
                                    h('div', {
                                        style: { display: 'flex', gap: '4px', fontSize: '11px', alignItems: 'center' },
                                    },
                                        h('button', {
                                            type: 'button',
                                            onClick: () => onToggleMove(entry.id),
                                            className: entry.moving ? 'active' : '',
                                            style: { flex: 1, fontSize: '11px' },
                                        }, entry.moving ? '✓ Moving' : 'Move'),
                                        h('button', {
                                            type: 'button',
                                            onClick: () => onResetOffset(entry.id),
                                            style: { flex: 1, fontSize: '11px' },
                                        }, 'Reset'),
                                        h('span', {
                                            style: {
                                                flex: '0 0 auto',
                                                fontSize: '10px',
                                                color: '#666',
                                                fontVariantNumeric: 'tabular-nums',
                                                minWidth: '60px',
                                                textAlign: 'right',
                                            },
                                        }, (entry.offsetX | 0) + ', ' + (entry.offsetY | 0)),
                                    ),
                                ),
                            ),
                        ),
                ),
                h('section', { className: 'fx-section' },
                    h('div', {
                        style: { fontSize: '11px', color: '#666', lineHeight: '1.4' },
                    },
                        'Front: z-index above the viewport. ',
                        'Behind: z-index below the canvas — requires a transparent renderer clear + empty scene background to show through.',
                    ),
                ),
            ),
        );
    };
}

export async function createCanvasPanel({ panelEl, getProjectBaseUrl, onHide }) {
    const { React, ReactDOMClient } = await ensureReact();
    const App = buildApp(React);
    const root = ReactDOMClient.createRoot(panelEl);
    let currentProjectBaseUrl = '';
    try { currentProjectBaseUrl = getProjectBaseUrl?.() || ''; } catch (_) {}

    function render() {
        root.render(
            React.createElement(App, {
                projectBaseUrl: currentProjectBaseUrl,
                onHide,
            })
        );
    }

    render();

    return {
        render,
        setProjectBaseUrl(url) {
            currentProjectBaseUrl = url || '';
            render();
        },
        unmount() {
            root.unmount();
        },
    };
}

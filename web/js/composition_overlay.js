// Composition overlay — always-on-top viewport framing guides.
//
// A single 2D canvas pinned to the active viewport frame (so the guides track
// Safe Frame automatically) that draws camera-style composition helpers:
// rule of thirds, golden-ratio (phi) grid, golden spiral, dynamic-symmetry
// diagonals, center crosshair, uniform grid and broadcast safe areas. An
// optional aspect mask dims letterbox/pillarbox bars and snaps the guides to
// the masked region.
//
// The module owns nothing but its own canvas. The host passes in helpers to
// position the canvas (`applyFrameStyle`) and to query the current frame rect
// (`getFrameRect`); state persists to localStorage, mirroring Safe Frame.

const STORAGE_KEY = 'maxjs_composition_overlay';
const PHI = 1.618033988749895;

// Guide catalogue — the UI builds its chip grid from this list, so adding a
// guide here (plus a draw branch below) is all that is needed to expose one.
export const COMPOSITION_GUIDES = Object.freeze([
    { id: 'thirds',   label: 'Thirds',  title: 'Rule of thirds — 3×3 grid' },
    { id: 'phi',      label: 'Phi',     title: 'Golden ratio grid (φ)' },
    { id: 'spiral',   label: 'Spiral',  title: 'Golden / Fibonacci spiral' },
    { id: 'diagonal', label: 'Diag',    title: 'Dynamic symmetry — diagonal armature' },
    { id: 'cross',    label: 'Cross',   title: 'Center crosshair' },
    { id: 'grid',     label: 'Grid',    title: 'Uniform grid' },
    { id: 'safe',     label: 'Safe',    title: 'Action & title safe areas' },
]);

// Aspect mask presets. ratio 0 == disabled (guides fill the whole frame).
export const COMPOSITION_ASPECTS = Object.freeze([
    { id: 'off',  label: 'Off',     ratio: 0 },
    { id: '239',  label: '2.39:1',  ratio: 2.39 },
    { id: '200',  label: '2.00:1',  ratio: 2.0 },
    { id: '185',  label: '1.85:1',  ratio: 1.85 },
    { id: '169',  label: '16:9',    ratio: 16 / 9 },
    { id: '43',   label: '4:3',     ratio: 4 / 3 },
    { id: '11',   label: '1:1',     ratio: 1 },
    { id: '916',  label: '9:16',    ratio: 9 / 16 },
]);

const DEFAULT_STATE = Object.freeze({
    guides: {},
    color: '#ffffff',
    opacity: 0.5,
    thickness: 1,
    gridDivisions: 8,
    spiralOrientation: 0, // bit 0 = flip X, bit 1 = flip Y
    aspect: 'off',
    maskOpacity: 0.62,
});

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function loadState() {
    const state = {
        ...DEFAULT_STATE,
        guides: {},
    };
    try {
        const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
        if (raw && typeof raw === 'object') {
            if (raw.guides && typeof raw.guides === 'object') {
                for (const g of COMPOSITION_GUIDES) state.guides[g.id] = !!raw.guides[g.id];
            }
            if (typeof raw.color === 'string') state.color = raw.color;
            if (Number.isFinite(raw.opacity)) state.opacity = clamp(raw.opacity, 0.05, 1);
            if (Number.isFinite(raw.thickness)) state.thickness = clamp(raw.thickness, 0.5, 4);
            if (Number.isFinite(raw.gridDivisions)) state.gridDivisions = clamp(Math.round(raw.gridDivisions), 2, 24);
            if (Number.isFinite(raw.spiralOrientation)) state.spiralOrientation = raw.spiralOrientation & 3;
            if (typeof raw.aspect === 'string' && COMPOSITION_ASPECTS.some(a => a.id === raw.aspect)) state.aspect = raw.aspect;
            if (Number.isFinite(raw.maskOpacity)) state.maskOpacity = clamp(raw.maskOpacity, 0, 1);
        }
    } catch {}
    return state;
}

function aspectRatioFor(id) {
    const found = COMPOSITION_ASPECTS.find(a => a.id === id);
    return found ? found.ratio : 0;
}

/**
 * @param {object}   opts
 * @param {(el: HTMLElement, rect: object) => void} opts.applyFrameStyle Position the canvas over the frame.
 * @param {() => object}                            opts.getFrameRect    Returns the current {x,y,width,height} frame rect.
 */
export function createCompositionOverlay({ applyFrameStyle, getFrameRect } = {}) {
    const canvas = document.createElement('canvas');
    canvas.id = 'compositionOverlay';
    canvas.setAttribute('aria-hidden', 'true');
    // Always on top of viewport content, but under the menu/panels chrome and
    // never eating pointer input.
    canvas.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:35;display:none;';
    const ctx = canvas.getContext('2d');
    document.body.appendChild(canvas);

    const state = loadState();
    let cssW = 1;
    let cssH = 1;

    function persist() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch {}
    }

    function isActive() {
        return COMPOSITION_GUIDES.some(g => state.guides[g.id]) || aspectRatioFor(state.aspect) > 0;
    }

    // ── Geometry helpers ────────────────────────────────────────────────
    function strokeSeg(x0, y0, x1, y1) {
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
    }

    function strokePoly(points) {
        if (points.length < 2) return;
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
        ctx.stroke();
    }

    // Liang–Barsky: clip the infinite line through (x0,y0)-(x1,y1) to the
    // rect, returning the visible segment or null.
    function clipLine(x0, y0, x1, y1, r) {
        const dx = x1 - x0;
        const dy = y1 - y0;
        const p = [-dx, dx, -dy, dy];
        const q = [x0 - r.x, r.x + r.w - x0, y0 - r.y, r.y + r.h - y0];
        let t0 = 0;
        let t1 = 1;
        for (let i = 0; i < 4; i++) {
            if (p[i] === 0) {
                if (q[i] < 0) return null;
            } else {
                const t = q[i] / p[i];
                if (p[i] < 0) {
                    if (t > t1) return null;
                    if (t > t0) t0 = t;
                } else {
                    if (t < t0) return null;
                    if (t < t1) t1 = t;
                }
            }
        }
        return { x0: x0 + t0 * dx, y0: y0 + t0 * dy, x1: x0 + t1 * dx, y1: y0 + t1 * dy };
    }

    function strokeClipped(px, py, dx, dy, r) {
        const len = (r.w + r.h) * 2;
        const seg = clipLine(px - dx * len, py - dy * len, px + dx * len, py + dy * len, r);
        if (seg) strokeSeg(seg.x0, seg.y0, seg.x1, seg.y1);
    }

    // ── Guide renderers (all operate on inner rect r = {x,y,w,h}) ───────
    function drawThirds(r) {
        for (let i = 1; i <= 2; i++) {
            const x = r.x + (r.w * i) / 3;
            const y = r.y + (r.h * i) / 3;
            strokeSeg(x, r.y, x, r.y + r.h);
            strokeSeg(r.x, y, r.x + r.w, y);
        }
    }

    function drawPhi(r) {
        const a = 1 - 1 / PHI; // 0.382
        const b = 1 / PHI;     // 0.618
        for (const f of [a, b]) {
            const x = r.x + r.w * f;
            const y = r.y + r.h * f;
            strokeSeg(x, r.y, x, r.y + r.h);
            strokeSeg(r.x, y, r.x + r.w, y);
        }
    }

    function drawGrid(r) {
        const n = clamp(Math.round(state.gridDivisions), 2, 24);
        for (let i = 1; i < n; i++) {
            const x = r.x + (r.w * i) / n;
            const y = r.y + (r.h * i) / n;
            strokeSeg(x, r.y, x, r.y + r.h);
            strokeSeg(r.x, y, r.x + r.w, y);
        }
    }

    function drawCross(r) {
        const cx = r.x + r.w / 2;
        const cy = r.y + r.h / 2;
        strokeSeg(cx, r.y, cx, r.y + r.h);
        strokeSeg(r.x, cy, r.x + r.w, cy);
        const t = Math.max(6, Math.min(r.w, r.h) * 0.018);
        strokeSeg(cx - t, cy, cx + t, cy);
        strokeSeg(cx, cy - t, cx, cy + t);
        ctx.beginPath();
        ctx.arc(cx, cy, t * 0.9, 0, Math.PI * 2);
        ctx.stroke();
    }

    // Dynamic-symmetry armature: both corner diagonals plus the four
    // reciprocal lines (each corner perpendicular to the opposite diagonal).
    function drawDiagonals(r) {
        strokeSeg(r.x, r.y, r.x + r.w, r.y + r.h);
        strokeSeg(r.x + r.w, r.y, r.x, r.y + r.h);
        const w = r.w;
        const h = r.h;
        const tl = { x: r.x, y: r.y };
        const tr = { x: r.x + w, y: r.y };
        const br = { x: r.x + w, y: r.y + h };
        const bl = { x: r.x, y: r.y + h };
        // perpendicular of diagonal A (TL→BR, dir w,h) is (-h,w)
        strokeClipped(tr.x, tr.y, -h, w, r);
        strokeClipped(bl.x, bl.y, -h, w, r);
        // perpendicular of diagonal B (TR→BL, dir -w,h) is (h,w)
        strokeClipped(tl.x, tl.y, h, w, r);
        strokeClipped(br.x, br.y, h, w, r);
    }

    function drawSafe(r) {
        // Action safe ≈ 90% (5% inset), title safe ≈ 80% (10% inset).
        for (const inset of [0.05, 0.1]) {
            const x = r.x + r.w * inset;
            const y = r.y + r.h * inset;
            const w = r.w * (1 - inset * 2);
            const h = r.h * (1 - inset * 2);
            ctx.strokeRect(x, y, w, h);
        }
    }

    // Canonical golden spiral as a polyline in a φ:1 landscape box, sampled so
    // the host can apply a non-uniform fit + orientation flip without scaling
    // the line width. Built by recursive golden-square subdivision; arcs chain
    // corner-to-corner (cycle: left, bottom, right, top).
    function canonicalSpiralPoints(depth = 12, perArc = 22) {
        const pts = [];
        let l = 0;
        let t = 0;
        let rr = PHI;
        let b = 1;
        const phases = ['L', 'B', 'R', 'T'];
        for (let i = 0; i < depth; i++) {
            const cw = rr - l;
            const ch = b - t;
            if (cw < 1e-4 || ch < 1e-4) break;
            let cx;
            let cy;
            let s;
            let p0;
            let p1;
            switch (phases[i % 4]) {
                case 'L': {
                    s = ch; const nl = l + s; cx = nl; cy = t;
                    p0 = { x: l, y: t }; p1 = { x: nl, y: b }; l = nl; break;
                }
                case 'B': {
                    s = cw; const nb = b - s; cx = rr; cy = b;
                    p0 = { x: l, y: b }; p1 = { x: rr, y: nb }; b = nb; break;
                }
                case 'R': {
                    s = ch; const nr = rr - s; cx = nr; cy = b;
                    p0 = { x: rr, y: b }; p1 = { x: nr, y: t }; rr = nr; break;
                }
                default: {
                    s = cw; const nt = t + s; cx = l; cy = t;
                    p0 = { x: rr, y: t }; p1 = { x: l, y: nt }; t = nt; break;
                }
            }
            let a0 = Math.atan2(p0.y - cy, p0.x - cx);
            const a1 = Math.atan2(p1.y - cy, p1.x - cx);
            let d = a1 - a0;
            while (d > Math.PI) d -= Math.PI * 2;
            while (d < -Math.PI) d += Math.PI * 2;
            for (let k = (i === 0 ? 0 : 1); k <= perArc; k++) {
                const a = a0 + (d * k) / perArc;
                pts.push({ x: cx + Math.cos(a) * s, y: cy + Math.sin(a) * s });
            }
        }
        return pts;
    }

    function drawSpiral(r) {
        const flipX = (state.spiralOrientation & 1) !== 0;
        const flipY = (state.spiralOrientation & 2) !== 0;
        const pts = canonicalSpiralPoints().map(p => {
            const u = flipX ? PHI - p.x : p.x; // local x in [0, PHI]
            const v = flipY ? 1 - p.y : p.y;   // local y in [0, 1]
            return { x: r.x + (u / PHI) * r.w, y: r.y + v * r.h };
        });
        strokePoly(pts);
        // Also outline the frame the spiral is inscribed in for context.
        ctx.save();
        ctx.globalAlpha *= 0.5;
        ctx.strokeRect(r.x, r.y, r.w, r.h);
        ctx.restore();
    }

    // ── Compose the frame ───────────────────────────────────────────────
    function innerRect() {
        const ratio = aspectRatioFor(state.aspect);
        if (!(ratio > 0)) return { x: 0, y: 0, w: cssW, h: cssH, masked: false };
        const frameRatio = cssW / cssH;
        let w = cssW;
        let h = cssH;
        if (frameRatio > ratio) {
            w = Math.round(cssH * ratio); // pillarbox
        } else {
            h = Math.round(cssW / ratio); // letterbox
        }
        return {
            x: Math.round((cssW - w) / 2),
            y: Math.round((cssH - h) / 2),
            w,
            h,
            masked: w < cssW - 0.5 || h < cssH - 0.5,
        };
    }

    function drawMask(r) {
        ctx.save();
        ctx.fillStyle = `rgba(0, 0, 0, ${clamp(state.maskOpacity, 0, 1)})`;
        if (r.y > 0) ctx.fillRect(0, 0, cssW, r.y);
        if (r.y + r.h < cssH) ctx.fillRect(0, r.y + r.h, cssW, cssH - (r.y + r.h));
        if (r.x > 0) ctx.fillRect(0, r.y, r.x, r.h);
        if (r.x + r.w < cssW) ctx.fillRect(r.x + r.w, r.y, cssW - (r.x + r.w), r.h);
        ctx.restore();
    }

    function draw() {
        const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 3));
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, cssH);
        if (!isActive()) {
            canvas.style.display = 'none';
            return;
        }
        canvas.style.display = '';

        const r = innerRect();
        if (r.masked) drawMask(r);

        ctx.save();
        ctx.strokeStyle = state.color;
        ctx.globalAlpha = clamp(state.opacity, 0.05, 1);
        ctx.lineWidth = Math.max(0.5, state.thickness);
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        // Soft dark halo so light guides stay legible over bright frames.
        ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
        ctx.shadowBlur = Math.max(1.5, state.thickness * 1.5);

        const g = state.guides;
        if (g.grid) drawGrid(r);
        if (g.thirds) drawThirds(r);
        if (g.phi) drawPhi(r);
        if (g.diagonal) drawDiagonals(r);
        if (g.spiral) drawSpiral(r);
        if (g.cross) drawCross(r);
        if (g.safe) drawSafe(r);
        ctx.restore();

        if (r.masked) {
            ctx.save();
            ctx.strokeStyle = state.color;
            ctx.globalAlpha = clamp(state.opacity, 0.05, 1) * 0.8;
            ctx.lineWidth = Math.max(0.5, state.thickness);
            ctx.strokeRect(r.x, r.y, r.w, r.h);
            ctx.restore();
        }
    }

    function resize(rect = getFrameRect?.()) {
        if (!rect) return;
        const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 3));
        cssW = Math.max(1, Math.round(rect.width));
        cssH = Math.max(1, Math.round(rect.height));
        const pxW = Math.round(cssW * dpr);
        const pxH = Math.round(cssH * dpr);
        if (canvas.width !== pxW) canvas.width = pxW;
        if (canvas.height !== pxH) canvas.height = pxH;
        applyFrameStyle?.(canvas, rect);
        draw();
    }

    // ── Public mutators (persist + redraw) ──────────────────────────────
    return {
        canvas,
        isActive,
        resize,
        draw,
        getState: () => ({ ...state, guides: { ...state.guides } }),
        setGuide(id, on) {
            state.guides[id] = !!on;
            persist();
            draw();
        },
        toggleGuide(id) {
            state.guides[id] = !state.guides[id];
            persist();
            draw();
            return state.guides[id];
        },
        clearGuides() {
            for (const k of Object.keys(state.guides)) state.guides[k] = false;
            state.aspect = 'off';
            persist();
            draw();
        },
        setColor(hex) {
            if (typeof hex === 'string') {
                state.color = hex;
                persist();
                draw();
            }
        },
        setOpacity(v) {
            const n = Number(v);
            if (Number.isFinite(n)) {
                state.opacity = clamp(n, 0.05, 1);
                persist();
                draw();
            }
        },
        setThickness(v) {
            const n = Number(v);
            if (Number.isFinite(n)) {
                state.thickness = clamp(n, 0.5, 4);
                persist();
                draw();
            }
        },
        setGridDivisions(v) {
            const n = Math.round(Number(v));
            if (Number.isFinite(n)) {
                state.gridDivisions = clamp(n, 2, 24);
                persist();
                draw();
            }
        },
        setSpiralOrientation(v) {
            const n = Number(v) & 3;
            state.spiralOrientation = n;
            persist();
            draw();
        },
        setAspect(id) {
            if (COMPOSITION_ASPECTS.some(a => a.id === id)) {
                state.aspect = id;
                persist();
                draw();
            }
        },
    };
}

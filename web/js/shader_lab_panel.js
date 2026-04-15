// Shader Lab configurator panel — full layer-stack editor for the
// shader-lab post-fx pipeline. React + htm UI mounted into the side
// panel, drives shaderLabFx via setConfig() with auto-debounced apply.
//
// Visual style reuses MaxJS's existing .fx-control / .fx-range / .fx-check
// classes so it matches the rest of the panels (no blue native sliders).

const EFFECT_TYPES = [
    'ascii', 'circuit-bent', 'directional-blur', 'chromatic-aberration',
    'crt', 'displacement-map', 'dithering', 'edge-detect', 'fluted-glass',
    'halftone', 'ink', 'particle-grid', 'pattern', 'pixelation',
    'pixel-sorting', 'plotter', 'posterize', 'slice', 'smear', 'threshold',
];

const SOURCE_TYPES = [
    'custom-shader', 'gradient', 'image', 'live', 'text', 'video',
];

const BLEND_MODES = [
    'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten',
    'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference',
    'exclusion', 'hue', 'saturation', 'color', 'luminosity',
];

const COMPOSITE_MODES = ['filter', 'mask'];

let _idCounter = 0;
function nextId() {
    _idCounter++;
    return 'layer-' + Date.now().toString(36) + '-' + _idCounter;
}

function makeLayer(type = 'crt', kind = 'effect') {
    return {
        id: nextId(),
        kind,
        type,
        name: type.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        visible: true,
        opacity: 1,
        hue: 0,
        saturation: 1,
        blendMode: 'normal',
        compositeMode: 'filter',
        params: {},
    };
}

const DEFAULT_CONFIG = () => ({
    composition: { width: 1920, height: 1080 },
    layers: [makeLayer('crt')],
    timeline: { duration: 6, loop: true, tracks: [] },
});

let _loadPromise = null;
async function ensureReact() {
    if (!_loadPromise) {
        _loadPromise = (async () => {
            const [ReactMod, ReactDOMClientMod, htmMod] = await Promise.all([
                import('react'),
                import('react-dom/client'),
                import('https://esm.sh/htm@3.1.1'),
            ]);
            const React = ReactMod.default ?? ReactMod;
            const ReactDOMClient = ReactDOMClientMod;
            const htm = htmMod.default ?? htmMod;
            return { React, ReactDOMClient, htm };
        })();
    }
    return _loadPromise;
}

// One-time stylesheet injection for the few classes that aren't already
// covered by MaxJS's panel CSS. Scoped under .sl-panel so they can't
// leak into other panels.
let _stylesInjected = false;
function injectStyles() {
    if (_stylesInjected) return;
    _stylesInjected = true;
    const css = `
        /* ── Width containment ────────────────────────────────
         * The default .sidepanel-body is a grid with auto columns,
         * which grow to fit content's intrinsic width. A long
         * <option> string in a Type select can push the grid track
         * past the 280px panel and overflow the right edge. Force
         * minmax(0, 1fr) + min-width:0 on every flex/grid child so
         * everything shrinks to the panel width.
         * ──────────────────────────────────────────────────── */
        .sl-panel,
        .sl-panel * { box-sizing: border-box; }
        .sl-panel { min-width: 0; max-width: 100%; overflow-x: hidden; }
        .sl-panel .sidepanel-body { grid-template-columns: minmax(0, 1fr); }
        .sl-panel .sidepanel-body > * { min-width: 0; max-width: 100%; }
        .sl-panel .fx-section { min-width: 0; max-width: 100%; overflow: hidden; }
        .sl-panel .fx-control { min-width: 0; max-width: 100%; }
        .sl-panel select,
        .sl-panel input[type="text"],
        .sl-panel input[type="range"] {
            width: 100%;
            max-width: 100%;
            min-width: 0;
        }

        /* ── Layer cards ──────────────────────────────────── */
        .sl-card {
            background: rgba(255,255,255,0.025);
            border: 1px solid rgba(255,255,255,0.08);
            border-radius: 4px;
            margin-bottom: 6px;
            overflow: hidden;
            min-width: 0;
            max-width: 100%;
        }
        .sl-card-head {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px 10px;
            cursor: pointer;
            user-select: none;
            min-width: 0;
            overflow: hidden;
        }
        .sl-card-head:hover { background: rgba(255,255,255,0.03); }
        .sl-dot {
            width: 7px; height: 7px; border-radius: 50%;
            flex-shrink: 0;
        }
        .sl-dot.on  { background: #40c8b0; box-shadow: 0 0 6px rgba(64,200,176,0.5); }
        .sl-dot.off { background: #444; }
        .sl-name {
            flex: 1 1 0;
            min-width: 0;
            font: 600 11px/1.2 'Segoe UI', system-ui, sans-serif;
            background: transparent; border: none; color: #ddd;
            outline: none; padding: 0;
            text-overflow: ellipsis; overflow: hidden;
        }
        .sl-pill {
            font: 9px/1 'Segoe UI', system-ui, sans-serif;
            text-transform: uppercase;
            letter-spacing: 0.8px;
            color: #888;
            padding: 3px 8px;
            border-radius: 999px;
            background: rgba(255,255,255,0.05);
            border: 1px solid rgba(255,255,255,0.06);
            white-space: nowrap;
            flex-shrink: 1;
            min-width: 0;
            max-width: 96px;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .sl-eye {
            background: transparent; border: none; cursor: pointer;
            font-size: 13px; color: #555;
            padding: 2px 4px;
            line-height: 1;
            flex-shrink: 0;
        }
        .sl-eye.on { color: #40c8b0; }
        .sl-card-body {
            padding: 4px 10px 10px;
            border-top: 1px solid rgba(255,255,255,0.04);
            min-width: 0;
            overflow: hidden;
        }
        .sl-select {
            width: 100%;
            max-width: 100%;
            min-width: 0;
            background: rgba(255,255,255,0.04);
            color: #ccc;
            border: 1px solid rgba(255,255,255,0.08);
            border-radius: 0;
            padding: 4px 6px;
            font: 10px 'Segoe UI', system-ui, sans-serif;
            outline: none;
            cursor: pointer;
        }
        .sl-row-actions {
            display: flex;
            gap: 4px;
            margin-top: 8px;
            justify-content: space-between;
        }
        .sl-mini {
            font: 9px 'Segoe UI', system-ui, sans-serif;
            text-transform: uppercase;
            letter-spacing: 0.8px;
            padding: 4px 10px;
            background: rgba(255,255,255,0.04);
            border: 1px solid rgba(255,255,255,0.1);
            color: #ccc;
            cursor: pointer;
            border-radius: 0;
        }
        .sl-mini:hover:not(:disabled) { background: rgba(255,255,255,0.08); }
        .sl-mini:disabled { opacity: 0.35; cursor: not-allowed; }
        .sl-mini.danger { color: #f88; border-color: rgba(255,100,100,0.25); }
        .sl-mini.danger:hover { background: rgba(255,100,100,0.08); }
        .sl-add-row {
            display: flex;
            gap: 4px;
            margin-bottom: 8px;
            min-width: 0;
        }
        .sl-add-row .sl-select { flex: 1 1 0; min-width: 0; }
        .sl-empty {
            font: 10px 'Segoe UI', system-ui, sans-serif;
            color: #555;
            padding: 8px 0;
            text-align: center;
        }
    `;
    const style = document.createElement('style');
    style.id = 'sl-panel-styles';
    style.textContent = css;
    document.head.appendChild(style);
}

function buildApp({ React, htm, shaderLabFx }) {
    const html = htm.bind(React.createElement);
    const { useState, useEffect, useRef, useCallback } = React;

    function FxSlider({ label, value, min, max, step, format, onChange }) {
        const display = format ? format(value) : (
            Math.abs(value) < 10 ? value.toFixed(2) : value.toFixed(0)
        );
        return html`
            <label className="fx-control">
                <div className="fx-control-head">
                    <span>${label}</span>
                    <span className="fx-value">${display}</span>
                </div>
                <input
                    className="fx-range"
                    type="range"
                    min=${min} max=${max} step=${step ?? 0.01} value=${value}
                    onInput=${(e) => onChange(parseFloat(e.target.value))}
                />
            </label>
        `;
    }

    function FxSelect({ label, value, options, onChange }) {
        return html`
            <label className="fx-control">
                <div className="fx-control-head">
                    <span>${label}</span>
                </div>
                <select className="sl-select" value=${value}
                    onChange=${(e) => onChange(e.target.value)}>
                    ${options.map(o => html`<option key=${o} value=${o}>${o}</option>`)}
                </select>
            </label>
        `;
    }

    function LayerCard({ layer, index, total, onUpdate, onRemove, onMoveUp, onMoveDown }) {
        const [open, setOpen] = useState(true);
        const update = (patch) => onUpdate({ ...layer, ...patch });
        const isSource = layer.kind === 'source';
        const typeOptions = isSource ? SOURCE_TYPES : EFFECT_TYPES;

        return html`
            <div className="sl-card">
                <div className="sl-card-head" onClick=${() => setOpen(!open)}>
                    <span className=${'sl-dot ' + (layer.visible ? 'on' : 'off')}></span>
                    <input
                        className="sl-name"
                        value=${layer.name}
                        onClick=${(e) => e.stopPropagation()}
                        onChange=${(e) => update({ name: e.target.value })}
                    />
                    <span className="sl-pill">${layer.type}</span>
                    <button
                        type="button"
                        className=${'sl-eye ' + (layer.visible ? 'on' : '')}
                        onClick=${(e) => { e.stopPropagation(); update({ visible: !layer.visible }); }}
                        title="Toggle visibility"
                    >${layer.visible ? '◉' : '○'}</button>
                </div>
                ${open && html`
                    <div className="sl-card-body">
                        <${FxSelect} label="Kind" value=${layer.kind} options=${['effect', 'source']}
                            onChange=${(v) => update({ kind: v, type: v === 'source' ? SOURCE_TYPES[0] : EFFECT_TYPES[0] })} />
                        <${FxSelect} label="Type" value=${layer.type} options=${typeOptions}
                            onChange=${(v) => update({ type: v })} />
                        <${FxSlider} label="Opacity" value=${layer.opacity} min=${0} max=${1} step=${0.01}
                            onChange=${(v) => update({ opacity: v })} />
                        <${FxSlider} label="Hue" value=${layer.hue} min=${-180} max=${180} step=${1}
                            format=${(v) => Math.round(v) + '°'}
                            onChange=${(v) => update({ hue: v })} />
                        <${FxSlider} label="Saturation" value=${layer.saturation} min=${0} max=${2} step=${0.01}
                            onChange=${(v) => update({ saturation: v })} />
                        <${FxSelect} label="Blend" value=${layer.blendMode} options=${BLEND_MODES}
                            onChange=${(v) => update({ blendMode: v })} />
                        <${FxSelect} label="Composite" value=${layer.compositeMode} options=${COMPOSITE_MODES}
                            onChange=${(v) => update({ compositeMode: v })} />
                        <div className="sl-row-actions">
                            <div style=${{ display: 'flex', gap: '4px' }}>
                                <button type="button" className="sl-mini"
                                    onClick=${onMoveUp} disabled=${index === 0}>▲</button>
                                <button type="button" className="sl-mini"
                                    onClick=${onMoveDown} disabled=${index === total - 1}>▼</button>
                            </div>
                            <button type="button" className="sl-mini danger"
                                onClick=${onRemove}>Delete</button>
                        </div>
                    </div>
                `}
            </div>
        `;
    }

    return function ShaderLabApp({ onHide }) {
        const [config, setConfig] = useState(() => DEFAULT_CONFIG());
        const [enabled, setEnabled] = useState(() => shaderLabFx.isEnabled());
        const [status, setStatus] = useState('off');
        const [statusColor, setStatusColor] = useState('#777');
        const [autoApply, setAutoApply] = useState(true);
        const [addType, setAddType] = useState(EFFECT_TYPES[0]);
        const debounceTimer = useRef(0);

        const applyNow = useCallback(async (cfg) => {
            if (!shaderLabFx.isEnabled()) return;
            try {
                setStatus('applying...');
                setStatusColor('#fa5');
                await shaderLabFx.setConfig(cfg);
                setStatus('live');
                setStatusColor('#40c8b0');
            } catch (err) {
                setStatus('apply failed');
                setStatusColor('#f66');
                console.error('[ShaderLab] setConfig failed:', err);
            }
        }, []);

        useEffect(() => {
            if (!autoApply || !enabled) return;
            clearTimeout(debounceTimer.current);
            debounceTimer.current = setTimeout(() => applyNow(config), 350);
            return () => clearTimeout(debounceTimer.current);
        }, [config, enabled, autoApply, applyNow]);

        const toggleEnabled = useCallback(async () => {
            if (shaderLabFx.isEnabled()) {
                shaderLabFx.disable();
                setEnabled(false);
                setStatus('off');
                setStatusColor('#777');
                return;
            }
            setStatus('loading...');
            setStatusColor('#fa5');
            try {
                await shaderLabFx.enable(config);
                setEnabled(true);
                setStatus('live');
                setStatusColor('#40c8b0');
            } catch (err) {
                setStatus('error: ' + (err?.message || err));
                setStatusColor('#f66');
                console.error('[ShaderLab] enable failed:', err);
            }
        }, [config]);

        const addLayer = useCallback(() => {
            const isSource = SOURCE_TYPES.includes(addType);
            setConfig(c => ({
                ...c,
                layers: [...c.layers, makeLayer(addType, isSource ? 'source' : 'effect')],
            }));
        }, [addType]);

        const updateLayer = useCallback((id, next) => {
            setConfig(c => ({
                ...c,
                layers: c.layers.map(l => l.id === id ? next : l),
            }));
        }, []);

        const removeLayer = useCallback((id) => {
            setConfig(c => ({ ...c, layers: c.layers.filter(l => l.id !== id) }));
        }, []);

        const moveLayer = useCallback((index, dir) => {
            setConfig(c => {
                const layers = [...c.layers];
                const target = index + dir;
                if (target < 0 || target >= layers.length) return c;
                [layers[index], layers[target]] = [layers[target], layers[index]];
                return { ...c, layers };
            });
        }, []);

        const updateComposition = useCallback((patch) => {
            setConfig(c => ({ ...c, composition: { ...c.composition, ...patch } }));
        }, []);

        const resetConfig = useCallback(() => setConfig(DEFAULT_CONFIG()), []);

        return html`
            <div className="sl-panel">
                <div className="sidepanel-header">
                    <div>
                        <div className="sidepanel-title">Shader Lab</div>
                        <div className="sidepanel-subtitle" style=${{ color: statusColor }}>${status}</div>
                    </div>
                    <div style=${{ display: 'flex', gap: '4px' }}>
                        <button type="button" onClick=${resetConfig}>Reset</button>
                        <button type="button" onClick=${onHide}>Hide</button>
                    </div>
                </div>
                <div className="sidepanel-body">
                    <section className="fx-section">
                        <div className="fx-section-header">
                            <div className="fx-section-title">Pipeline</div>
                            <button type="button" className=${'fx-toggle ' + (enabled ? 'active' : '')}
                                onClick=${toggleEnabled}>${enabled ? 'On' : 'Off'}</button>
                        </div>
                        <label className="fx-check">
                            <span>Auto-apply</span>
                            <input type="checkbox" checked=${autoApply}
                                onChange=${(e) => setAutoApply(e.target.checked)} />
                        </label>
                        ${!autoApply && html`
                            <button type="button" onClick=${() => applyNow(config)}
                                style=${{ width: '100%', marginTop: '6px' }}>
                                Apply Now
                            </button>
                        `}
                        <div className="fx-note">
                            Bypasses ssgiFx — losing SSGI/SSR/GTAO while on.
                        </div>
                    </section>

                    <section className="fx-section">
                        <div className="fx-section-header">
                            <div className="fx-section-title">Composition</div>
                        </div>
                        <${FxSlider} label="Width" value=${config.composition.width}
                            min=${256} max=${4096} step=${1}
                            format=${(v) => Math.round(v) + 'px'}
                            onChange=${(v) => updateComposition({ width: Math.round(v) })} />
                        <${FxSlider} label="Height" value=${config.composition.height}
                            min=${256} max=${4096} step=${1}
                            format=${(v) => Math.round(v) + 'px'}
                            onChange=${(v) => updateComposition({ height: Math.round(v) })} />
                    </section>

                    <section className="fx-section">
                        <div className="fx-section-header">
                            <div className="fx-section-title">Layers (${config.layers.length})</div>
                        </div>
                        <div className="sl-add-row">
                            <select className="sl-select" value=${addType}
                                onChange=${(e) => setAddType(e.target.value)}>
                                <optgroup label="Effects">
                                    ${EFFECT_TYPES.map(t => html`<option key=${t} value=${t}>${t}</option>`)}
                                </optgroup>
                                <optgroup label="Sources">
                                    ${SOURCE_TYPES.map(t => html`<option key=${t} value=${t}>${t}</option>`)}
                                </optgroup>
                            </select>
                            <button type="button" className="sl-mini" onClick=${addLayer}>+ Add</button>
                        </div>
                        ${config.layers.length === 0
                            ? html`<div className="sl-empty">No layers — add one above.</div>`
                            : config.layers.map((layer, i) => html`
                                <${LayerCard}
                                    key=${layer.id}
                                    layer=${layer}
                                    index=${i}
                                    total=${config.layers.length}
                                    onUpdate=${(next) => updateLayer(layer.id, next)}
                                    onRemove=${() => removeLayer(layer.id)}
                                    onMoveUp=${() => moveLayer(i, -1)}
                                    onMoveDown=${() => moveLayer(i, 1)}
                                />
                            `)
                        }
                    </section>
                </div>
            </div>
        `;
    };
}

export async function createShaderLabPanel({ panelEl, shaderLabFx, onHide }) {
    injectStyles();
    const { React, ReactDOMClient, htm } = await ensureReact();
    const App = buildApp({ React, htm, shaderLabFx });
    const root = ReactDOMClient.createRoot(panelEl);
    root.render(React.createElement(App, { onHide }));
    return {
        unmount() { try { root.unmount(); } catch (_) {} },
    };
}

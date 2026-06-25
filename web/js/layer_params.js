// layer_params.js - declarative runtime-layer parameters.
// Values are JSON-safe so they can ride the live UI, hot reloads, and snapshots.

const BLOCKED_PARAM_NAMES = new Set(['__proto__', 'prototype', 'constructor']);

function isObject(value) {
    return !!(value && typeof value === 'object');
}

function isPlainObject(value) {
    if (!isObject(value) || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function normalizeName(raw) {
    const name = String(raw ?? '').trim();
    if (!name || BLOCKED_PARAM_NAMES.has(name)) return '';
    return name;
}

function finiteNumber(value, fallback = null) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function clampNumber(value, min = null, max = null) {
    let out = finiteNumber(value, 0);
    if (Number.isFinite(min)) out = Math.max(min, out);
    if (Number.isFinite(max)) out = Math.min(max, out);
    return out;
}

function normalizeType(rawType, value, decl) {
    const raw = String(rawType ?? '').trim().toLowerCase();
    if (raw === 'slider' || raw === 'range') return 'slider';
    if (raw === 'float' || raw === 'number' || raw === 'int' || raw === 'integer') return 'float';
    if (raw === 'color' || raw === 'colour') return 'color';
    if (raw === 'bool' || raw === 'boolean' || raw === 'checkbox' || raw === 'toggle') return 'bool';

    if (isColorLike(value)) return 'color';
    if (typeof value === 'boolean') return 'bool';
    if (Number.isFinite(Number(value))) {
        return Number.isFinite(Number(decl?.min)) && Number.isFinite(Number(decl?.max))
            ? 'slider'
            : 'float';
    }
    if (Number.isFinite(Number(decl?.min)) || Number.isFinite(Number(decl?.max))) return 'slider';
    return '';
}

function isDeclarationObject(value) {
    if (!isPlainObject(value)) return false;
    if (isColorObject(value)) return false;
    return ['type', 'value', 'default', 'label', 'min', 'max', 'step', 'order']
        .some(key => Object.prototype.hasOwnProperty.call(value, key));
}

function isColorObject(value) {
    return isObject(value)
        && Number.isFinite(Number(value.r))
        && Number.isFinite(Number(value.g))
        && Number.isFinite(Number(value.b));
}

function isColorLike(value) {
    if (value?.isColor === true) return true;
    if (typeof value === 'number' && Number.isFinite(value)) return true;
    if (typeof value === 'string') {
        const raw = value.trim();
        return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(raw)
            || /^0x[0-9a-f]{6}$/i.test(raw);
    }
    if (Array.isArray(value) || ArrayBuffer.isView(value)) return value.length >= 3;
    return isColorObject(value);
}

function componentToByte(value) {
    return Math.max(0, Math.min(255, Math.round(value)));
}

function rgbToHex(r, g, b) {
    const hex = (componentToByte(r) << 16) | (componentToByte(g) << 8) | componentToByte(b);
    return `#${hex.toString(16).padStart(6, '0')}`;
}

function normalizeHexString(value) {
    const raw = String(value ?? '').trim();
    const short = raw.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
    if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
    const long = raw.match(/^#([0-9a-f]{6})$/i);
    if (long) return `#${long[1]}`.toLowerCase();
    const numeric = raw.match(/^0x([0-9a-f]{6})$/i);
    if (numeric) return `#${numeric[1]}`.toLowerCase();
    return null;
}

function colorToHex(THREE, value, fallback = '#ffffff') {
    if (typeof value === 'string') {
        const hex = normalizeHexString(value);
        if (hex) return hex;
        if (THREE?.Color) {
            try {
                const color = new THREE.Color(value);
                return `#${color.getHexString()}`;
            } catch {}
        }
        return fallback;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        const hex = Math.max(0, Math.min(0xffffff, Math.trunc(value))) >>> 0;
        return `#${hex.toString(16).padStart(6, '0')}`;
    }
    if (value?.isColor === true) {
        return `#${value.getHexString()}`;
    }
    if (Array.isArray(value) || ArrayBuffer.isView(value)) {
        const r = finiteNumber(value[0], 1);
        const g = finiteNumber(value[1], 1);
        const b = finiteNumber(value[2], 1);
        const scale = Math.max(r, g, b) <= 1 ? 255 : 1;
        return rgbToHex(r * scale, g * scale, b * scale);
    }
    if (isColorObject(value)) {
        const r = finiteNumber(value.r, 1);
        const g = finiteNumber(value.g, 1);
        const b = finiteNumber(value.b, 1);
        const scale = Math.max(r, g, b) <= 1 ? 255 : 1;
        return rgbToHex(r * scale, g * scale, b * scale);
    }
    return fallback;
}

function labelFromName(name) {
    return String(name)
        .replace(/[_-]+/g, ' ')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^./, c => c.toUpperCase());
}

function cloneInitialValues(raw) {
    const out = {};
    if (Array.isArray(raw)) {
        for (const entry of raw) {
            const name = normalizeName(entry?.name);
            if (!name) continue;
            out[name] = Object.prototype.hasOwnProperty.call(entry, 'value') ? entry.value : entry.default;
        }
        return out;
    }
    if (!isObject(raw)) return out;
    for (const [key, value] of Object.entries(raw)) {
        const name = normalizeName(key);
        if (!name) continue;
        out[name] = isDeclarationObject(value) && Object.prototype.hasOwnProperty.call(value, 'value')
            ? value.value
            : value;
    }
    return out;
}

function declarationFromRaw(raw) {
    if (isDeclarationObject(raw)) return { ...raw };
    return { value: raw };
}

function serializeEntry(entry) {
    const out = {
        name: entry.name,
        label: entry.label,
        type: entry.type,
        value: entry.value,
        default: entry.defaultValue,
        order: entry.order,
    };
    if (Number.isFinite(entry.min)) out.min = entry.min;
    if (Number.isFinite(entry.max)) out.max = entry.max;
    if (entry.step != null) out.step = entry.step;
    if (entry.description) out.description = entry.description;
    return out;
}

function valuesEqual(a, b) {
    return a === b;
}

function entriesEqual(a, b) {
    if (!a || !b) return false;
    return JSON.stringify(serializeEntry(a)) === JSON.stringify(serializeEntry(b));
}

export function createLayerParamController({
    THREE,
    emitChange = () => {},
    debugWarn = () => {},
} = {}) {
    const valueStore = new Map(); // layer id -> { name: value }

    function storedValuesFor(layer) {
        return valueStore.get(layer.id) ?? {};
    }

    function remember(layer) {
        if (!layer?.paramDefs) return;
        const values = {};
        for (const entry of layer.paramDefs.values()) values[entry.name] = entry.value;
        if (Object.keys(values).length > 0) valueStore.set(layer.id, values);
    }

    function normalizeDefinition(layer, name, raw, previousValue) {
        const decl = declarationFromRaw(raw);
        const rawDefault = Object.prototype.hasOwnProperty.call(decl, 'value')
            ? decl.value
            : decl.default;
        const type = normalizeType(decl.type, rawDefault, decl);
        if (!type) {
            debugWarn(`[ctx.params] "${layer.id}.${name}": unsupported parameter declaration`);
            return null;
        }

        const existing = layer.paramDefs?.get(name);
        const order = Number.isFinite(Number(decl.order))
            ? Number(decl.order)
            : existing?.order ?? layer.paramNextOrder++;
        const label = String(decl.label || labelFromName(name));
        const description = typeof decl.description === 'string' ? decl.description : '';

        let min = finiteNumber(decl.min, null);
        let max = finiteNumber(decl.max, null);
        let step = finiteNumber(decl.step, null);
        let defaultValue = null;
        let value = previousValue;

        if (type === 'color') {
            defaultValue = colorToHex(THREE, rawDefault, '#ffffff');
            value = colorToHex(THREE, value ?? defaultValue, defaultValue);
            step = null;
            min = null;
            max = null;
        } else if (type === 'bool') {
            defaultValue = rawDefault != null ? !!rawDefault : false;
            value = value != null ? !!value : defaultValue;
            step = null;
            min = null;
            max = null;
        } else if (type === 'slider') {
            min = Number.isFinite(min) ? min : 0;
            max = Number.isFinite(max) ? max : 1;
            if (max <= min) max = min + 1;
            step = Number.isFinite(step) && step > 0 ? step : 0.01;
            defaultValue = clampNumber(rawDefault ?? min, min, max);
            value = clampNumber(value ?? defaultValue, min, max);
        } else {
            step = Number.isFinite(step) && step > 0 ? step : 'any';
            defaultValue = finiteNumber(rawDefault, 0);
            value = finiteNumber(value, defaultValue);
            value = clampNumber(value, min, max);
        }

        return {
            name,
            label,
            description,
            type,
            value,
            defaultValue,
            min,
            max,
            step,
            order,
        };
    }

    function ensureProxyProperty(layer, name) {
        if (!layer.paramProxy || Object.prototype.hasOwnProperty.call(layer.paramProxy, name)) return;
        Object.defineProperty(layer.paramProxy, name, {
            enumerable: true,
            configurable: true,
            get() {
                return layer.paramDefs.get(name)?.value;
            },
            set(value) {
                setValue(layer, name, value, { source: 'script' });
            },
        });
    }

    function notify(layer, entry, source) {
        const event = Object.freeze({
            layerId: layer.id,
            name: entry.name,
            value: entry.value,
            parameter: serializeEntry(entry),
            source,
        });
        for (const watcher of [...layer.paramWatchers]) {
            try { watcher(event); }
            catch (error) { console.error(`[ctx.params] "${layer.id}.${entry.name}" watcher failed`, error); }
        }
        if (typeof layer.hooks?.onParamChange === 'function') {
            try { layer.hooks.onParamChange(layer.ctx, event); }
            catch (error) { console.error(`[ctx.params] "${layer.id}.${entry.name}" onParamChange failed`, error); }
        }
    }

    function define(layer, specOrName, maybeDecl, options = {}) {
        const spec = typeof specOrName === 'string'
            ? { [specOrName]: maybeDecl }
            : specOrName;
        if (!isObject(spec)) return layer.paramProxy;

        let changed = false;
        let valueChanged = false;
        const stored = storedValuesFor(layer);
        for (const [rawName, rawDecl] of Object.entries(spec)) {
            const name = normalizeName(rawName);
            if (!name) continue;
            const existing = layer.paramDefs.get(name);
            const previousValue = existing?.value
                ?? stored[name]
                ?? layer.initialParamValues?.[name];
            const next = normalizeDefinition(layer, name, rawDecl, previousValue);
            if (!next) continue;
            const previousSerialized = existing ? serializeEntry(existing) : null;
            layer.paramDefs.set(name, next);
            ensureProxyProperty(layer, name);
            stored[name] = next.value;
            changed = changed || !entriesEqual(existing, next);
            if (existing && !valuesEqual(existing.value, next.value)) {
                valueChanged = true;
                notify(layer, next, options.source || 'define');
            } else if (!existing && previousSerialized == null && options.notifyInitial === true) {
                notify(layer, next, options.source || 'define');
            }
        }
        if (changed || valueChanged) {
            valueStore.set(layer.id, { ...stored });
            if (!layer.loading && options.silent !== true) emitChange('params');
        }
        return layer.paramProxy;
    }

    function coerceValue(entry, value) {
        if (entry.type === 'color') return colorToHex(THREE, value, entry.value);
        if (entry.type === 'bool') return !!value;
        return clampNumber(finiteNumber(value, entry.value), entry.min, entry.max);
    }

    function setValue(layer, nameRaw, value, options = {}) {
        const name = normalizeName(nameRaw);
        if (!name) return null;
        let entry = layer.paramDefs.get(name);
        if (!entry) {
            define(layer, name, value, { silent: true, source: options.source || 'set' });
            entry = layer.paramDefs.get(name);
        }
        if (!entry) return null;
        const nextValue = coerceValue(entry, value);
        if (valuesEqual(entry.value, nextValue)) return serializeEntry(entry);
        entry = { ...entry, value: nextValue };
        layer.paramDefs.set(name, entry);
        const stored = { ...storedValuesFor(layer), [name]: entry.value };
        valueStore.set(layer.id, stored);
        notify(layer, entry, options.source || 'set');
        if (options.silent !== true) emitChange('params');
        return serializeEntry(entry);
    }

    function getValue(layer, nameRaw) {
        const name = normalizeName(nameRaw);
        return name ? layer.paramDefs.get(name)?.value : undefined;
    }

    function list(layer) {
        return [...(layer.paramDefs?.values() ?? [])]
            .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
            .map(serializeEntry);
    }

    function color(layer, name, target = null) {
        const value = getValue(layer, name);
        const hex = colorToHex(THREE, value, '#ffffff');
        if (target?.isColor && typeof target.set === 'function') {
            target.set(hex);
            return target;
        }
        return THREE?.Color ? new THREE.Color(hex) : hex;
    }

    function initLayer(layer, options = {}) {
        layer.paramDefs = new Map();
        layer.paramProxy = {};
        layer.paramWatchers = new Set();
        layer.paramNextOrder = 0;
        layer.initialParamValues = cloneInitialValues(
            options.paramValues ?? options.parameters ?? options.params,
        );
    }

    function createFacade(layer) {
        return Object.freeze({
            define(specOrName, declaration) {
                return define(layer, specOrName, declaration, { source: 'define' });
            },
            add(name, declaration) {
                define(layer, name, declaration, { source: 'define' });
                return layer.paramProxy;
            },
            set(name, value) {
                return setValue(layer, name, value, { source: 'script' })?.value;
            },
            get(name) {
                return getValue(layer, name);
            },
            color(name, target = null) {
                return color(layer, name, target);
            },
            list() {
                return list(layer);
            },
            onChange(handler) {
                if (typeof handler !== 'function') throw new TypeError('ctx.params.onChange: handler must be a function');
                layer.paramWatchers.add(handler);
                const dispose = () => layer.paramWatchers.delete(handler);
                layer.disposers.push(dispose);
                return dispose;
            },
            get values() {
                return layer.paramProxy;
            },
        });
    }

    function setLayerParameter(layers, id, name, value, options = {}) {
        const layer = layers.get(id);
        return layer ? setValue(layer, name, value, options) : null;
    }

    return {
        initLayer,
        createFacade,
        define,
        list,
        remember,
        setLayerParameter,
    };
}

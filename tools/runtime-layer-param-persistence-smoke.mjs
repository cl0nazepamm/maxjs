import assert from 'node:assert/strict';

import { createProjectRuntime } from '../web/js/project_runtime.js';

const manifestText = `${JSON.stringify({
    name: 'Parameter Persistence Smoke',
    pollMs: 0,
    layers: [],
    studio: { preset: 'keep-me' },
}, null, 2)}\n`;

function makeResponse(status, body = '') {
    return {
        ok: status >= 200 && status < 300,
        status,
        async text() {
            return body;
        },
    };
}

function makeFetch(settingsText = null, settingsDelayMs = 0) {
    return async (url) => {
        const pathname = new URL(url).pathname;
        if (pathname.endsWith('/project.maxjs.json')) {
            return makeResponse(200, manifestText);
        }
        if (pathname.endsWith('/postfx.maxjs.json')) {
            return makeResponse(404);
        }
        if (pathname.endsWith('/settings.maxjs.json')) {
            if (settingsDelayMs > 0) {
                await new Promise(resolve => setTimeout(resolve, settingsDelayMs));
            }
            return settingsText == null
                ? makeResponse(404)
                : makeResponse(200, settingsText);
        }
        throw new Error(`Unexpected fetch: ${url}`);
    };
}

function makeBridge(onSend = () => {}) {
    const handlers = new Map();
    const bridge = {
        on(type, handler) {
            let bucket = handlers.get(type);
            if (!bucket) {
                bucket = new Set();
                handlers.set(type, bucket);
            }
            bucket.add(handler);
            return () => bucket.delete(handler);
        },
        send(type, payload) {
            onSend(type, payload, bridge);
        },
        async emit(type, payload) {
            const pending = [];
            for (const handler of handlers.get(type) ?? []) {
                pending.push(handler(payload));
            }
            await Promise.all(pending);
        },
    };
    return bridge;
}

function makeLayerManager(onMount = () => {}) {
    const mounted = new Map();
    return {
        async mount(id, factory, options) {
            onMount(id, factory, options);
            mounted.set(id, {
                id,
                name: options.name || id,
                source: options.source,
                active: true,
            });
            return { id, error: null };
        },
        remove(id) {
            return mounted.delete(id);
        },
        setActive(id, active) {
            const layer = mounted.get(id);
            if (layer) layer.active = !!active;
            return !!layer;
        },
        list() {
            return [...mounted.values()];
        },
    };
}

let savedSettingsText = '';
let settingsWriteCount = 0;
let firstBridge;
firstBridge = makeBridge((type, payload) => {
    assert.equal(type, 'project_settings_write', 'parameter commits use the existing project settings host action');
    settingsWriteCount++;
    savedSettingsText = Buffer.from(payload.contentBase64, 'base64').toString('utf8');
    queueMicrotask(() => {
        void firstBridge.emit('host_action_result', {
            type: 'host_action_result',
            requestId: payload.requestId,
            ok: true,
        });
    });
});

const firstRuntime = createProjectRuntime({
    layerManager: makeLayerManager(),
    bridge: firstBridge,
    fetchImpl: makeFetch(),
});

await firstRuntime.setProjectDirectory('C:\\ParameterPersistenceSmoke', {
    inlineDir: 'C:\\ParameterPersistenceSmoke\\scripts',
    sceneSaved: true,
    manifestExists: true,
});

await Promise.all([
    firstRuntime.persistLayerParameterValue('atmosphere/sky', 'turbidity', 3.75),
    firstRuntime.persistLayerParameterValue('atmosphere/sky', 'numericLabel', '007'),
    firstRuntime.persistLayerParameterValue('atmosphere/sky', 'enabled', false),
]);

assert.equal(settingsWriteCount, 1, 'rapid committed values coalesce into one settings write');
const savedSettings = JSON.parse(savedSettingsText);
assert.deepEqual(savedSettings.studio, { preset: 'keep-me' }, 'unrelated project settings survive parameter persistence');
assert.deepEqual(savedSettings.runtimeLayerParams, {
    version: 1,
    layers: {
        'atmosphere/sky': {
            turbidity: 3.75,
            numericLabel: '007',
            enabled: false,
        },
    },
}, 'settings contain value-only runtime layer parameter state');

let mountedOptions = null;
const secondLayerManager = makeLayerManager((_id, _factory, options) => {
    mountedOptions = options;
});
const secondBridge = makeBridge((type) => {
    throw new Error(`Fresh runtime unexpectedly sent host action: ${type}`);
});
const secondRuntime = createProjectRuntime({
    layerManager: secondLayerManager,
    bridge: secondBridge,
    fetchImpl: makeFetch(savedSettingsText, 30),
    importModule: async () => ({
        default() {
            return {};
        },
    }),
});

// Native startup sends these back-to-back. The inline scan must wait for the
// delayed settings fetch before mounting the layer.
await secondBridge.emit('project_config', {
    dir: 'C:\\ParameterPersistenceSmoke',
    inlineDir: 'C:\\ParameterPersistenceSmoke\\scripts',
    sceneSaved: true,
    manifestExists: true,
    pollMs: 0,
});
await secondBridge.emit('inline_layers_state', {
    stamp: 'restart',
    layers: [{
        key: 'atmosphere/sky',
        id: 'sky',
        name: 'sky',
        folder: 'atmosphere',
        priority: 100,
        enabled: true,
        stamp: 'module-v1',
    }],
});

assert.deepEqual(
    secondRuntime.getLayerParameterValues('atmosphere/sky'),
    {
        turbidity: 3.75,
        numericLabel: '007',
        enabled: false,
    },
    'a fresh runtime reloads persisted values without relying on the old in-memory store',
);
assert.deepEqual(
    mountedOptions?.paramValues,
    {
        turbidity: 3.75,
        numericLabel: '007',
        enabled: false,
    },
    'restart values reach the inline layer before its first factory invocation',
);

console.log('runtime-layer-param-persistence-smoke: OK');

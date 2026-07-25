import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import * as THREE from '../web/node_modules/three/build/three.module.js';
import { COMMAND_TYPES, DELTA_FRAME_MAGIC, DELTA_FRAME_VERSION } from '../web/js/protocol.js';

const NOOP = () => {};
const threeStdUrl = new URL('../web/vendor/three-r185/build/three.module.js', import.meta.url).href;
const speedballGiUrl = new URL('../web/vendor/speedball-gi/js/index.js', import.meta.url).href;
const loaderSource = `
export async function resolve(specifier, context, nextResolve) {
    if (specifier === 'three-std') {
        return { url: ${JSON.stringify(threeStdUrl)}, shortCircuit: true };
    }
    if (specifier === 'speedball-gi') {
        return { url: ${JSON.stringify(speedballGiUrl)}, shortCircuit: true };
    }
    return nextResolve(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(loaderSource)}`, import.meta.url);
const { createSceneSync } = await import('../web/js/editor/scene_sync.js');
const { createLights } = await import('../web/js/editor/lights.js');

function makeDeps(base) {
    return new Proxy(base, {
        get(target, property) {
            if (property in target) return target[property];
            return NOOP;
        },
    });
}

function visibilityDelta(handle, visible) {
    const buffer = new ArrayBuffer(28);
    const view = new DataView(buffer);
    view.setUint32(0, DELTA_FRAME_MAGIC, true);
    view.setUint16(4, DELTA_FRAME_VERSION, true);
    view.setUint16(6, 0, true);
    view.setUint32(8, 1, true);
    view.setUint32(12, 1, true);
    view.setUint16(16, COMMAND_TYPES.UpdateVisibility, true);
    view.setUint16(18, 12, true);
    view.setUint32(20, handle, true);
    view.setUint32(24, visible ? 1 : 0, true);
    return buffer;
}

function functionBody(source, signature) {
    const signatureOffset = source.indexOf(signature);
    assert.ok(signatureOffset >= 0, `missing ${signature}`);
    const bodyOffset = source.indexOf('{', signatureOffset + signature.length);
    assert.ok(bodyOffset >= 0, `missing body for ${signature}`);
    let depth = 0;
    for (let i = bodyOffset; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') {
            depth--;
            if (depth === 0) return source.slice(bodyOffset + 1, i);
        }
    }
    assert.fail(`unterminated body for ${signature}`);
}

// Scene-sync regression coverage: payload-stamped names plus every lane that
// can stomp dirty-gated transform/visibility overrides.
{
    const bridgeHandlers = new Map();
    const maxRoot = new THREE.Group();
    const nodeMap = new Map();
    let dirtyMarks = 0;
    const deps = makeDeps({
        hostBridge: {
            onSharedBuffer: NOOP,
            onSharedBufferFallback: NOOP,
        },
        bridge: {
            on(type, callback) {
                bridgeHandlers.set(type, callback);
            },
        },
        maxRoot,
        nodeMap,
        lightHandleMap: new Map(),
        maxInstanceBuckets: new Map(),
        maxInstanceHandleToBucket: new Map(),
        layerManager: {
            markRuntimeTransformsDirty() {
                dirtyMarks++;
            },
        },
        maxjsFx: { markSceneChanged: NOOP },
        applyJsmodSyncState: NOOP,
        applyUserPropsSyncState: NOOP,
        applyInstanceSyncState: NOOP,
        applyMeshShadowState: NOOP,
        applyNodeProps: NOOP,
        applyBridgeVisibility(object, visible) {
            if (visible == null) return false;
            object.userData ??= {};
            const next = !!visible;
            const changed = object.userData.maxjsVisible !== next;
            object.userData.maxjsVisible = next;
            return changed;
        },
        applyLightUpdates: () => false,
    });
    const sync = createSceneSync(deps);
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    mesh.matrixAutoUpdate = false;
    maxRoot.add(mesh);
    nodeMap.set(7, mesh);

    const identity = new THREE.Matrix4().toArray();
    sync.finalizeSceneNode(mesh, { h: 7, n: 'Authored', t: identity });
    assert.equal(mesh.name, 'Authored');
    assert.equal(mesh.userData.maxjsOwner, 'max', 'late-synced Max nodes are stamped at finalization');
    assert.equal(mesh.geometry.userData.maxjsOwner, 'max', 'late-synced Max geometry is protected');
    assert.equal(mesh.material.userData.maxjsOwner, 'max', 'late-synced Max material is protected');
    const runtimeOwnedMap = new THREE.Texture();
    runtimeOwnedMap.userData.maxjsOwner = 'js';
    mesh.material.map = runtimeOwnedMap;
    sync.finalizeSceneNode(mesh, { h: 7, n: 'Authored', t: identity });
    assert.equal(runtimeOwnedMap.userData.maxjsOwner, 'js',
        'Max restamping does not steal ownership of a layer-supplied material map');
    mesh.name = 'Runtime rename';
    sync.finalizeSceneNode(mesh, { h: 7, n: 'Authored', t: identity });
    assert.equal(mesh.name, 'Runtime rename', 'unchanged name payload must not stomp a runtime rename');
    sync.finalizeSceneNode(mesh, { h: 7, n: 'Renamed in Max', t: identity });
    assert.equal(mesh.name, 'Renamed in Max', 'changed Max name payload must propagate');

    dirtyMarks = 0;
    const moved = new THREE.Matrix4().makeTranslation(10, 0, 0).toArray();
    bridgeHandlers.get('xform')({ nodes: [{ h: 7, t: moved }] });
    assert.equal(dirtyMarks, 1, 'JSON transform must dirty runtime overrides once');

    dirtyMarks = 0;
    bridgeHandlers.get('xform')({ nodes: [{ h: 7, vis: 0 }] });
    assert.equal(dirtyMarks, 1, 'JSON visibility must dirty runtime overrides once');

    dirtyMarks = 0;
    bridgeHandlers.get('xform')({ nodes: [], lights: [{ h: 99 }] });
    assert.equal(dirtyMarks, 1, 'light-only JSON updates must dirty runtime overrides once');

    dirtyMarks = 0;
    sync.handleBinaryDelta(visibilityDelta(7, true), {});
    assert.equal(dirtyMarks, 1, 'binary visibility-only delta must dirty runtime overrides once');
}

// Light overrides are guarded before mutation, and authoritative userProps
// survive partial binary payloads without becoming immortal after a full clear.
{
    globalThis.document ??= { getElementById: () => null };
    globalThis.localStorage ??= { getItem: () => null, setItem: NOOP, removeItem: NOOP };

    const overridden = new Set(['color', 'position', 'intensity', 'distance', 'castShadow']);
    const maxRoot = new THREE.Group();
    const lights = createLights(makeDeps({
        maxRoot,
        scene: new THREE.Scene(),
        nodeMap: new Map(),
        lightHandleMap: new Map(),
        MAXJS_SELF_HIDDEN_LAYER: 31,
        defaultLights: new THREE.Group(),
        defaultAmbient: new THREE.AmbientLight(),
        defaultKey: new THREE.DirectionalLight(),
        defaultFill: new THREE.DirectionalLight(),
        layerManager: {
            hasObjectPropertyOverride: (_handle, property) => overridden.has(property),
            applyObjectPropertyOverrides: NOOP,
        },
        maxjsFx: {},
        setObjectSelfVisibleLayer: NOOP,
        syncDefaultLightsVisibility: NOOP,
        lightHelpersVisible: false,
        LIGHT_LINK_STORAGE_KEY: 'maxjs-test-light-links',
    }));

    const light = new THREE.PointLight();
    const runtimeColor = new THREE.Color(0.2, 0.3, 0.4);
    light.color = runtimeColor;
    light.position.set(4, 5, 6);
    const runtimePosition = light.position;
    light.intensity = 17;
    light.distance = 23;
    light.castShadow = false;

    const full = {
        h: 41,
        type: 1,
        name: 'RuntimeGuardedLight',
        v: 1,
        pos: [100, 200, 300],
        dir: [0, -1, 0],
        color: [1, 0, 0],
        intensity: 900,
        distance: 800,
        decay: 2,
        castShadow: true,
        volContrib: 1,
        userProps: 'emitterClass=ir\ncolorTemp=2856',
    };
    lights.applyLightData(light, full);
    assert.equal(light.color, runtimeColor);
    assert.deepEqual(light.color.toArray(), [0.2, 0.3, 0.4]);
    assert.equal(light.position, runtimePosition);
    assert.deepEqual(light.position.toArray(), [4, 5, 6]);
    assert.equal(light.intensity, 17);
    assert.equal(light.distance, 23);
    assert.equal(light.castShadow, false);
    assert.equal(light.userData.maxjsAuthoredIntensity, 900);
    assert.equal(light.userData.maxjsUserProps, full.userProps);
    assert.equal(light.userData.emitterClass, 'ir');
    assert.equal(light.userData.colorTemp, 2856);

    const partial = { ...full };
    delete partial.userProps;
    lights.applyLightData(light, partial, { partial: true });
    assert.equal(light.userData.maxjsUserProps, full.userProps);
    assert.equal(light.userData.emitterClass, 'ir');
    assert.equal(light.userData.colorTemp, 2856);

    lights.applyLightData(light, partial);
    assert.equal(light.userData.maxjsUserProps, undefined);
    assert.equal(light.userData.emitterClass, undefined);
    assert.equal(light.userData.colorTemp, undefined);
}

// Source invariant for the FX facade: a second identical enabled/options call
// reaches an equality guard instead of an unconditional rebuild.
{
    const source = readFileSync(new URL('../web/js/maxjs_fx.js', import.meta.url), 'utf8');
    const assignFinite = functionBody(source, 'function assignFinite(target, key, value)');
    assert.match(assignFinite, /Object\.is\s*\(\s*target\[key\],\s*value\s*\)/);
    assert.match(assignFinite, /return false/);
    assert.match(assignFinite, /return true/);

    for (const method of [
        'setSSGIOptions', 'setSSROptions', 'setGTAOOptions', 'setMotionBlurOptions',
        'setTRAAOptions', 'setBloomOptions', 'setToonOutlineOptions', 'setContactShadowOptions',
    ]) {
        const body = functionBody(source, `${method}(options = {})`);
        assert.match(body, /if\s*\(\s*(?:changed|rebuild)\s*\)\s*rebuildPipeline\s*\(\s*\)/,
            `${method} rebuild must be change-gated`);
        assert.doesNotMatch(body, /\n\s*rebuildPipeline\s*\(\s*\)\s*;\s*\n\s*return/,
            `${method} cannot rebuild unconditionally before return`);
    }

    for (const [method, statePath] of [
        ['setEnabled', 'state.ssgi.enabled'],
        ['setSSREnabled', 'state.ssr.enabled'],
        ['setGTAOEnabled', 'state.gtao.enabled'],
        ['setMotionBlurEnabled', 'state.motionBlur.enabled'],
        ['setTRAAEnabled', 'state.traa.enabled'],
        ['setBloomEnabled', 'state.bloom.enabled'],
        ['setToonOutlineEnabled', 'state.toonOutline.enabled'],
        ['setContactShadowEnabled', 'state.contactShadow.enabled'],
        ['setRetroEnabled', 'state.retro.enabled'],
        ['setPixelEnabled', 'state.pixel.enabled'],
        ['setPowerShotEnabled', 'state.powershot.enabled'],
        ['setDofEnabled', 'state.dof.enabled'],
        ['setVolumetricEnabled', 'state.volumetric.enabled'],
    ]) {
        const body = functionBody(source, `${method}(enabled)`);
        assert.match(body, new RegExp(`${statePath.replaceAll('.', '\\.')}\\s*===\\s*next`),
            `${method} must short-circuit an identical enabled value`);
    }
}

console.log('runtime vanilla first-wave smoke: PASS');

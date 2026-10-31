// light_probes.js - three.js irradiance probe grids, shared by the editor and snapshots.
//
// WebGPURenderer (WebGPU or its WebGL2 backend) bakes the node-based LightProbeGrid;
// the classic WebGLRenderer bakes LightProbeGridWebGL. Both are stock three.js
// lights: a baked grid in the scene lights every material inside its bounds.
//
// A bake renders into staging grids that stay out of the scene, a few probes per
// frame, and swaps them in once every bounce pass is done. The live grids are
// hidden during each capture so their previous result never feeds the new one.

import * as THREE from 'three';

export const LIGHT_PROBE_DEFAULTS = Object.freeze({
    intensity: 1,
    bounces: 2,
    cubemapSize: 16,
    density: 8,
    probesPerFrame: 32,
    showProbes: false,
    // GI lightmaps baked from the grids (lightmap_baker.js), node renderers only.
    lightmaps: false,
    lightmapResolution: 256,
});

const LIGHTMAP_SIZES = [64, 128, 256, 512, 1024];

export const LIGHT_PROBE_LIMITS = Object.freeze({
    intensity: [0, 8],
    bounces: [0, 4],
    density: [2, 24],
    probesPerFrame: [8, 512],
});

const CUBEMAP_SIZES = [8, 16, 32];
const MAX_AXIS_PROBES = 64;
const MAX_AUTO_PROBES = 4096;

function clampNumber(value, [min, max], fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export function normalizeLightProbeSettings(input = {}, base = LIGHT_PROBE_DEFAULTS) {
    const source = input && typeof input === 'object' ? input : {};
    const pick = (key) => source[key] ?? base[key];
    const cubemapSize = Math.round(Number(pick('cubemapSize')));
    return {
        intensity: clampNumber(pick('intensity'), LIGHT_PROBE_LIMITS.intensity, LIGHT_PROBE_DEFAULTS.intensity),
        bounces: Math.round(clampNumber(pick('bounces'), LIGHT_PROBE_LIMITS.bounces, LIGHT_PROBE_DEFAULTS.bounces)),
        cubemapSize: CUBEMAP_SIZES.includes(cubemapSize) ? cubemapSize : LIGHT_PROBE_DEFAULTS.cubemapSize,
        density: Math.round(clampNumber(pick('density'), LIGHT_PROBE_LIMITS.density, LIGHT_PROBE_DEFAULTS.density)),
        probesPerFrame: Math.round(clampNumber(pick('probesPerFrame'), LIGHT_PROBE_LIMITS.probesPerFrame, LIGHT_PROBE_DEFAULTS.probesPerFrame)),
        showProbes: pick('showProbes') === true,
        lightmaps: pick('lightmaps') === true,
        lightmapResolution: LIGHTMAP_SIZES.includes(Number(pick('lightmapResolution')))
            ? Number(pick('lightmapResolution'))
            : LIGHT_PROBE_DEFAULTS.lightmapResolution,
    };
}

// World-space volume of a Max probe grid helper. `size` and `divisions` are in the
// helper's local axes; the grid is axis aligned, so a rotated helper is lit by its
// world bounds, each world axis taking the divisions of the local axis closest to it.
const _corner = new THREE.Vector3();
const _axis = new THREE.Vector3();
export function volumeFromHelper(object, size, divisions) {
    object.updateWorldMatrix(true, false);
    const box = new THREE.Box3();
    for (let i = 0; i < 8; i++) {
        _corner.set(
            (i & 1 ? 0.5 : -0.5) * size[0],
            (i & 2 ? 0.5 : -0.5) * size[1],
            (i & 4 ? 0.5 : -0.5) * size[2],
        ).applyMatrix4(object.matrixWorld);
        box.expandByPoint(_corner);
    }
    const resolution = [2, 2, 2];
    const elements = object.matrixWorld.elements;
    for (let local = 0; local < 3; local++) {
        _axis.set(elements[local * 4], elements[local * 4 + 1], elements[local * 4 + 2]);
        const ax = Math.abs(_axis.x), ay = Math.abs(_axis.y), az = Math.abs(_axis.z);
        const world = ax >= ay && ax >= az ? 0 : (ay >= az ? 1 : 2);
        resolution[world] = divisions[local];
    }
    return {
        min: box.min.toArray(),
        max: box.max.toArray(),
        resolution: resolution.map((n) => THREE.MathUtils.clamp(Math.round(n) || 2, 1, MAX_AXIS_PROBES)),
    };
}

// Whole-scene volume with roughly `density` probes along the longest axis.
export function autoVolume(bounds, density) {
    const box = bounds.clone();
    const size = box.getSize(new THREE.Vector3());
    box.expandByScalar(Math.max(1, Math.max(size.x, size.y, size.z) * 0.04));
    box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z, 1e-3);
    let resolution = size.toArray().map((axis) => Math.max(2, Math.round(density * axis / maxDim)));
    const total = resolution[0] * resolution[1] * resolution[2];
    if (total > MAX_AUTO_PROBES) {
        const scale = Math.cbrt(MAX_AUTO_PROBES / total);
        resolution = resolution.map((n) => Math.max(2, Math.floor(n * scale)));
    }
    return { min: box.min.toArray(), max: box.max.toArray(), resolution };
}

function volumeKey(volume) {
    return [...volume.min, ...volume.max].map((v) => v.toFixed(3)).join(',') + '|' + volume.resolution.join('x');
}

// `getBakeBackground` returns what captures see as the sky when the viewport hides
// it; `wrapCapture(fn)` runs every capture batch (e.g. to hide a sun disc).
export function createLightProbeSystem({
    renderer,
    scene,
    getBakeBackground = () => null,
    wrapCapture = (fn) => fn(),
    onUpdated = () => {},
} = {}) {
    const useNodeGrid = renderer?.isWebGPURenderer === true;
    let modules = null;
    let modulesPromise = null;
    let settings = normalizeLightProbeSettings();
    let volumes = [];
    let layoutKey = '';
    let live = [];          // grids in the scene
    let staging = null;     // { grids, pass, start, gridIndex, dirtyDuringBake }
    let bakeRequested = false;
    let enabled = true;
    const helpers = new Map();

    function loadModules() {
        if (modules) return Promise.resolve(modules);
        modulesPromise ??= (useNodeGrid
            ? Promise.all([
                import('three/addons/lighting/LightProbeGrid.js'),
                import('three/addons/helpers/LightProbeGridHelper.js'),
            ]).then(([grid, helper]) => ({ Grid: grid.LightProbeGrid, Helper: helper.LightProbeGridHelper }))
            : Promise.all([
                import('three/addons/lighting/LightProbeGridWebGL.js'),
                import('three/addons/helpers/LightProbeGridHelperWebGL.js'),
            ]).then(([grid, helper]) => ({ Grid: grid.LightProbeGridWebGL, Helper: helper.LightProbeGridHelperWebGL })))
            .then((loaded) => (modules = loaded));
        return modulesPromise;
    }

    function createGrid(volume) {
        const min = new THREE.Vector3().fromArray(volume.min);
        const max = new THREE.Vector3().fromArray(volume.max);
        const size = max.clone().sub(min);
        const [nx, ny, nz] = volume.resolution;
        const grid = new modules.Grid(size.x, size.y, size.z, nx, ny, nz);
        grid.name = '__maxjs_light_probe_grid__';
        grid.position.copy(min).add(max).multiplyScalar(0.5);
        grid.updateMatrixWorld();
        grid.updateBoundingBox();
        grid.intensity = settings.intensity;
        grid.userData.maxjsExcludeFromRuntimeSnapshot = true;
        grid.userData.volumetricBoundsBypass = true;
        return grid;
    }

    function captureOptions(grid, sceneReach) {
        const size = new THREE.Vector3(grid.width, grid.height, grid.depth);
        const spacing = Math.min(size.x / grid.resolution.x, size.y / grid.resolution.y, size.z / grid.resolution.z);
        return {
            cubemapSize: settings.cubemapSize,
            near: Math.max(0.01, spacing * 0.01),
            far: Math.max(sceneReach * 2, size.length() * 2, 1),
        };
    }

    function probeCount(grid) {
        return grid.resolution.x * grid.resolution.y * grid.resolution.z;
    }

    function disposeGrids(grids) {
        for (const grid of grids) {
            grid.removeFromParent();
            grid.dispose();
        }
    }

    function updateHelpers() {
        for (const [grid, helper] of helpers) {
            if (live.includes(grid) && settings.showProbes) continue;
            helper.removeFromParent();
            helper.geometry.dispose();
            helper.material.dispose();
            helpers.delete(grid);
        }
        if (!settings.showProbes || !modules) return;
        for (const grid of live) {
            if (helpers.has(grid)) continue;
            const spacing = Math.min(grid.width / grid.resolution.x, grid.height / grid.resolution.y, grid.depth / grid.resolution.z);
            const helper = new modules.Helper(grid, spacing * 0.12);
            helper.name = '__maxjs_light_probe_helper__';
            helper.userData.maxjsExcludeFromRuntimeSnapshot = true;
            helper.visible = enabled;
            helper.update?.();
            scene.add(helper);
            helpers.set(grid, helper);
        }
    }

    function abortBake(error) {
        if (staging) disposeGrids(staging.grids);
        staging = null;
        bakeRequested = false;
        console.warn('max.js light probe bake failed:', error);
    }

    function publish(grids) {
        disposeGrids(live);
        live = grids;
        for (const grid of live) {
            grid.visible = enabled;
            scene.add(grid);
        }
        updateHelpers();
        onUpdated(live);
    }

    function startBake() {
        bakeRequested = false;
        if (!modules || volumes.length === 0) {
            if (staging) disposeGrids(staging.grids);
            staging = null;
            if (live.length && volumes.length === 0) publish([]);
            return;
        }
        if (staging) disposeGrids(staging.grids);
        scene.updateMatrixWorld(true);
        const sceneBox = new THREE.Box3().setFromObject(scene, false);
        const grids = volumes.map(createGrid);
        const reach = sceneBox.isEmpty() ? 0 : sceneBox.getSize(new THREE.Vector3()).length();
        staging = {
            grids,
            options: grids.map((grid) => captureOptions(grid, reach)),
            pass: 0,
            gridIndex: 0,
            start: 0,
        };
    }

    // Advances the staging bake by up to `probesPerFrame` probes. The bake swaps in
    // when the last bounce pass of the last grid finishes.
    function stepBake() {
        const job = staging;
        let budget = settings.probesPerFrame;
        const saved = {
            background: scene.background,
            rotation: scene.backgroundRotation.clone(),
            intensity: scene.backgroundIntensity,
            blurriness: scene.backgroundBlurriness,
        };
        const bakeBackground = getBakeBackground();
        const hidden = [];
        for (const object of [...live, ...helpers.values()]) {
            if (object.visible) { object.visible = false; hidden.push(object); }
        }
        if (bakeBackground) {
            scene.background = bakeBackground;
            scene.backgroundRotation.copy(scene.environmentRotation);
            scene.backgroundIntensity = scene.environmentIntensity;
            scene.backgroundBlurriness = 0;
        }
        try {
            wrapCapture(() => {
                while (budget > 0 && job.pass <= settings.bounces) {
                    const grid = job.grids[job.gridIndex];
                    const total = probeCount(grid);
                    const count = Math.min(budget, total - job.start);
                    // The grid being baked stays in the scene (the WebGL grid swaps its own
                    // atlas per pass); bounce passes also see the other grids' last pass.
                    const present = job.pass === 0 ? [grid] : job.grids;
                    for (const g of present) { g.visible = true; scene.add(g); }
                    try {
                        grid.bake(renderer, scene, { ...job.options[job.gridIndex], start: job.start, count, pass: job.pass });
                    } finally {
                        for (const g of present) g.removeFromParent();
                    }
                    budget -= count;
                    job.start += count;
                    if (job.start < total) continue;
                    job.start = 0;
                    job.gridIndex += 1;
                    if (job.gridIndex < job.grids.length) continue;
                    job.gridIndex = 0;
                    job.pass += 1;
                }
            });
        } finally {
            for (const object of hidden) object.visible = true;
            if (bakeBackground) {
                scene.background = saved.background;
                scene.backgroundRotation.copy(saved.rotation);
                scene.backgroundIntensity = saved.intensity;
                scene.backgroundBlurriness = saved.blurriness;
            }
        }
        if (job.pass > settings.bounces) {
            staging = null;
            publish(job.grids);
        }
    }

    return {
        get useNodeGrid() { return useNodeGrid; },
        get grids() { return live; },
        get baking() { return staging !== null || bakeRequested; },
        get settings() { return settings; },
        get volumes() { return volumes; },

        setSettings(next) {
            const previous = settings;
            settings = normalizeLightProbeSettings(next, settings);
            for (const grid of live) grid.intensity = settings.intensity;
            if (settings.bounces !== previous.bounces || settings.cubemapSize !== previous.cubemapSize) this.requestBake();
            if (settings.showProbes !== previous.showProbes) updateHelpers();
            return settings;
        },

        // Replaces the probe volumes ({ min, max, resolution } in world space).
        // An unchanged layout keeps the current grids.
        setVolumes(nextVolumes) {
            const next = (nextVolumes || []).filter((v) => v && v.min && v.max && v.resolution);
            const key = next.map(volumeKey).join(';');
            volumes = next;
            if (key === layoutKey) return false;
            layoutKey = key;
            this.requestBake();
            return true;
        },

        setEnabled(value) {
            enabled = value === true;
            for (const grid of live) grid.visible = enabled;
            for (const helper of helpers.values()) helper.visible = enabled;
        },

        requestBake() {
            bakeRequested = true;
            loadModules().catch((error) => console.warn('max.js light probes unavailable:', error));
        },

        // Call once per frame, before rendering. Bakes wait while probes are disabled.
        update() {
            if (!modules || !enabled) return;
            try {
                if (bakeRequested) startBake();
                if (staging) stepBake();
            } catch (error) {
                abortBake(error);
            }
        },

        // Runs a whole bake now (snapshot boot, render to image).
        async bakeNow() {
            await loadModules();
            try {
                startBake();
                while (staging) stepBake();
            } catch (error) {
                abortBake(error);
            }
        },

        dispose() {
            if (staging) disposeGrids(staging.grids);
            staging = null;
            settings = { ...settings, showProbes: false };
            disposeGrids(live);
            live = [];
            updateHelpers();
        },
    };
}

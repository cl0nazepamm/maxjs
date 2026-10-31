// speedball_probes.js - Speedball GI as the 'speedball' light probe mode, shared
// by the editor and snapshots.
//
// Speedball (speedball-gi) keeps a DDGI probe field traced against a BVH of the
// scene and adds its bounce to every lit material through MaxLightsNode
// (setProbeGiNode). Unlike the baked grids it follows scene, light and material
// changes live, finding them itself (autoDetectChanges). Probe misses stay
// black: the HDRI or sky keeps lighting materials as it does without probes.
// Needs a WebGPURenderer (WebGPU, or WebGL2 with float render targets).

import * as THREE from 'three';
import { installMaxLightsRenderer, setProbeGiNode } from './max_lights_node.js';
import { normalizeSpeedballSettings } from './light_probes.js';

const BLAS_CACHE_TRIANGLES = 4_000_000;
// Recreating the field (reflection quality is structural) keeps traced geometry.
let blasCache = null;

// Settings Speedball applies live; reflection quality needs a new field.
function applyTuning(field, s) {
    field.setIntensity(s.intensity);
    field.setDivisions(s.divisions);
    field.setAutoPadding(s.autoPadding);
    field.setRays(s.rays);
    field.setCascades(s.cascades);
    field.setContinuous(s.continuous);
    field.setJitterMode(s.jitterMode);
    field.setHysteresis(s.hysteresis);
    field.setHysteresisNormalization(s.hysteresisNormalize);
    field.setNormalBias(s.normalBias);
    field.setRadianceClamp(s.radianceClamp);
    field.setDepthSharpness(s.depthSharpness);
    field.setChebyStrength(s.cheby);
    field.setClassifyStrength(s.classify);
    field.setFilterStrength(s.filter);
    field.setSmoothness(s.smoothness);
    field.setNormalDetail(s.detail);
    field.setReflectionIntensity(s.reflectionIntensity);
    field.setChangeThreshold(s.changeThreshold);
    field.setSnapAmount(s.snapAmount);
    field.setFireflyClamp(s.fireflyClamp);
}

// The probe node joins compiled lighting graphs only on a recompile, and
// needsUpdate alone does not rebuild a node material's graph.
function markMaterialsDirty(scene) {
    const seen = new WeakSet();
    scene.traverse((object) => {
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
            if (!material || seen.has(material)) continue;
            seen.add(material);
            if (material.isMeshBasicMaterial || material.isLineBasicMaterial || material.isLineDashedMaterial) continue;
            material.dispose();
            material.needsUpdate = true;
        }
    });
}

// Light probe volumes ({ min, max, resolution }) as Speedball volumes; a volume
// without a resolution takes the field's divisions.
function toFieldVolumes(volumes) {
    return volumes.map((volume) => {
        const box = new THREE.Box3(new THREE.Vector3().fromArray(volume.min), new THREE.Vector3().fromArray(volume.max));
        const [x, y, z] = volume.resolution ?? [];
        return volume.resolution ? { box, res: { x, y, z } } : box;
    }).filter((entry) => !(entry.box ?? entry).isEmpty());
}

function volumesKey(volumes) {
    return volumes.map((v) => [...v.min, ...v.max].map((n) => Number(n).toFixed(3)).join(',') + '|' + (v.resolution?.join('x') ?? 'auto')).join(';');
}

// Resolves to null when the renderer cannot run Speedball.
export async function createSpeedballProbes({ renderer, scene, settings: initialSettings } = {}) {
    if (renderer?.isWebGPURenderer !== true || !installMaxLightsRenderer(renderer)) return null;
    const { createBlasCache, createProbeField } = await import('speedball-gi');
    blasCache ??= createBlasCache({ maxTriangles: BLAS_CACHE_TRIANGLES });

    let settings = normalizeSpeedballSettings(initialSettings);
    let volumes = [];
    let volumeKey = null;
    let enabled = false;
    let field = null;
    let warmupPasses = 0;
    let warmupTarget = 0;
    let tickPending = false;
    let tickFailureWarned = false;
    let lastInteraction = performance.now();
    const cameraPosition = new THREE.Vector3(Infinity, 0, 0);
    const cameraQuaternion = new THREE.Quaternion(2, 0, 0, 0);
    const worldPosition = new THREE.Vector3();
    const worldQuaternion = new THREE.Quaternion();
    const drawingSize = new THREE.Vector2();
    let drawingKey = '';

    function createField() {
        const next = createProbeField({
            renderer,
            scene,
            intensity: settings.intensity,
            hysteresis: settings.hysteresis,
            jitterMode: settings.jitterMode,
            divisions: settings.divisions,
            autoPadding: settings.autoPadding,
            rays: settings.rays,
            cascades: settings.cascades,
            continuous: settings.continuous,
            reflectionQuality: settings.reflectionQuality,
            reflectionIntensity: settings.reflectionIntensity,
            autoDetectChanges: true,
            blasCache,
            onRebuilt: () => markMaterialsDirty(scene),
        });
        applyTuning(next, settings);
        return next;
    }

    function applyVolumes() {
        const entries = toFieldVolumes(volumes);
        if (entries.length) field.setVolumes(entries);
        else field.setBounds(null);
    }

    // Each accepted solve blends (1 - hysteresis) into the probes, so a fresh
    // field ticks as if idle until it has converged to about 97%.
    function startWarmup() {
        warmupPasses = 0;
        warmupTarget = Math.max(settings.cascades + 1, Math.min(240, Math.ceil(Math.log(0.03) / Math.log(settings.hysteresis))));
    }

    function cameraMoved(camera) {
        if (!camera) return false;
        camera.getWorldPosition(worldPosition);
        camera.getWorldQuaternion(worldQuaternion);
        const moved = worldPosition.distanceToSquared(cameraPosition) > 1e-7
            || Math.abs(worldQuaternion.dot(cameraQuaternion)) < 0.99999995;
        cameraPosition.copy(worldPosition);
        cameraQuaternion.copy(worldQuaternion);
        return moved;
    }

    field = createField();
    if (!field.isSupported()) {
        field.dispose();
        return null;
    }
    setProbeGiNode(field.node);

    return {
        get field() { return field; },
        get enabled() { return enabled; },
        get settings() { return settings; },
        hasData: () => field.hasData(),
        getStats: () => field.getStats(),

        setSettings(next) {
            const previous = settings;
            settings = normalizeSpeedballSettings(next, settings);
            if (settings.reflectionQuality === previous.reflectionQuality) {
                applyTuning(field, settings);
                return settings;
            }
            field.dispose();
            field = createField();
            setProbeGiNode(field.node);
            volumeKey = null;
            this.setVolumes(volumes);
            if (enabled) {
                field.setEnabled(true);
                startWarmup();
            }
            markMaterialsDirty(scene);
            return settings;
        },

        // World volumes ({ min, max, resolution }); none fits the scene.
        setVolumes(next) {
            volumes = (next || []).filter((v) => v && v.min && v.max);
            const key = volumesKey(volumes);
            if (key === volumeKey) return false;
            volumeKey = key;
            applyVolumes();
            return true;
        },

        setEnabled(on) {
            const next = on === true;
            if (next === enabled) return;
            enabled = next;
            field.setEnabled(enabled);
            if (enabled) startWarmup();
            // Off drops the probe node from compiled graphs; on recompiles
            // once the first rebuild has data (onRebuilt).
            else markMaterialsDirty(scene);
        },

        // Re-traces the scene and converges again (e.g. after late textures).
        retrace() {
            field.markTopologyDirty();
            startWarmup();
        },

        // Once per frame before rendering. Solves wait while the camera moves
        // or the timeline plays, except while warming up.
        update({ camera = null, playing = false } = {}) {
            if (!enabled || tickPending) return;
            const now = performance.now();
            if (cameraMoved(camera)) lastInteraction = now;
            renderer.getDrawingBufferSize(drawingSize);
            const nextDrawingKey = `${drawingSize.x}x${drawingSize.y}`;
            if (drawingKey && nextDrawingKey !== drawingKey) field.resetFramePacing();
            drawingKey = nextDrawingKey;
            const warmingUp = warmupPasses < warmupTarget;
            tickPending = true;
            field.tick({
                idleMs: warmingUp ? Infinity : now - lastInteraction,
                playing: !warmingUp && playing === true,
            }).then(() => {
                tickFailureWarned = false;
                if (warmingUp && field.hasData()) warmupPasses += 1;
            }).catch((error) => {
                if (tickFailureWarned) return;
                tickFailureWarned = true;
                console.warn('max.js Speedball GI update failed:', error);
            }).finally(() => {
                tickPending = false;
            });
        },

        dispose() {
            setProbeGiNode(null);
            field.dispose();
            markMaterialsDirty(scene);
        },
    };
}

// Volumetric lighting. Verbatim move of the volumetric block from
// maxjs_fx.js rebuildPipeline() plus the volumetric mesh management that
// supported it. Per-controller state lives in ctx.shared.volumetric so the
// same module serves both the editor and the snapshot viewer.
import * as THREE from 'three';
import { pass, uniform, color, float, vec3, vec4, time, texture3D, Fn, screenCoordinate } from 'three/tsl';
import { gaussianBlur } from 'three/addons/tsl/display/GaussianBlurNode.js';
import { bayer16 } from 'three/addons/tsl/math/Bayer.js';
import { ImprovedNoise } from 'three/addons/math/ImprovedNoise.js';

const LAYER_VOL = 10;

function volState(ctx) {
    if (!ctx.shared.volumetric) {
        const layerMask = new THREE.Layers();
        layerMask.disableAll();
        layerMask.enable(LAYER_VOL);
        ctx.shared.volumetric = {
            layerMask,
            mesh: null,
            noiseTexture: null,
            lightsEnabled: [],
            densityU: uniform(0.5),
            intensityU: uniform(1.0),
            denoiseU: uniform(0.6),
            lightContribU: uniform(1.0),
        };
    }
    return ctx.shared.volumetric;
}

function getOrCreateVolNoise(v) {
    if (v.noiseTexture) return v.noiseTexture;
    const size = 64;
    const data = new Uint8Array(size * size * size);
    const noise = new ImprovedNoise();
    const scale = 5.0;
    for (let k = 0; k < size; k++)
        for (let j = 0; j < size; j++)
            for (let i = 0; i < size; i++)
                data[i + j * size + k * size * size] =
                    (noise.noise(i * scale / size, j * scale / size, k * scale / size) * 0.5 + 0.5) * 255;
    const tex = new THREE.Data3DTexture(data, size, size, size);
    tex.format = THREE.RedFormat;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
    tex.needsUpdate = true;
    v.noiseTexture = tex;
    return tex;
}

function ensureVolumetricMesh(ctx) {
    const v = volState(ctx);
    const noiseTex = getOrCreateVolNoise(v);
    v.densityU.value = ctx.state.volumetric.density;

    if (!v.mesh) {
        const volMat = new THREE.VolumeNodeMaterial();
        volMat.steps = ctx.state.volumetric.steps;
        // Volumetric light should respond only to explicit scene lights.
        // Letting scene.environment drive this material makes HDRI/env slot
        // changes wash out or override the intended volumetric contribution.
        volMat.envNode = color(0x000000);
        volMat.offsetNode = bayer16(screenCoordinate);
        volMat.scatteringNode = Fn(({ positionRay }) => {
            const t = vec3(time, float(0), time.mul(0.3));
            const sampleAt = (scale, timeScale) =>
                texture3D(noiseTex, positionRay.add(t.mul(timeScale)).mul(scale).mod(1), 0).r.add(0.5);
            let d = sampleAt(0.1, 1);
            d = d.mul(sampleAt(0.05, 1));
            d = d.mul(sampleAt(0.02, 2));
            return v.densityU.mix(float(1), d);
        });

        v.mesh = new THREE.Mesh(
            new THREE.BoxGeometry(1, 1, 1),
            volMat
        );
        v.mesh.userData.isVolume = true;
        v.mesh.layers.disableAll();
        v.mesh.layers.enable(LAYER_VOL);
        ctx.scene.add(v.mesh);
    } else {
        v.mesh.material.steps = ctx.state.volumetric.steps;
    }

    // Size to scene bounds
    const box = new THREE.Box3();
    ctx.scene.traverse(obj => {
        if (
            obj.isMesh
            && obj !== v.mesh
            && !obj.userData?.volumetricBoundsBypass
            && obj.visible
            && obj.geometry
        ) {
            const pos = obj.geometry.getAttribute?.('position');
            if (pos && pos.count > 0) box.expandByObject(obj);
        }
    });
    if (!box.isEmpty()) {
        const center = box.getCenter(new THREE.Vector3());
        const sz = box.getSize(new THREE.Vector3());
        const pad = 2.0;
        v.mesh.position.copy(center);
        v.mesh.scale.set(
            Math.max(sz.x * pad, 1),
            Math.max(sz.y * pad, 1),
            Math.max(sz.z * pad, 1)
        );
    } else {
        v.mesh.position.set(0, 0, 0);
        v.mesh.scale.set(500, 500, 500);
    }
    v.mesh.visible = true;

    syncVolumetricLightLayers(ctx);
}

/** Max light volContrib edits do not rebuild the post pipeline; re-apply light.layers every frame. */
function syncVolumetricLightLayers(ctx) {
    const v = volState(ctx);
    disableVolLights(v);
    let contribSum = 0;
    let contribCount = 0;
    ctx.scene.traverse(obj => {
        if (!obj.isLight) return;
        if (obj.userData?.volumetricBypass) return;
        const vc = obj.userData?.volContrib;
        if (vc !== undefined && vc <= 0) return;
        obj.layers.enable(LAYER_VOL);
        v.lightsEnabled.push(obj);
        const val = (vc !== undefined && Number.isFinite(vc)) ? Math.max(0, vc) : 1.0;
        contribSum += val;
        contribCount++;
    });
    // Average per-light volContrib as linear output multiplier — gives smooth
    // 0-1 control instead of the near-binary response from scaling light
    // intensity before Beer's law exponential.
    v.lightContribU.value = contribCount > 0 ? contribSum / contribCount : 1.0;
}

function disableVolLights(v) {
    for (const light of v.lightsEnabled) {
        if (light.layers) light.layers.disable(LAYER_VOL);
    }
    v.lightsEnabled = [];
}

/** Live-update the volumetric uniforms without a pipeline rebuild. */
export function syncVolumetricUniforms(ctx) {
    const v = ctx.shared.volumetric;
    if (!v) return;
    v.densityU.value = ctx.state.volumetric.density;
    v.intensityU.value = ctx.state.volumetric.intensity;
    v.denoiseU.value = ctx.state.volumetric.denoise;
}

/** Push a steps change into the live volumetric material. */
export function applyVolumetricSteps(ctx) {
    const v = ctx.shared.volumetric;
    if (!v?.mesh) return;
    v.mesh.material.steps = ctx.state.volumetric.steps;
    v.mesh.material.needsUpdate = true;
}

export default {
    id: 'volumetric',
    stage: 'beauty',
    slot: 80,
    needs: [],
    defaults: {
        enabled: false,
        intensity: 1.0,
        steps: 12,
        density: 0.5,
        denoise: 0.6,
        resolution: 0.25,
    },
    build(ctx) {
        const v = volState(ctx);
        try {
            ensureVolumetricMesh(ctx);
            v.densityU.value = ctx.state.volumetric.density;
            v.intensityU.value = ctx.state.volumetric.intensity;
            v.denoiseU.value = ctx.state.volumetric.denoise;

            const volPass = pass(ctx.scene, ctx.camera, { depthBuffer: false });
            volPass.setLayers(v.layerMask);
            ctx.applyNodeResolutionScale(volPass, ctx.state.volumetric.resolution);
            ctx.pushNode(volPass);

            const blurredVol = gaussianBlur(volPass, v.denoiseU);
            ctx.pushNode(blurredVol);

            const volResult = blurredVol.mul(v.intensityU).mul(v.lightContribU);
            const volLuma = volResult.r.mul(0.2126).add(volResult.g.mul(0.7152)).add(volResult.b.mul(0.0722));
            return vec4(ctx.beauty.rgb.add(volResult.rgb), ctx.raiseBeautyAlpha(volLuma));
        } catch (e) {
            console.warn('Volumetric pass failed:', e);
            this.deactivate(ctx);
            return null;
        }
    },
    update(ctx) {
        syncVolumetricLightLayers(ctx);
    },
    deactivate(ctx) {
        const v = ctx.shared.volumetric;
        if (!v) return;
        if (v.mesh) v.mesh.visible = false;
        disableVolLights(v);
    },
};

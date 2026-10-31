// nir_band_view.js - three-band NIR rendering while PowerShot's imager senses NIR.
//
// PowerShot's NIR band model (powershot-threejs/infrared createNirBand) wants
// the scene in three NIR bands instead of RGB: node materials show their band
// reflectance (per texel, through the band LUT), emission and unlit colours
// become band radiance, lights take their band spectra every frame, and HDRI
// light and the background go through the same conversion. The imager then
// collapses the bands (InfraredPipeline.setNirBands). A material's NIR level
// comes from userData.nirAlbedo (Max or ctx.spectral tags), else classifyNir,
// else the JH extrapolation of its colour; a TSL material may give per-pixel
// levels as userData.maxjsNirColorNode (reflectance) and maxjsNirEmissiveNode
// (emission). Node renderers only; probe GI baked in visible light is the
// caller's to suspend (onActiveChange).

import * as THREE from 'three';
import {
    luminance, materialColor, materialEmissive, mix, pmremTexture, screenUV, texture, uniform, vec3, vec4,
} from 'three/tsl';
import { classifyNir, createNirBand } from 'powershot-threejs/infrared';
import { isIrEmitter } from './ir_emitters.js';
import { setEnvironmentLightTransform } from './environment_lighting.js';

const WHITE = new THREE.Color(1, 1, 1);
const NO_USER_DATA = Object.freeze({});
const num = (value, fallback) => (Number.isFinite(value) ? value : fallback);

function materialsOf(object) {
    const material = object.material;
    return Array.isArray(material) ? material : (material ? [material] : []);
}

function convertible(material) {
    return material?.isNodeMaterial === true
        && material.isVolumeNodeMaterial !== true
        && material.isShadowNodeMaterial !== true;
}

function isEquirectOrCube(texture) {
    return texture.isCubeTexture === true
        || texture.mapping === THREE.EquirectangularReflectionMapping
        || texture.mapping === THREE.EquirectangularRefractionMapping;
}

export function createNirBandView({ scene, onActiveChange = () => {} }) {
    let band = null;
    let nodes = null;
    let loading = null;
    let wanted = false;
    let active = false;
    const materials = new Map();       // material -> conversion state
    const lightBands = new WeakMap();  // light -> { key, bands, groundKey, groundBands }
    const restores = [];               // per-frame colour/intensity restores
    let background = null;             // { original, source, blurriness, node }

    function emits(material, state) {
        const e = material.emissive;
        return state.emissiveNode != null || material.emissiveMap != null || state.authoredEmissive != null
            || (e?.isColor === true && (e.r > 0 || e.g > 0 || e.b > 0));
    }

    // An authored per-pixel NIR level takes over past the red edge.
    const withAuthoredLevel = (bands, authored) => (authored == null
        ? bands
        : mix(bands, vec3(luminance(vec3(authored))), vec3(...band.redEdge)));

    function bandColorNode(material, state) {
        const visible = vec4(state.colorNode ?? materialColor);
        let bands;
        if (material.lights !== true) {
            bands = nodes.emission(visible.rgb);
        } else if (state.authored != null) {
            bands = withAuthoredLevel(nodes.reflectance(visible.rgb), state.authored);
        } else {
            bands = nodes.tagged(visible.rgb, state.nirAlbedo, state.flat);
        }
        return vec4(bands, visible.a);
    }

    // Puts the band nodes on a material, or rebuilds them when the app replaced
    // a node (the replacement is the new visible source) or its emission or
    // authored NIR node changed. Cheap when nothing changed.
    function convert(material) {
        let state = materials.get(material);
        if (state
            && material.colorNode === state.bandColor
            && material.emissiveNode === state.bandEmissive
            && material.userData?.maxjsNirColorNode === state.authored
            && material.userData?.maxjsNirEmissiveNode === state.authoredEmissive
            && emits(material, state) === state.emissive) return state;
        if (!state) {
            state = {
                colorNode: material.colorNode,
                emissiveNode: material.emissiveNode,
                nirAlbedo: uniform(-1),
                flat: uniform(new THREE.Vector3(1, 1, 1)),
                flatKey: '',
                tagKey: '',
            };
            materials.set(material, state);
        } else {
            if (material.colorNode !== state.bandColor) state.colorNode = material.colorNode;
            if (material.emissiveNode !== state.bandEmissive) state.emissiveNode = material.emissiveNode;
        }
        state.authored = material.userData?.maxjsNirColorNode;
        state.authoredEmissive = material.userData?.maxjsNirEmissiveNode;
        state.emissive = emits(material, state);
        state.bandColor = bandColorNode(material, state);
        state.bandEmissive = material.lights === true && state.emissive
            ? withAuthoredLevel(nodes.emission(vec3(state.emissiveNode ?? materialEmissive)), state.authoredEmissive)
            : state.emissiveNode;
        material.colorNode = state.bandColor;
        material.emissiveNode = state.bandEmissive;
        material.needsUpdate = true;
        return state;
    }

    function restore(material, state) {
        // A node the app set while the view was active stays.
        if (material.colorNode === state.bandColor) material.colorNode = state.colorNode;
        if (material.emissiveNode === state.bandEmissive) material.emissiveNode = state.emissiveNode;
        material.needsUpdate = true;
    }

    // NIR level and the map-free colour's bands, recomputed only on change.
    function updateTags(material, state) {
        const c = material.color?.isColor ? material.color : WHITE;
        const flatKey = `${c.r},${c.g},${c.b}`;
        if (flatKey !== state.flatKey) {
            state.flatKey = flatKey;
            state.flat.value.set(...band.colorBands(c.r, c.g, c.b));
        }
        const tag = material.userData?.nirAlbedo;
        if (Number.isFinite(tag)) {
            state.nirAlbedo.value = Math.max(0, tag);
            state.tagKey = '';
            return;
        }
        const roughness = num(material.roughness, 1);
        const metalness = num(material.metalness, 0);
        const transmission = num(material.transmission, 0);
        const tagKey = `${material.name}|${flatKey}|${roughness}|${metalness}|${transmission}`;
        if (tagKey !== state.tagKey) {
            state.tagKey = tagKey;
            state.nirAlbedo.value = classifyNir(material.name, c.r, c.g, c.b, roughness, metalness, transmission);
        }
    }

    function bandsFor(cache, keyName, bandsName, source) {
        const c = source.color;
        const key = `${c.r},${c.g},${c.b},${source.intensity},${source.userData?.emitterClass},${source.userData?.colorTemp}`;
        if (cache[keyName] !== key) {
            cache[keyName] = key;
            cache[bandsName] = band.lightBands(source);
        }
        return cache[bandsName];
    }

    function swapLight(light) {
        if (light.isLightProbe === true || light.isLightProbeGrid === true) return;
        let cache = lightBands.get(light);
        if (!cache) lightBands.set(light, cache = {});
        // The IR gate (ir_emitters.js) writes an illuminator's sensed gain into
        // its colour; the band model takes it as radiance on the 850 nm line.
        const source = isIrEmitter(light)
            ? { color: WHITE, intensity: light.intensity * light.color.r, userData: light.userData }
            : light;
        const bands = bandsFor(cache, 'key', 'bands', source);
        const peak = Math.max(bands[0], bands[1], bands[2]);
        restores.push({ target: light.color, r: light.color.r, g: light.color.g, b: light.color.b });
        restores.push({ light, intensity: light.intensity });
        if (light.isHemisphereLight === true) {
            const ground = light.groundColor;
            restores.push({ target: ground, r: ground.r, g: ground.g, b: ground.b });
            const gb = bandsFor(cache, 'groundKey', 'groundBands', { color: ground, intensity: light.intensity, userData: NO_USER_DATA });
            if (peak > 0) ground.setRGB(gb[0] / peak, gb[1] / peak, gb[2] / peak);
            else ground.setRGB(0, 0, 0);
        }
        if (peak > 0) {
            light.color.setRGB(bands[0] / peak, bands[1] / peak, bands[2] / peak);
            light.intensity = peak;
        } else {
            light.color.setRGB(0, 0, 0);
        }
    }

    function swapColor(color) {
        if (color?.isColor !== true) return;
        restores.push({ target: color, r: color.r, g: color.g, b: color.b });
        const bands = band.lightBands({ color, intensity: 1, userData: NO_USER_DATA });
        color.setRGB(bands[0], bands[1], bands[2]);
    }

    // A texture background or an app backgroundNode renders through a band
    // emission node; rebuilt when its source changes.
    function syncBackgroundNode() {
        const current = scene.backgroundNode;
        if (background
            && current === background.node
            && scene.background === background.source
            && scene.backgroundBlurriness === background.blurriness) return;
        if (background && current === background.node) scene.backgroundNode = background.original;
        const original = scene.backgroundNode ?? null;
        const bg = scene.background;
        let source = null;
        if (original?.isNode === true) source = original;
        else if (bg?.isTexture === true) source = isEquirectOrCube(bg) ? pmremTexture(bg) : texture(bg, screenUV.flipY());
        background = source
            ? { original, source: bg, blurriness: scene.backgroundBlurriness, node: vec4(nodes.emission(vec4(source).rgb), 1) }
            : null;
        if (background) scene.backgroundNode = background.node;
    }

    function enable() {
        active = true;
        setEnvironmentLightTransform(nodes.emission);
        scene.traverse((object) => {
            for (const material of materialsOf(object)) if (convertible(material)) convert(material);
        });
        onActiveChange(true);
    }

    function disable() {
        active = false;
        setEnvironmentLightTransform(null);
        for (const [material, state] of materials) restore(material, state);
        materials.clear();
        if (background && scene.backgroundNode === background.node) scene.backgroundNode = background.original;
        background = null;
        onActiveChange(false);
    }

    return {
        get active() { return active; },

        // Follow the imager's NIR sensing; the first activation loads the
        // band model (JH LUT + band LUT) before the scene switches.
        setActive(on) {
            wanted = on === true;
            if (wanted === active) return;
            if (!wanted) {
                disable();
                return;
            }
            if (nodes) {
                enable();
                return;
            }
            loading ??= createNirBand().then((created) => {
                band = created;
                nodes = band.createRasterNodes();
            });
            loading.then(() => { if (wanted && !active) enable(); })
                .catch((error) => console.warn('max.js NIR bands unavailable:', error));
        },

        // Around each frame's draw: materials added since the last frame
        // convert, tags refresh, and lights, background and fog colours swap to
        // their bands until afterRender.
        beforeRender() {
            if (!active) return;
            scene.traverse((object) => {
                if (object.isLight === true) {
                    swapLight(object);
                    return;
                }
                for (const material of materialsOf(object)) {
                    if (!convertible(material)) continue;
                    const state = convert(material);
                    if (material.lights === true) updateTags(material, state);
                }
            });
            syncBackgroundNode();
            swapColor(scene.background);
            swapColor(scene.fog?.color);
        },

        afterRender() {
            for (let i = restores.length - 1; i >= 0; i -= 1) {
                const entry = restores[i];
                if (entry.light) entry.light.intensity = entry.intensity;
                else entry.target.setRGB(entry.r, entry.g, entry.b);
            }
            restores.length = 0;
        },

        dispose() {
            if (active) disable();
            wanted = false;
            nodes?.dispose();
            nodes = null;
            band = null;
            loading = null;
        },
    };
}

// MaxLightsNode — DynamicLightsNode + per-mesh 64-bit light-link masks.
//
// Only lights with userData.maxjsLightLinked === true use the masked path.
// Unlinked lights stay on stock DynamicLightsNode data nodes, which keeps
// Studio mode close to Standard mode unless light links are actually active.
//
// Linked lights use a stable lightId (0..63) in userData. Each mesh carries
// two uint32 userData values (maxjsLightMaskLo / maxjsLightMaskHi) read
// in-shader via TSL's `userData()` reference node. The mask is per-mesh at
// render time, not per-material.
//
// Batched masked types: Directional, Point, Spot, Hemisphere. Ambient is
// summed into a single irradiance and cannot be per-mesh masked. Lights that
// can't batch — shadow-casters, projected/textured spots, area lights — take
// LightsNode's per-light fallback path; for those the same per-mesh mask is
// applied in setupDirectLight()/setupDirectRectAreaLight() (see maskFactorForLight),
// so linking works uniformly across every light type, not just the batched ones.

import DynamicLightsNode from 'three/addons/tsl/lighting/DynamicLightsNode.js';
import DirectionalLightDataNode from 'three/addons/tsl/lighting/data/DirectionalLightDataNode.js';
import PointLightDataNode from 'three/addons/tsl/lighting/data/PointLightDataNode.js';
import SpotLightDataNode from 'three/addons/tsl/lighting/data/SpotLightDataNode.js';
import HemisphereLightDataNode from 'three/addons/tsl/lighting/data/HemisphereLightDataNode.js';
import AmbientLightDataNode from 'three/addons/tsl/lighting/data/AmbientLightDataNode.js';
import { NodeUtils } from 'three/webgpu';
import { getReflectionPaintNode } from './reflection_paint.js';
import { getGiVolumeNode } from './gi_irradiance_volume.js';
import { getGiProbeNode } from './gi_probes.js';
import {
    If, Loop, getDistanceAttenuation, mix, normalWorld, positionView, renderGroup,
    select, smoothstep, uniformArray, vec3, uint, int, float,
    bitAnd, shiftLeft, nodeObject, or, not, userData,
} from 'three/tsl';

export const LIGHT_MASK_LO_KEY = 'maxjsLightMaskLo';
export const LIGHT_MASK_HI_KEY = 'maxjsLightMaskHi';
const UNLINKED_ID = -1;

export function ensureMeshMaskDefaults(mesh) {
    if (!mesh) return;
    mesh.userData ??= {};
    if (typeof mesh.userData[LIGHT_MASK_LO_KEY] !== 'number') {
        mesh.userData[LIGHT_MASK_LO_KEY] = 0xFFFFFFFF;
    }
    if (typeof mesh.userData[LIGHT_MASK_HI_KEY] !== 'number') {
        mesh.userData[LIGHT_MASK_HI_KEY] = 0xFFFFFFFF;
    }
}

// TSL: true if the light contributes. Unlinked lights (id === -1) always
// contribute; linked lights check their bit in the per-mesh mask. The mask
// nodes are passed in so each data-node setup() generates a fresh
// UserDataNode — prevents cross-material aliasing from module-level sharing.
function maskContributes(lightIdNode, maskLoNode, maskHiNode) {
    const id = int(lightIdNode);
    const isLinked = id.greaterThanEqual(int(0));
    const useHi = id.greaterThanEqual(int(32));
    const bitPos = uint(id).bitAnd(uint(31));
    const bit = shiftLeft(uint(1), bitPos);
    const word = select(useHi, maskHiNode, maskLoNode);
    const maskHit = bitAnd(word, bit).notEqual(uint(0));
    return or(not(isLinked), maskHit);
}

function createMaskNodes() {
    return {
        loNode: userData(LIGHT_MASK_LO_KEY, 'uint'),
        hiNode: userData(LIGHT_MASK_HI_KEY, 'uint'),
    };
}

function writeIds(target, lights, maxCount) {
    const count = Math.min(lights.length, maxCount);
    for (let i = 0; i < count; i++) {
        const id = lights[i]?.userData?.maxjsLightId;
        target[i] = Number.isInteger(id) && id >= 0 && id < 64 ? id : UNLINKED_ID;
    }
}

// ── Directional ─────────────────────────────────────────
class MaskedDirectionalLightDataNode extends DirectionalLightDataNode {
    constructor(maxCount = 16) {
        super(maxCount);
        this._ids = new Array(maxCount).fill(UNLINKED_ID);
        this.idsNode = uniformArray(this._ids, 'int').setGroup(renderGroup);
    }
    update(context) {
        super.update(context);
        writeIds(this._ids, this._lights, this.maxCount);
    }
    setup(builder) {
        const { loNode, hiNode } = createMaskNodes();
        const { lightingModel, reflectedLight } = builder.context;
        const dynDiffuse = vec3(0).toVar('maxjsDirDiffuse');
        const dynSpecular = vec3(0).toVar('maxjsDirSpecular');
        Loop(this.countNode, ({ i }) => {
            const lightId = this.idsNode.element(i);
            If(maskContributes(lightId, loNode, hiNode), () => {
                const lightColor = this.colorsNode.element(i).toVar();
                const lightDirection = this.directionsNode.element(i).normalize().toVar();
                lightingModel.direct({
                    lightDirection,
                    lightColor,
                    lightNode: { light: {}, shadowNode: null },
                    reflectedLight: { directDiffuse: dynDiffuse, directSpecular: dynSpecular },
                }, builder);
            });
        });
        reflectedLight.directDiffuse.addAssign(dynDiffuse);
        reflectedLight.directSpecular.addAssign(dynSpecular);
    }
}

// ── Point ───────────────────────────────────────────────
class MaskedPointLightDataNode extends PointLightDataNode {
    constructor(maxCount = 32) {
        super(maxCount);
        this._ids = new Array(maxCount).fill(UNLINKED_ID);
        this.idsNode = uniformArray(this._ids, 'int').setGroup(renderGroup);
    }
    update(context) {
        super.update(context);
        writeIds(this._ids, this._lights, this.maxCount);
    }
    setup(builder) {
        const { loNode, hiNode } = createMaskNodes();
        const surfacePosition = builder.context.positionView || positionView;
        const { lightingModel, reflectedLight } = builder.context;
        const dynDiffuse = vec3(0).toVar('maxjsPointDiffuse');
        const dynSpecular = vec3(0).toVar('maxjsPointSpecular');
        Loop(this.countNode, ({ i }) => {
            const lightId = this.idsNode.element(i);
            If(maskContributes(lightId, loNode, hiNode), () => {
                const positionAndCutoff = this.positionsAndCutoffNode.element(i);
                const lightViewPosition = positionAndCutoff.xyz;
                const cutoffDistance = positionAndCutoff.w;
                const decayExponent = this.decaysNode.element(i).x;
                const lightVector = lightViewPosition.sub(surfacePosition).toVar();
                const lightDirection = lightVector.normalize().toVar();
                const lightDistance = lightVector.length();
                const attenuation = getDistanceAttenuation({ lightDistance, cutoffDistance, decayExponent });
                const lightColor = this.colorsNode.element(i).mul(attenuation).toVar();
                lightingModel.direct({
                    lightDirection,
                    lightColor,
                    lightNode: { light: {}, shadowNode: null },
                    reflectedLight: { directDiffuse: dynDiffuse, directSpecular: dynSpecular },
                }, builder);
            });
        });
        reflectedLight.directDiffuse.addAssign(dynDiffuse);
        reflectedLight.directSpecular.addAssign(dynSpecular);
    }
}

// ── Spot ────────────────────────────────────────────────
class MaskedSpotLightDataNode extends SpotLightDataNode {
    constructor(maxCount = 32) {
        super(maxCount);
        this._ids = new Array(maxCount).fill(UNLINKED_ID);
        this.idsNode = uniformArray(this._ids, 'int').setGroup(renderGroup);
    }
    update(context) {
        super.update(context);
        writeIds(this._ids, this._lights, this.maxCount);
    }
    setup(builder) {
        const { loNode, hiNode } = createMaskNodes();
        const surfacePosition = builder.context.positionView || positionView;
        const { lightingModel, reflectedLight } = builder.context;
        const dynDiffuse = vec3(0).toVar('maxjsSpotDiffuse');
        const dynSpecular = vec3(0).toVar('maxjsSpotSpecular');
        Loop(this.countNode, ({ i }) => {
            const lightId = this.idsNode.element(i);
            If(maskContributes(lightId, loNode, hiNode), () => {
                const positionAndCutoff = this.positionsAndCutoffNode.element(i);
                const lightViewPosition = positionAndCutoff.xyz;
                const cutoffDistance = positionAndCutoff.w;
                const directionAndDecay = this.directionsAndDecayNode.element(i);
                const spotDirection = directionAndDecay.xyz;
                const decayExponent = directionAndDecay.w;
                const cone = this.conesNode.element(i);
                const coneCos = cone.x;
                const penumbraCos = cone.y;
                const lightVector = lightViewPosition.sub(surfacePosition).toVar();
                const lightDirection = lightVector.normalize().toVar();
                const lightDistance = lightVector.length();
                const angleCos = lightDirection.dot(spotDirection);
                const spotAttenuation = smoothstep(coneCos, penumbraCos, angleCos);
                const distanceAttenuation = getDistanceAttenuation({ lightDistance, cutoffDistance, decayExponent });
                const lightColor = this.colorsNode.element(i).mul(spotAttenuation).mul(distanceAttenuation).toVar();
                lightingModel.direct({
                    lightDirection,
                    lightColor,
                    lightNode: { light: {}, shadowNode: null },
                    reflectedLight: { directDiffuse: dynDiffuse, directSpecular: dynSpecular },
                }, builder);
            });
        });
        reflectedLight.directDiffuse.addAssign(dynDiffuse);
        reflectedLight.directSpecular.addAssign(dynSpecular);
    }
}

// ── Hemisphere ──────────────────────────────────────────
class MaskedHemisphereLightDataNode extends HemisphereLightDataNode {
    constructor(maxCount = 4) {
        super(maxCount);
        this._ids = new Array(maxCount).fill(UNLINKED_ID);
        this.idsNode = uniformArray(this._ids, 'int').setGroup(renderGroup);
    }
    update(context) {
        super.update(context);
        writeIds(this._ids, this._lights, this.maxCount);
    }
    setup(builder) {
        const { loNode, hiNode } = createMaskNodes();
        Loop(this.countNode, ({ i }) => {
            const lightId = this.idsNode.element(i);
            If(maskContributes(lightId, loNode, hiNode), () => {
                const skyColor = this.skyColorsNode.element(i);
                const groundColor = this.groundColorsNode.element(i);
                const lightDirection = this.directionsNode.element(i);
                const hemiDiffuseWeight = normalWorld.dot(lightDirection).mul(0.5).add(0.5);
                const irradiance = mix(groundColor, skyColor, hemiDiffuseWeight);
                builder.context.irradiance.addAssign(irradiance);
            });
        });
    }
}

// ── Top-level MaxLightsNode ─────────────────────────────
const MAX_TO_PROP = {
    DirectionalLight: 'maxDirectionalLights',
    PointLight: 'maxPointLights',
    SpotLight: 'maxSpotLights',
    HemisphereLight: 'maxHemisphereLights',
};

const STOCK_DATA_CLASSES = {
    AmbientLight: AmbientLightDataNode,
    DirectionalLight: DirectionalLightDataNode,
    PointLight: PointLightDataNode,
    SpotLight: SpotLightDataNode,
    HemisphereLight: HemisphereLightDataNode,
};

const MASKED_DATA_CLASSES = {
    DirectionalLight: MaskedDirectionalLightDataNode,
    PointLight: MaskedPointLightDataNode,
    SpotLight: MaskedSpotLightDataNode,
    HemisphereLight: MaskedHemisphereLightDataNode,
};

const isSpecialSpotLight = (light) =>
    light.isSpotLight === true && (light.map !== null || light.colorNode !== undefined);

const isLinkedLight = (light) => light?.userData?.maxjsLightLinked === true;

// Per-mesh mask factor (1.0 = lit, 0.0 = masked out) for one linked light on the
// FALLBACK path — shadow-casters, projected/textured spots and area lights, which
// can't batch and so render through stock three.js LightNodes the Masked*DataNode
// path never sees. The light's id is a compile-time constant for its dedicated
// LightNode, so the bit shift bakes into the program; only the 32-bit mask word is
// read per-mesh via userData(). Returns null for unlinked lights (no mask, no cost).
function maskFactorForLight(light) {
    const id = light?.userData?.maxjsLightId;
    if (!isLinkedLight(light) || !Number.isInteger(id) || id < 0 || id >= 64) return null;
    const word = userData(id < 32 ? LIGHT_MASK_LO_KEY : LIGHT_MASK_HI_KEY, 'uint');
    const bit = shiftLeft(uint(1), uint(id & 31));
    const contributes = bitAnd(word, bit).notEqual(uint(0));
    return select(contributes, float(1.0), float(0.0));
}

// three.js r184 NodeMaterial.setupLights() spawns a fresh lightsNode via the factory
// every time a material with an env LightingNode compiles (scene.environmentNode set).
// Each instance owns its own _dataNodes → separate UBOs → per-frame setLights() from
// renderList.finish() only reaches the scene-cached instance, leaving material-owned
// ones frozen. Sharing _dataNodes gives every material the same UBO per light type.
const SHARED_STOCK_DATA_NODES = new Map();
const SHARED_MASKED_DATA_NODES = new Map();
const FALLBACK_LIGHT_NODE_REF = new WeakMap();
const HASH_DATA = [];

function getOrCreateFallbackLightNode(light, nodeLibrary) {
    const LightNodeClass = nodeLibrary.getLightNodeClass(light.constructor);
    if (!LightNodeClass) return null;
    let lightNode = FALLBACK_LIGHT_NODE_REF.get(light);
    if (!lightNode) {
        lightNode = new LightNodeClass(light);
        FALLBACK_LIGHT_NODE_REF.set(light, lightNode);
    }
    return lightNode;
}

export default class MaxLightsNode extends DynamicLightsNode {
    static get type() { return 'MaxLightsNode'; }

    constructor(options = {}) {
        super(options);
        // Keep DynamicLightsNode's own map empty and drive the shared maps
        // ourselves; parent grouping cannot distinguish linked vs unlinked.
        this._dataNodes = new Map();
        this._stockDataNodes = SHARED_STOCK_DATA_NODES;
        this._maskedDataNodes = SHARED_MASKED_DATA_NODES;
    }

    get _typeMap() {
        return STOCK_DATA_CLASSES;
    }

    _canBatch(light) {
        return light.isNode !== true
            && light.castShadow !== true
            && !isSpecialSpotLight(light)
            && STOCK_DATA_CLASSES[light.constructor.name] !== undefined;
    }

    customCacheKey() {
        const typeSet = new Set();
        for (const light of this._lights) {
            if (this._canBatch(light)) {
                const canMask = MASKED_DATA_CLASSES[light.constructor.name] !== undefined;
                typeSet.add(`${isLinkedLight(light) && canMask ? 'masked' : 'stock'}:${light.constructor.name}`);
                continue;
            }
            HASH_DATA.push(light.id);
            HASH_DATA.push(light.castShadow ? 1 : 0);
            // Linked state + id gate the fallback mask multiply (setupDirectLight).
            // A linked↔unlinked flip or an id reassignment must rebuild the program
            // since the bit shift is baked in at compile time. 0 = unlinked.
            HASH_DATA.push(isLinkedLight(light) ? ((light.userData?.maxjsLightId ?? -1) + 1) : 0);
            if (light.isSpotLight === true) {
                HASH_DATA.push(light.map !== null ? light.map.id : -1);
                HASH_DATA.push(light.colorNode ? light.colorNode.getCacheKey() : -1);
            }
        }
        if (getReflectionPaintNode().active) typeSet.add('reflection-paint-global');
        // GI irradiance volume: token carries a generation so enable/disable and
        // grid-resize recompile, but data-only surfel-buffer writes share the same
        // program.
        if (getGiVolumeNode().active) typeSet.add(getGiVolumeNode().cacheToken);
        // HALO-GI probe field: token bumps ONLY on grid resize / enable, never on
        // per-tick atlas writes (the atlas is a stable sampled binding) — so probe
        // updates never recompile materials. This is the churn-free contract.
        if (getGiProbeNode().active) typeSet.add(getGiProbeNode().cacheToken);
        for (const token of [...typeSet].sort()) HASH_DATA.push(NodeUtils.hashString(token));
        const key = NodeUtils.hashArray(HASH_DATA);
        HASH_DATA.length = 0;
        return key;
    }

    _groupBatchableLights(lights) {
        const stock = new Map();
        const masked = new Map();
        for (const light of lights) {
            if (!this._canBatch(light)) continue;
            const typeName = light.constructor.name;
            const target = isLinkedLight(light) && MASKED_DATA_CLASSES[typeName] !== undefined ? masked : stock;
            const list = target.get(typeName);
            if (list) list.push(light); else target.set(typeName, [light]);
        }
        return { stock, masked };
    }

    _getOrCreateDataNode(map, typeName, DataNodeClass) {
        let dataNode = map.get(typeName);
        if (dataNode === undefined) {
            const maxProp = MAX_TO_PROP[typeName];
            const maxCount = maxProp ? this[maxProp] : undefined;
            dataNode = maxCount !== undefined ? new DataNodeClass(maxCount) : new DataNodeClass();
            map.set(typeName, dataNode);
        }
        return dataNode;
    }

    _updateSharedDataNodes(lights) {
        const { stock, masked } = this._groupBatchableLights(lights);
        for (const [typeName, dataNode] of this._stockDataNodes) {
            dataNode.setLights(stock.get(typeName) || []);
        }
        for (const [typeName, dataNode] of this._maskedDataNodes) {
            dataNode.setLights(masked.get(typeName) || []);
        }
    }

    setupLightsNode(builder) {
        const lightNodes = [];
        const stockLightsByType = new Map();
        const maskedLightsByType = new Map();
        const lights = [...this._lights].sort((a, b) => a.id - b.id);
        const nodeLibrary = builder.renderer.library;

        for (const light of lights) {
            if (light.isNode === true) {
                lightNodes.push(nodeObject(light));
                continue;
            }
            if (this._canBatch(light)) {
                const typeName = light.constructor.name;
                const canMask = MASKED_DATA_CLASSES[typeName] !== undefined;
                const target = isLinkedLight(light) && canMask ? maskedLightsByType : stockLightsByType;
                const list = target.get(typeName);
                if (list) list.push(light); else target.set(typeName, [light]);
                continue;
            }
            const lightNode = getOrCreateFallbackLightNode(light, nodeLibrary);
            if (lightNode) lightNodes.push(lightNode);
        }

        // SHARED_DATA_NODES: each dataNode's _lights is driven ONLY by the scene
        // MaxLightsNode's per-frame setLights → _updateDataNodeLights. Material
        // compiles must not call dataNode.setLights — a material's _lights is a
        // stale compile-time snapshot, and stomping the shared list truncates
        // the light-link IDs writeIds() reads for other shaders.
        for (const [typeName, typeLights] of stockLightsByType) {
            const dataNode = this._getOrCreateDataNode(this._stockDataNodes, typeName, STOCK_DATA_CLASSES[typeName]);
            if (!dataNode._maxjsSeeded) {
                dataNode.setLights(typeLights);
                dataNode._maxjsSeeded = true;
            }
            lightNodes.push(dataNode);
        }
        for (const [typeName, typeLights] of maskedLightsByType) {
            const dataNode = this._getOrCreateDataNode(this._maskedDataNodes, typeName, MASKED_DATA_CLASSES[typeName]);
            if (!dataNode._maxjsSeeded) {
                dataNode.setLights(typeLights);
                dataNode._maxjsSeeded = true;
            }
            lightNodes.push(dataNode);
        }

        const reflectionPaintNode = getReflectionPaintNode();
        if (reflectionPaintNode.active) lightNodes.push(reflectionPaintNode);

        // GI irradiance volume — adds position-dependent local diffuse bounce into
        // builder.context.irradiance for every synced material (global; not
        // per-mesh light-link masked — indirect bounce is unmasked by design).
        const giVolumeNode = getGiVolumeNode();
        if (giVolumeNode.active) lightNodes.push(giVolumeNode);

        // HALO-GI BVH-traced DDGI probe field — leak-free room-scale bounce into
        // context.irradiance (global, unmasked, same as the surfel volume). The
        // two are mutually exclusive at runtime (index.html mutes the surfel
        // volume when the probe field is active) to avoid double-counting bounce.
        const giProbeNode = getGiProbeNode();
        if (giProbeNode.active) lightNodes.push(giProbeNode);

        this._lightNodes = lightNodes;
    }

    // Fallback-path light linking. Batched lights are masked inside the
    // Masked*DataNode subclasses; lights that can't batch (shadow-casters,
    // projected/textured spots, area lights) build stock three.js LightNodes
    // which route their contribution back through these two hooks on the active
    // lightsNode (builder.lightsNode === this). For linked lights we multiply the
    // already shadow-scaled color by the per-mesh mask so the same userData masks
    // apply uniformly across every light type.
    setupDirectLight(builder, lightNode, lightData) {
        const factor = maskFactorForLight(lightNode?.light);
        super.setupDirectLight(
            builder,
            lightNode,
            factor === null ? lightData : { ...lightData, lightColor: lightData.lightColor.mul(factor) },
        );
    }

    setupDirectRectAreaLight(builder, lightNode, lightData) {
        const factor = maskFactorForLight(lightNode?.light);
        super.setupDirectRectAreaLight(
            builder,
            lightNode,
            factor === null ? lightData : { ...lightData, lightColor: lightData.lightColor.mul(factor) },
        );
    }

    setLights(lights) {
        super.setLights(lights);
        this._updateSharedDataNodes(lights);
        return this;
    }
}

export const maxLights = (options = {}) => new MaxLightsNode(options);
export { getReflectionPaintNode } from './reflection_paint.js';

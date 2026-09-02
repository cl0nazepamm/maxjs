// MaxLightsNode — DynamicLightsNode + per-mesh 64-bit light-link masks.
//
// Only lights with userData.maxjsLightLinked === true use the masked path.
// Unlinked lights stay on Three's own DynamicLights data nodes, with native
// per-light fallback beyond configured batch sizes. They never consume max.js
// mask slots: None means ordinary Three light behavior with no contribution lost.
//
// Linked lights use a stable lightId (0..63) in userData. Each mesh carries
// two uint32 userData values (maxjsLightMaskLo / maxjsLightMaskHi) read
// in-shader via TSL's `userData()` reference node. The mask is per-mesh at
// render time, not per-material.
//
// Batched masked types: Directional, Point, Spot, Hemisphere. Linked Ambient
// lights take a dedicated per-light node because Three's stock ambient batch
// irreversibly sums them. Other lights that can't batch — shadow-casters,
// projected/textured spots, area lights, and links beyond the fast 64-light
// mask — take the per-light fallback path with the same per-mesh contract.

import DynamicLightsNode from 'three/addons/tsl/lighting/DynamicLightsNode.js';
import AmbientLightDataNode from 'three/addons/tsl/lighting/data/AmbientLightDataNode.js';
import DirectionalLightDataNode from 'three/addons/tsl/lighting/data/DirectionalLightDataNode.js';
import PointLightDataNode from 'three/addons/tsl/lighting/data/PointLightDataNode.js';
import SpotLightDataNode from 'three/addons/tsl/lighting/data/SpotLightDataNode.js';
import HemisphereLightDataNode from 'three/addons/tsl/lighting/data/HemisphereLightDataNode.js';
import { AmbientLightNode, HemisphereLightNode, NodeUtils } from 'three/webgpu';
import { getGiVolumeNode, getGiProbeNode, isIrEmitter, getOrCreateIrLightNode } from 'speedball-gi';
import {
    LIGHT_MASK_HI_KEY,
    LIGHT_LINK_REFRESH_NODE_KEY,
    LIGHT_MASK_LO_KEY,
    LIGHT_MASK_READY_KEY,
    ensureMeshMaskDefaults,
} from './light_linking_core.js';
import {
    If, Loop, getDistanceAttenuation, mix, normalWorld, objectGroup, positionView, renderGroup,
    select, smoothstep, uniform, uniformArray, vec3, uint, int, float,
    bitAnd, shiftLeft, nodeObject, or, not, userData,
} from 'three/tsl';

const UNLINKED_ID = -1;
const lightLinkRefreshNode = uint(0);
const materialObserverOwners = new WeakMap();
const defaultObserverOwner = {};

export { LIGHT_MASK_HI_KEY, LIGHT_MASK_LO_KEY, ensureMeshMaskDefaults } from './light_linking_core.js';

function createMaskDefaults() {
    return {
        loNode: uniform(0xFFFFFFFF, 'uint').setGroup(renderGroup),
        hiNode: uniform(0xFFFFFFFF, 'uint').setGroup(renderGroup),
        generationNode: uniform(0xFFFFFFFF, 'uint').setGroup(renderGroup),
    };
}
export function setLightLinkMaskDefaults(renderer, lo = 0xFFFFFFFF, hi = 0xFFFFFFFF, generation = 0xFFFFFFFF) {
    const defaults = renderer?.lighting?.createNode?.maxjsMaskDefaults;
    if (!defaults) return false;
    defaults.loNode.value = lo >>> 0;
    defaults.hiNode.value = hi >>> 0;
    defaults.generationNode.value = generation >>> 0;
    return true;
}

// Three r185's NodeMaterialObserver only scans direct material node fields. It
// cannot see userData() nodes nested inside a custom LightsNode, so without a
// marker it may skip per-object mask uniform refreshes after the first linked
// frame. This no-op node keeps object refreshes enabled only while specialized
// lighting is active; ordinary-light mode removes it again.
export function setLightLinkMaterialObserver(material, enabled, owner = defaultObserverOwner) {
    if (Array.isArray(material)) {
        let changed = false;
        for (const entry of material) changed = setLightLinkMaterialObserver(entry, enabled, owner) || changed;
        return changed;
    }
    if (!material) return false;
    let owners = materialObserverOwners.get(material);
    if (enabled) {
        if (!owners) {
            owners = new Set();
            materialObserverOwners.set(material, owners);
        }
        if (owners.has(owner)) return false;
        const installMarker = owners.size === 0 && material[LIGHT_LINK_REFRESH_NODE_KEY]?.isNode !== true;
        owners.add(owner);
        if (!installMarker) return false;
        material[LIGHT_LINK_REFRESH_NODE_KEY] = lightLinkRefreshNode;
    } else {
        if (!owners?.delete(owner)) return false;
        if (owners.size > 0) return false;
        materialObserverOwners.delete(material);
        if (material[LIGHT_LINK_REFRESH_NODE_KEY]?.isNode !== true) return false;
        delete material[LIGHT_LINK_REFRESH_NODE_KEY];
    }
    material.needsUpdate = true;
    return true;
}

export function clearUnownedLightLinkMaterialObserver(material) {
    if (Array.isArray(material)) {
        let changed = false;
        for (const entry of material) changed = clearUnownedLightLinkMaterialObserver(entry) || changed;
        return changed;
    }
    if (!material || materialObserverOwners.get(material)?.size > 0) return false;
    if (material[LIGHT_LINK_REFRESH_NODE_KEY]?.isNode !== true) return false;
    delete material[LIGHT_LINK_REFRESH_NODE_KEY];
    material.needsUpdate = true;
    return true;
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

function createMaskNodes(maskDefaults) {
    const ready = userData(LIGHT_MASK_READY_KEY, 'uint')
        .setGroup(objectGroup)
        .equal(maskDefaults.generationNode);
    return {
        loNode: select(ready, userData(LIGHT_MASK_LO_KEY, 'uint').setGroup(objectGroup), maskDefaults.loNode),
        hiNode: select(ready, userData(LIGHT_MASK_HI_KEY, 'uint').setGroup(objectGroup), maskDefaults.hiNode),
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
    constructor(maxCount = 16, maskDefaults) {
        super(maxCount);
        this.maskDefaults = maskDefaults;
        this._ids = new Array(maxCount).fill(UNLINKED_ID);
        this.idsNode = uniformArray(this._ids, 'int').setGroup(renderGroup);
    }
    update(context) {
        super.update(context);
        writeIds(this._ids, this._lights, this.maxCount);
    }
    setup(builder) {
        const { loNode, hiNode } = createMaskNodes(this.maskDefaults);
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
    constructor(maxCount = 32, maskDefaults) {
        super(maxCount);
        this.maskDefaults = maskDefaults;
        this._ids = new Array(maxCount).fill(UNLINKED_ID);
        this.idsNode = uniformArray(this._ids, 'int').setGroup(renderGroup);
    }
    update(context) {
        super.update(context);
        writeIds(this._ids, this._lights, this.maxCount);
    }
    setup(builder) {
        const { loNode, hiNode } = createMaskNodes(this.maskDefaults);
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
    constructor(maxCount = 32, maskDefaults) {
        super(maxCount);
        this.maskDefaults = maskDefaults;
        this._ids = new Array(maxCount).fill(UNLINKED_ID);
        this.idsNode = uniformArray(this._ids, 'int').setGroup(renderGroup);
    }
    update(context) {
        super.update(context);
        writeIds(this._ids, this._lights, this.maxCount);
    }
    setup(builder) {
        const { loNode, hiNode } = createMaskNodes(this.maskDefaults);
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
    constructor(maxCount = 4, maskDefaults) {
        super(maxCount);
        this.maskDefaults = maskDefaults;
        this._ids = new Array(maxCount).fill(UNLINKED_ID);
        this.idsNode = uniformArray(this._ids, 'int').setGroup(renderGroup);
    }
    update(context) {
        super.update(context);
        writeIds(this._ids, this._lights, this.maxCount);
    }
    setup(builder) {
        const { loNode, hiNode } = createMaskNodes(this.maskDefaults);
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

const MASKED_DATA_CLASSES = {
    DirectionalLight: MaskedDirectionalLightDataNode,
    PointLight: MaskedPointLightDataNode,
    SpotLight: MaskedSpotLightDataNode,
    HemisphereLight: MaskedHemisphereLightDataNode,
};

const STOCK_DATA_CLASSES = {
    AmbientLight: AmbientLightDataNode,
    DirectionalLight: DirectionalLightDataNode,
    PointLight: PointLightDataNode,
    SpotLight: SpotLightDataNode,
    HemisphereLight: HemisphereLightDataNode,
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
function maskFactorForLight(light, maskDefaults) {
    const id = light?.userData?.maxjsLightId;
    if (!isLinkedLight(light)) return null;
    if (Number.isInteger(id) && id >= 0 && id < 64) {
        const { loNode, hiNode } = createMaskNodes(maskDefaults);
        const word = id < 32 ? loNode : hiNode;
        const bit = shiftLeft(uint(1), uint(id & 31));
        const contributes = bitAnd(word, bit).notEqual(uint(0));
        return select(contributes, float(1.0), float(0.0));
    }

    const overflowKey = light?.userData?.maxjsLightMaskKey;
    if (typeof overflowKey === 'string' && overflowKey) {
        const ready = userData(LIGHT_MASK_READY_KEY, 'uint')
            .setGroup(objectGroup)
            .equal(maskDefaults.generationNode);
        const objectFactor = userData(overflowKey, 'float').setGroup(objectGroup);
        const fallback = float(light?.userData?.maxjsLightMaskDefault === 0 ? 0 : 1);
        return select(ready, objectFactor, fallback);
    }

    // A linked light must never silently fall back to illuminating everything.
    return float(0);
}

// three.js NodeMaterial.setupLights() spawns a fresh lightsNode via the factory
// every time a material with an env LightingNode compiles (scene.environmentNode set).
// Each instance owns its own _dataNodes → separate UBOs → per-frame setLights() from
// renderList.finish() only reaches the scene-cached instance, leaving material-owned
// ones frozen. Sharing _dataNodes gives every material the same UBO per light type.
const HASH_DATA = [];

class MaskedAmbientLightNode extends AmbientLightNode {
    constructor(light, maskDefaults) {
        super(light);
        this.maskDefaults = maskDefaults;
    }
    setup({ context }) {
        const factor = maskFactorForLight(this.light, this.maskDefaults);
        context.irradiance.addAssign(factor === null ? this.colorNode : this.colorNode.mul(factor));
    }
}

function getOrCreateMaskedAmbientLightNode(light, cache, maskDefaults) {
    let lightNode = cache.get(light);
    if (!lightNode) {
        lightNode = new MaskedAmbientLightNode(light, maskDefaults);
        cache.set(light, lightNode);
    }
    return lightNode;
}

class MaskedHemisphereLightNode extends HemisphereLightNode {
    constructor(light, maskDefaults) {
        super(light);
        this.maskDefaults = maskDefaults;
    }
    setup(builder) {
        const dotNL = normalWorld.dot(this.lightDirectionNode);
        const hemiDiffuseWeight = dotNL.mul(0.5).add(0.5);
        const irradiance = mix(this.groundColorNode, this.colorNode, hemiDiffuseWeight);
        const factor = maskFactorForLight(this.light, this.maskDefaults);
        builder.context.irradiance.addAssign(factor === null ? irradiance : irradiance.mul(factor));
    }
}

function getOrCreateMaskedHemisphereLightNode(light, cache, maskDefaults) {
    let lightNode = cache.get(light);
    if (!lightNode) {
        lightNode = new MaskedHemisphereLightNode(light, maskDefaults);
        cache.set(light, lightNode);
    }
    return lightNode;
}

function getOrCreateFallbackLightNode(light, nodeLibrary, cache) {
    const LightNodeClass = nodeLibrary.getLightNodeClass(light.constructor);
    if (!LightNodeClass) return null;
    let lightNode = cache.get(light);
    if (!lightNode) {
        lightNode = new LightNodeClass(light);
        cache.set(light, lightNode);
    }
    return lightNode;
}

export default class MaxLightsNode extends DynamicLightsNode {
    static get type() { return 'MaxLightsNode'; }

    constructor(options = {}) {
        super(options);
        // Keep the parent map empty because each renderer owns shared data nodes
        // that are reused by every material-owned LightsNode instance.
        this._dataNodes = new Map();
        this._stockDataNodes = options.sharedStockDataNodes ?? new Map();
        this._maskedDataNodes = options.sharedMaskedDataNodes ?? new Map();
        this._maskDefaults = options.maskDefaults ?? createMaskDefaults();
        this._fallbackLightNodeRef = options.fallbackLightNodeRef ?? new WeakMap();
        this._maskedAmbientNodeRef = options.maskedAmbientNodeRef ?? new WeakMap();
        this._maskedHemisphereNodeRef = options.maskedHemisphereNodeRef ?? new WeakMap();
    }

    _canBatchStockBase(light) {
        return !isLinkedLight(light)
            && light.isNode !== true
            && light.castShadow !== true
            && !isSpecialSpotLight(light)
            && !isIrEmitter(light)
            && STOCK_DATA_CLASSES[light.constructor.name] !== undefined;
    }

    _canBatchMaskedBase(light) {
        // IR emitters (emitterClass 'ir') never batch: the batched data nodes read
        // light.color CPU-side (black for a true IR illuminator) — they take the
        // sensed-band per-light path in setupLightsNode instead.
        const linkedId = light?.userData?.maxjsLightId;
        return isLinkedLight(light)
            && Number.isInteger(linkedId)
            && linkedId >= 0
            && linkedId < 64
            && light.isNode !== true
            && light.castShadow !== true
            && !isSpecialSpotLight(light)
            && !isIrEmitter(light)
            && MASKED_DATA_CLASSES[light.constructor.name] !== undefined;
    }

    _computeBatchableSets(lights = this._lights) {
        const stock = new WeakSet();
        const masked = new WeakSet();
        const stockCounts = new Map();
        const maskedCounts = new Map();
        for (const light of [...lights].sort((a, b) => a.id - b.id)) {
            const target = this._canBatchStockBase(light)
                ? stock
                : (this._canBatchMaskedBase(light) ? masked : null);
            if (!target) continue;
            const typeName = light.constructor.name;
            const maxProp = MAX_TO_PROP[typeName];
            if (!maxProp) {
                target.add(light);
                continue;
            }
            const counts = target === stock ? stockCounts : maskedCounts;
            const maxCount = Math.max(0, Number(this[maxProp]) || 0);
            const count = counts.get(typeName) ?? 0;
            if (count >= maxCount) continue;
            counts.set(typeName, count + 1);
            target.add(light);
        }
        return { stock, masked };
    }

    customCacheKey() {
        const typeSet = new Set();
        const batchable = this._computeBatchableSets();
        for (const light of this._lights) {
            if (batchable.stock.has(light)) {
                typeSet.add(`stock:${light.constructor.name}`);
                continue;
            }
            if (batchable.masked.has(light)) {
                typeSet.add(`masked:${light.constructor.name}`);
                continue;
            }
            HASH_DATA.push(light.id);
            HASH_DATA.push(light.castShadow ? 1 : 0);
            HASH_DATA.push(isIrEmitter(light) ? 1 : 0);
            // Linked state + id gate the fallback mask multiply (setupDirectLight).
            // A linked↔unlinked flip or an id reassignment must rebuild the program
            // since the bit shift is baked in at compile time. 0 = unlinked.
            if (isLinkedLight(light)) {
                const linkedId = light.userData?.maxjsLightId;
                const overflowKey = String(light.userData?.maxjsLightMaskKey ?? '');
                HASH_DATA.push(Number.isInteger(linkedId) && linkedId >= 0
                    ? linkedId + 1
                    : NodeUtils.hashString(`overflow:${overflowKey}`));
                HASH_DATA.push(light.userData?.maxjsLightMaskDefault === 0 ? 0 : 1);
            } else {
                HASH_DATA.push(0);
            }
            if (light.isSpotLight === true) {
                HASH_DATA.push(light.map !== null ? light.map.id : -1);
                HASH_DATA.push(light.colorNode ? light.colorNode.getCacheKey() : -1);
            }
        }
        // GI irradiance volume: token carries a generation so enable/disable and
        // grid-resize recompile, but data-only surfel-buffer writes share the same
        // program.
        if (getGiVolumeNode().active) typeSet.add(getGiVolumeNode().cacheToken);
        // Speedball GI probe field: token bumps ONLY on grid resize / enable, never on
        // per-tick atlas writes (the atlas is a stable sampled binding) — so probe
        // updates never recompile materials. This is the churn-free contract.
        if (getGiProbeNode().active) typeSet.add(getGiProbeNode().cacheToken);
        for (const token of [...typeSet].sort()) HASH_DATA.push(NodeUtils.hashString(token));
        const key = NodeUtils.hashArray(HASH_DATA);
        HASH_DATA.length = 0;
        return key;
    }

    _groupBatchableLights(lights, batchable) {
        const grouped = new Map();
        for (const light of lights) {
            if (!batchable.has(light)) continue;
            const typeName = light.constructor.name;
            const list = grouped.get(typeName);
            if (list) list.push(light); else grouped.set(typeName, [light]);
        }
        return grouped;
    }

    _getOrCreateDataNode(map, typeName, DataNodeClass, masked = false) {
        let dataNode = map.get(typeName);
        if (dataNode === undefined) {
            const maxProp = MAX_TO_PROP[typeName];
            const maxCount = maxProp ? this[maxProp] : undefined;
            dataNode = maxCount !== undefined
                ? new DataNodeClass(maxCount, masked ? this._maskDefaults : undefined)
                : new DataNodeClass();
            map.set(typeName, dataNode);
        }
        return dataNode;
    }

    _updateSharedDataNodes(lights) {
        const batchable = this._computeBatchableSets(lights);
        const stock = this._groupBatchableLights(lights, batchable.stock);
        const masked = this._groupBatchableLights(lights, batchable.masked);
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
        const materialLightings = builder.context.materialLightings ?? [];
        const lights = [...materialLightings, ...this._lights]
            .sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
        const batchable = this._computeBatchableSets(lights);
        const nodeLibrary = builder.renderer.library;

        for (const light of lights) {
            if (light.isNode === true) {
                lightNodes.push(nodeObject(light));
                continue;
            }
            if (batchable.stock.has(light)) {
                const typeName = light.constructor.name;
                const list = stockLightsByType.get(typeName);
                if (list) list.push(light); else stockLightsByType.set(typeName, [light]);
                continue;
            }
            if (batchable.masked.has(light)) {
                const typeName = light.constructor.name;
                const list = maskedLightsByType.get(typeName);
                if (list) list.push(light); else maskedLightsByType.set(typeName, [light]);
                continue;
            }
            // IR emitters ride speedball's sensed-band light node (colorNode =
            // white × intensity × nirGate; light.color stays black) so the direct
            // term appears only under NV — same switch as the probes' NEE gate.
            const lightNode = isLinkedLight(light) && light.isAmbientLight === true
                ? getOrCreateMaskedAmbientLightNode(light, this._maskedAmbientNodeRef, this._maskDefaults)
                : (isLinkedLight(light) && light.isHemisphereLight === true
                    ? getOrCreateMaskedHemisphereLightNode(light, this._maskedHemisphereNodeRef, this._maskDefaults)
                    : (isIrEmitter(light)
                        ? getOrCreateIrLightNode(light, nodeLibrary)
                        : getOrCreateFallbackLightNode(light, nodeLibrary, this._fallbackLightNodeRef)));
            if (lightNode) lightNodes.push(lightNode);
        }

        // Shared stock data nodes keep ordinary analytic lights on Three's own
        // DynamicLights fast path. Caps are admission limits only; excess lights
        // already took the native per-light fallback above and are never dropped.
        for (const [typeName, typeLights] of stockLightsByType) {
            const dataNode = this._getOrCreateDataNode(
                this._stockDataNodes,
                typeName,
                STOCK_DATA_CLASSES[typeName],
            );
            if (!dataNode._maxjsSeeded) {
                dataNode.setLights(typeLights);
                dataNode._maxjsSeeded = true;
            }
            lightNodes.push(dataNode);
        }

        // SHARED MASKED DATA NODES: each dataNode's _lights is driven ONLY by the scene
        // MaxLightsNode's per-frame setLights → _updateDataNodeLights. Material
        // compiles must not call dataNode.setLights — a material's _lights is a
        // stale compile-time snapshot, and stomping the shared list truncates
        // the light-link IDs writeIds() reads for other shaders.
        for (const [typeName, typeLights] of maskedLightsByType) {
            const dataNode = this._getOrCreateDataNode(
                this._maskedDataNodes,
                typeName,
                MASKED_DATA_CLASSES[typeName],
                true,
            );
            if (!dataNode._maxjsSeeded) {
                dataNode.setLights(typeLights);
                dataNode._maxjsSeeded = true;
            }
            lightNodes.push(dataNode);
        }

        // GI irradiance volume — adds position-dependent local diffuse bounce into
        // builder.context.irradiance for every synced material (global; not
        // per-mesh light-link masked — indirect bounce is unmasked by design).
        const giVolumeNode = getGiVolumeNode();
        if (giVolumeNode.active) lightNodes.push(giVolumeNode);

        // Speedball GI BVH-traced DDGI probe field — leak-free room-scale bounce into
        // context.irradiance (global, unmasked, same as the surfel volume). The
        // two are mutually exclusive at runtime (index.html mutes the surfel
        // volume when the probe field is active) to avoid double-counting bounce.
        const giProbeNode = getGiProbeNode();
        // materialLightings were already folded into lightNodes above, so the
        // EnvironmentNode needed by Speedball's reflection composite is ordered
        // before this probe without a second insertion or a separate graph path.
        if (giProbeNode.active) lightNodes.push(giProbeNode);

        this._lightNodes = lightNodes;
        return lightNodes;
    }

    // Fallback-path light linking. Batched lights are masked inside the
    // Masked*DataNode subclasses; lights that can't batch (shadow-casters,
    // projected/textured spots, area lights) build stock three.js LightNodes
    // which route their contribution back through these two hooks on the active
    // lightsNode (builder.lightsNode === this). For linked lights we multiply the
    // already shadow-scaled color by the per-mesh mask so the same userData masks
    // apply uniformly across every light type.
    setupDirectLight(builder, lightNode, lightData) {
        const factor = maskFactorForLight(lightNode?.light, this._maskDefaults);
        super.setupDirectLight(
            builder,
            lightNode,
            factor === null ? lightData : { ...lightData, lightColor: lightData.lightColor.mul(factor) },
        );
    }

    setupDirectRectAreaLight(builder, lightNode, lightData) {
        const factor = maskFactorForLight(lightNode?.light, this._maskDefaults);
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

export function installMaxLightsRenderer(renderer, options = {}) {
    if (!renderer?.lighting?.createNode) return false;
    if (renderer.lighting.createNode?.maxjsAdaptiveLighting === true) return true;
    const sharedStockDataNodes = new Map();
    const sharedMaskedDataNodes = new Map();
    const maskDefaults = createMaskDefaults();
    const fallbackLightNodeRef = new WeakMap();
    const maskedAmbientNodeRef = new WeakMap();
    const maskedHemisphereNodeRef = new WeakMap();
    const factory = (lights = []) => maxLights({
        maxDirectionalLights: options.maxDirectionalLights ?? 16,
        maxPointLights: options.maxPointLights ?? 32,
        maxSpotLights: options.maxSpotLights ?? 32,
        maxHemisphereLights: options.maxHemisphereLights ?? 4,
        sharedStockDataNodes,
        sharedMaskedDataNodes,
        maskDefaults,
        fallbackLightNodeRef,
        maskedAmbientNodeRef,
        maskedHemisphereNodeRef,
    }).setLights(lights);
    factory.maxjsAdaptiveLighting = true;
    factory.maxjsStudioLighting = true; // compatibility with older snapshot checks
    factory.maxjsMaskDefaults = maskDefaults;
    renderer.lighting.createNode = factory;
    return true;
}

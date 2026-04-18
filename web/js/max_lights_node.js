// MaxLightsNode — DynamicLightsNode + per-mesh 64-bit light-link masks.
//
// Each synced light is assigned a stable lightId (0..63) in its userData.
// Each mesh carries two uint32 userData values (maxjsLightMaskLo /
// maxjsLightMaskHi) read in-shader via TSL's `userData()` reference node.
// The mask is per-mesh at render time, not per-material — two meshes sharing
// a material can have different masks without cloning the material.
//
// Masked types: Directional, Point, Spot, Hemisphere. Ambient is summed
// into a single irradiance and cannot be per-mesh masked. Projected spots
// and shadow-casters take LightsNode's per-light fallback path (unmasked,
// same behaviour as stock DynamicLightsNode).

import DynamicLightsNode from 'three/addons/tsl/lighting/DynamicLightsNode.js';
import DirectionalLightDataNode from 'three/addons/tsl/lighting/data/DirectionalLightDataNode.js';
import PointLightDataNode from 'three/addons/tsl/lighting/data/PointLightDataNode.js';
import SpotLightDataNode from 'three/addons/tsl/lighting/data/SpotLightDataNode.js';
import HemisphereLightDataNode from 'three/addons/tsl/lighting/data/HemisphereLightDataNode.js';
import AmbientLightDataNode from 'three/addons/tsl/lighting/data/AmbientLightDataNode.js';
import { getReflectionPaintNode, REFL_PAINT_INTENSITY_KEY } from './reflection_paint.js';
import {
    If, Loop, getDistanceAttenuation, mix, normalWorld, positionView, renderGroup,
    select, smoothstep, uniformArray, vec3, uint, int,
    bitAnd, shiftLeft, nodeObject, or, not, userData, materialReference, pmremTexture,
} from 'three/tsl';

export const LIGHT_MASK_LO_KEY = 'maxjsLightMaskLo';
export const LIGHT_MASK_HI_KEY = 'maxjsLightMaskHi';
export const ENV_INTENSITY_KEY = 'maxjsEnvIntensity';
const UNLINKED_ID = -1;

// Stamp defaults on a mesh so the UserDataNode reads have a value on first draw.
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

export function ensureMaterialLightingDefaults(material) {
    if (!material) return;
    material.userData ??= {};
    if (typeof material[ENV_INTENSITY_KEY] !== 'number') {
        material[ENV_INTENSITY_KEY] = 1.0;
    }
    if (typeof material.userData[ENV_INTENSITY_KEY] !== 'number') {
        material.userData[ENV_INTENSITY_KEY] = material[ENV_INTENSITY_KEY];
    } else {
        material[ENV_INTENSITY_KEY] = material.userData[ENV_INTENSITY_KEY];
    }
    if (typeof material[REFL_PAINT_INTENSITY_KEY] !== 'number') {
        material[REFL_PAINT_INTENSITY_KEY] = 1.0;
    }
    if (typeof material.userData[REFL_PAINT_INTENSITY_KEY] !== 'number') {
        material.userData[REFL_PAINT_INTENSITY_KEY] = material[REFL_PAINT_INTENSITY_KEY];
    } else {
        material[REFL_PAINT_INTENSITY_KEY] = material.userData[REFL_PAINT_INTENSITY_KEY];
    }
}

// Wrap a scene's HDRI texture as a TSL node multiplied by a per-material factor.
// Assigning the result to scene.environmentNode makes PBR IBL sampling scale
// by each rendered material's maxjsEnvIntensity.
export function buildEnvironmentIntensityNode(envTexture) {
    if (!envTexture) return null;
    return pmremTexture(envTexture).mul(materialReference(ENV_INTENSITY_KEY, 'float'));
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

const isSpecialSpotLight = (light) =>
    light.isSpotLight === true && (light.map !== null || light.colorNode !== undefined);

// three.js r184 NodeMaterial.setupLights() spawns a fresh lightsNode via the factory
// every time a material with an env LightingNode compiles (scene.environmentNode set).
// Each instance owns its own _dataNodes → separate UBOs → per-frame setLights() from
// renderList.finish() only reaches the scene-cached instance, leaving material-owned
// ones frozen. Sharing _dataNodes gives every material the same UBO per light type.
const SHARED_DATA_NODES = new Map();

export default class MaxLightsNode extends DynamicLightsNode {
    static get type() { return 'MaxLightsNode'; }

    constructor(options = {}) {
        super(options);
        this._dataNodes = SHARED_DATA_NODES;
    }

    get _typeMap() {
        return {
            AmbientLight: AmbientLightDataNode, // unmaskable, stock
            DirectionalLight: MaskedDirectionalLightDataNode,
            PointLight: MaskedPointLightDataNode,
            SpotLight: MaskedSpotLightDataNode,
            HemisphereLight: MaskedHemisphereLightDataNode,
        };
    }

    _canBatch(light) {
        return light.isNode !== true
            && light.castShadow !== true
            && !isSpecialSpotLight(light)
            && this._typeMap[light.constructor.name] !== undefined;
    }

    setupLightsNode(builder) {
        const lightNodes = [];
        const lightsByType = new Map();
        const lights = [...this._lights].sort((a, b) => a.id - b.id);
        const nodeLibrary = builder.renderer.library;
        const typeMap = this._typeMap;

        for (const light of lights) {
            if (light.isNode === true) {
                lightNodes.push(nodeObject(light));
                continue;
            }
            if (this._canBatch(light)) {
                const typeName = light.constructor.name;
                const list = lightsByType.get(typeName);
                if (list) list.push(light); else lightsByType.set(typeName, [light]);
                continue;
            }
            const cls = nodeLibrary.getLightNodeClass(light.constructor);
            if (cls) lightNodes.push(new cls(light));
        }

        // SHARED_DATA_NODES: each dataNode's _lights is driven ONLY by the scene
        // MaxLightsNode's per-frame setLights → _updateDataNodeLights. Material
        // compiles must not call dataNode.setLights — a material's _lights is a
        // stale compile-time snapshot, and stomping the shared list truncates
        // the light-link IDs writeIds() reads for other shaders.
        for (const [typeName, typeLights] of lightsByType) {
            let dataNode = this._dataNodes.get(typeName);
            if (dataNode === undefined) {
                const DataNodeClass = typeMap[typeName];
                const maxProp = MAX_TO_PROP[typeName];
                const maxCount = maxProp ? this[maxProp] : undefined;
                dataNode = maxCount !== undefined ? new DataNodeClass(maxCount) : new DataNodeClass();
                // Seed only once so the first render isn't empty; subsequent
                // frames overwrite via scene's _updateDataNodeLights.
                dataNode.setLights(typeLights);
                this._dataNodes.set(typeName, dataNode);
            }
            lightNodes.push(dataNode);
        }

        for (const [typeName, dataNode] of this._dataNodes) {
            if (!lightsByType.has(typeName)) {
                // Don't reset to [] — another compiled material (or next
                // frame's scene setLights) may still be populating this type.
                lightNodes.push(dataNode);
            }
        }

        // Reflection paint: analytical SG lobes on the environment sphere.
        // Always included — Loop(0) is zero-cost when no lights are painted.
        lightNodes.push(getReflectionPaintNode());

        this._lightNodes = lightNodes;
    }
}

export const maxLights = (options = {}) => new MaxLightsNode(options);
export { getReflectionPaintNode, REFL_PAINT_INTENSITY_KEY } from './reflection_paint.js';

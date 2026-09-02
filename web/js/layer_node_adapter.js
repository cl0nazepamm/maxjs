// Runtime Max node adapter and surface sampling helpers.

import { freezePlainObject } from './layer_utils.js';

const surfaceTopologyCache = new WeakMap();
const surfaceWorldAreaCache = new WeakMap();

// Read-only material summary for layer code. Only assigned texture slots are
// reported; mutation stays with setMap / overrides / deform decorators.
const MATERIAL_SNAPSHOT_MAP_SLOTS = [
    'map', 'aoMap', 'roughnessMap', 'metalnessMap', 'normalMap', 'bumpMap',
    'displacementMap', 'emissiveMap', 'alphaMap', 'lightMap', 'envMap', 'matcap',
];

// Max user-defined properties arrive as the raw "key = value" line buffer
// (userData.maxjsUserProps). Parsed lazily, cached per object, invalidated
// when the raw string changes. Numbers/booleans coerce; quoted strings strip.
const userPropsParseCache = new WeakMap();

function parseUserProps(raw) {
    const out = {};
    for (const line of String(raw).split(/\r\n|\r|\n/)) {
        const idx = line.indexOf('=');
        if (idx <= 0) continue;
        const key = line.slice(0, idx).trim();
        if (!key) continue;
        let value = line.slice(idx + 1).trim();
        if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
            out[key] = value.slice(1, -1);
        } else if (/^-?\d+(\.\d+)?$/.test(value)) {
            out[key] = Number(value);
        } else if (/^(true|false)$/i.test(value)) {
            out[key] = value.toLowerCase() === 'true';
        } else {
            out[key] = value;
        }
    }
    return out;
}

function summarizeMaterial(material) {
    if (!material) return null;
    const maps = {};
    for (const slot of MATERIAL_SNAPSHOT_MAP_SLOTS) {
        const texture = material[slot];
        if (texture) maps[slot] = texture.name || texture.uuid || true;
    }
    return {
        name: material.name || '',
        type: material.type || '',
        color: material.color?.isColor ? material.color.getHex() : null,
        roughness: typeof material.roughness === 'number' ? material.roughness : null,
        metalness: typeof material.metalness === 'number' ? material.metalness : null,
        opacity: typeof material.opacity === 'number' ? material.opacity : null,
        transparent: material.transparent === true,
        side: Number.isFinite(material.side) ? material.side : null,
        emissive: material.emissive?.isColor ? material.emissive.getHex() : null,
        emissiveIntensity: typeof material.emissiveIntensity === 'number' ? material.emissiveIntensity : null,
        maps,
    };
}

function getSurfaceTopologyCache(geometry, THREE) {
    const position = geometry?.getAttribute?.('position') ?? geometry?.attributes?.position;
    if (!position || position.itemSize < 3 || position.count < 3) return null;

    const index = geometry.index ?? null;
    const groupSignature = (geometry.groups ?? [])
        .map(group => `${group.start}:${group.count}:${group.materialIndex ?? 0}`)
        .join('|');
    const topologyKey = [
        index?.count ?? 0,
        index?.version ?? 0,
        position.count,
        position.version ?? 0,
        groupSignature,
    ].join(':');
    const cached = surfaceTopologyCache.get(geometry);
    if (
        cached?.topologyKey === topologyKey
        && cached.position === position
        && cached.index === index
    ) return cached;

    const triangleCount = index ? Math.floor(index.count / 3) : Math.floor(position.count / 3);
    if (triangleCount <= 0) return null;

    const triangleIndices = new Uint32Array(triangleCount * 3);
    const materialIndices = new Int32Array(triangleCount);
    const triangleAreas = new Float64Array(triangleCount);
    const cumulativeAreas = new Float64Array(triangleCount);
    const vA = new THREE.Vector3();
    const vB = new THREE.Vector3();
    const vC = new THREE.Vector3();
    const edgeAB = new THREE.Vector3();
    const edgeAC = new THREE.Vector3();
    const cross = new THREE.Vector3();

    let totalArea = 0;

    for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex++) {
        const offset = triangleIndex * 3;
        const iA = index ? index.getX(offset) : offset;
        const iB = index ? index.getX(offset + 1) : offset + 1;
        const iC = index ? index.getX(offset + 2) : offset + 2;

        triangleIndices[offset] = iA;
        triangleIndices[offset + 1] = iB;
        triangleIndices[offset + 2] = iC;

        vA.fromBufferAttribute(position, iA);
        vB.fromBufferAttribute(position, iB);
        vC.fromBufferAttribute(position, iC);

        edgeAB.subVectors(vB, vA);
        edgeAC.subVectors(vC, vA);
        cross.crossVectors(edgeAB, edgeAC);
        const area = cross.length() * 0.5;
        triangleAreas[triangleIndex] = area;
        totalArea += area;
        cumulativeAreas[triangleIndex] = totalArea;
    }

    for (const group of geometry.groups ?? []) {
        const startTriangle = Math.max(0, Math.floor(Number(group.start) / 3));
        const endTriangle = Math.min(
            triangleCount,
            Math.ceil((Number(group.start) + Number(group.count)) / 3),
        );
        for (let triangleIndex = startTriangle; triangleIndex < endTriangle; triangleIndex += 1) {
            materialIndices[triangleIndex] = Number(group.materialIndex) || 0;
        }
    }

    if (totalArea <= 0) {
        for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex++) {
            triangleAreas[triangleIndex] = 1;
            cumulativeAreas[triangleIndex] = triangleIndex + 1;
        }
        totalArea = triangleCount;
    }

    const nextCache = {
        topologyKey,
        position,
        index,
        triangleCount,
        triangleIndices,
        materialIndices,
        triangleAreas,
        cumulativeAreas,
        totalArea,
    };
    surfaceTopologyCache.set(geometry, nextCache);
    return nextCache;
}

function getWorldAreaCache(mesh, topology, THREE) {
    if (!mesh?.isObject3D || mesh.isSkinnedMesh) return topology;
    mesh.updateWorldMatrix?.(true, false);
    const matrixKey = mesh.matrixWorld.elements.join(',');
    const cached = surfaceWorldAreaCache.get(mesh);
    if (
        cached?.geometry === mesh.geometry
        && cached.topology === topology
        && cached.matrixKey === matrixKey
    ) return cached;

    const position = mesh.geometry?.getAttribute?.('position') ?? mesh.geometry?.attributes?.position;
    if (!position) return topology;
    const triangleAreas = new Float64Array(topology.triangleCount);
    const cumulativeAreas = new Float64Array(topology.triangleCount);
    const vA = new THREE.Vector3();
    const vB = new THREE.Vector3();
    const vC = new THREE.Vector3();
    const edgeAB = new THREE.Vector3();
    const edgeAC = new THREE.Vector3();
    const cross = new THREE.Vector3();
    let totalArea = 0;

    for (let triangleIndex = 0; triangleIndex < topology.triangleCount; triangleIndex += 1) {
        const base = triangleIndex * 3;
        vA.fromBufferAttribute(position, topology.triangleIndices[base]).applyMatrix4(mesh.matrixWorld);
        vB.fromBufferAttribute(position, topology.triangleIndices[base + 1]).applyMatrix4(mesh.matrixWorld);
        vC.fromBufferAttribute(position, topology.triangleIndices[base + 2]).applyMatrix4(mesh.matrixWorld);
        edgeAB.subVectors(vB, vA);
        edgeAC.subVectors(vC, vA);
        cross.crossVectors(edgeAB, edgeAC);
        const area = cross.length() * 0.5;
        triangleAreas[triangleIndex] = area;
        totalArea += area;
        cumulativeAreas[triangleIndex] = totalArea;
    }

    if (totalArea <= 0) {
        for (let triangleIndex = 0; triangleIndex < topology.triangleCount; triangleIndex += 1) {
            triangleAreas[triangleIndex] = 1;
            cumulativeAreas[triangleIndex] = triangleIndex + 1;
        }
        totalArea = topology.triangleCount;
    }

    const next = {
        geometry: mesh.geometry,
        topology,
        topologyKey: topology.topologyKey,
        matrixKey,
        triangleAreas,
        cumulativeAreas,
        totalArea,
    };
    surfaceWorldAreaCache.set(mesh, next);
    return next;
}

function hashSurfaceSeed(seed) {
    const value = typeof seed === 'string' ? seed : String(seed);
    let hash = 2166136261;
    for (let i = 0; i < value.length; i += 1) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function createSurfaceRng(seed) {
    let state = hashSurfaceSeed(seed);
    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

function resolveSurfaceRng(options) {
    if (typeof options.rng === 'function') return options.rng;
    if (options.seed !== undefined) return createSurfaceRng(options.seed);
    return Math.random;
}

function testSurfaceRegExp(regexp, value) {
    regexp.lastIndex = 0;
    return regexp.test(value);
}

function materialSpecMatches(spec, material, mesh, materialIndex) {
    if (spec == null) return true;
    if (Array.isArray(spec)) return spec.some(item => materialSpecMatches(item, material, mesh, materialIndex));
    if (spec?.isMaterial) return spec === material;
    if (typeof spec === 'number') return materialIndex === spec;
    if (typeof spec === 'function') {
        try { return spec(material, { mesh, materialIndex }) === true; }
        catch { return false; }
    }
    const names = [material?.name, material?.userData?.maxjsSourceMaterialName]
        .filter((name, index, all) => typeof name === 'string' && name && all.indexOf(name) === index);
    if (spec instanceof RegExp) return names.some(name => testSurfaceRegExp(spec, name));
    if (typeof spec === 'string') {
        const requested = spec.toLowerCase();
        if (requested.endsWith('*')) {
            const prefix = requested.slice(0, -1);
            return names.some(name => name.toLowerCase().startsWith(prefix));
        }
        return names.some(name => name.toLowerCase() === requested);
    }
    return false;
}

function materialAt(mesh, materialIndex) {
    if (Array.isArray(mesh?.material)) return mesh.material[materialIndex] ?? null;
    return materialIndex === 0 ? (mesh?.material ?? null) : null;
}

function materialIndexMatches(requested, materialIndex) {
    if (requested == null) return true;
    if (Array.isArray(requested)) return requested.some(value => Number(value) === materialIndex);
    return Number(requested) === materialIndex;
}

function getSurfaceDistribution(mesh, topology, options, THREE) {
    const areaSource = String(options.areaSpace ?? 'local').toLowerCase() === 'world'
        ? getWorldAreaCache(mesh, topology, THREE)
        : topology;
    const materialSpec = options.materials ?? options.material;
    const requestedMaterialIndex = options.materialIndex ?? options.materialIndices;
    if (materialSpec == null && requestedMaterialIndex == null) {
        return {
            cumulativeAreas: areaSource.cumulativeAreas,
            totalArea: areaSource.totalArea,
            eligibleTriangles: null,
        };
    }

    const eligible = [];
    const cumulative = [];
    let totalArea = 0;
    for (let triangleIndex = 0; triangleIndex < topology.triangleCount; triangleIndex += 1) {
        const materialIndex = topology.materialIndices[triangleIndex] ?? 0;
        const material = materialAt(mesh, materialIndex);
        if (!materialIndexMatches(requestedMaterialIndex, materialIndex)) continue;
        if (!materialSpecMatches(materialSpec, material, mesh, materialIndex)) continue;
        const area = areaSource.triangleAreas[triangleIndex] ?? 0;
        if (!(area > 0)) continue;
        eligible.push(triangleIndex);
        totalArea += area;
        cumulative.push(totalArea);
    }
    return {
        cumulativeAreas: Float64Array.from(cumulative),
        totalArea,
        eligibleTriangles: Uint32Array.from(eligible),
    };
}

function pickWeightedIndex(cumulativeAreas, totalArea, rng) {
    const clamped = Math.min(Math.max(rng(), 0), 0.9999999999999999);
    const target = clamped * totalArea;
    let lo = 0;
    let hi = cumulativeAreas.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cumulativeAreas[mid] <= target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

function getMeshVertexPosition(mesh, vertexIndex, target) {
    if (typeof mesh.getVertexPosition === 'function') {
        mesh.getVertexPosition(vertexIndex, target);
        return target;
    }

    const position = mesh.geometry?.getAttribute?.('position') ?? mesh.geometry?.attributes?.position;
    if (!position) return target.set(0, 0, 0);

    target.fromBufferAttribute(position, vertexIndex);
    if (mesh.isSkinnedMesh && typeof mesh.applyBoneTransform === 'function') {
        mesh.applyBoneTransform(vertexIndex, target);
    }
    return target;
}

function finiteNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function readVectorInput(value, target, fallbackX = 0, fallbackY = fallbackX, fallbackZ = fallbackX) {
    if (typeof value === 'number') {
        const scalar = finiteNumber(value, fallbackX);
        return target.set(scalar, scalar, scalar);
    }
    if (Array.isArray(value) || ArrayBuffer.isView(value)) {
        return target.set(
            finiteNumber(value[0], fallbackX),
            finiteNumber(value[1], fallbackY),
            finiteNumber(value[2], fallbackZ)
        );
    }
    if (value && typeof value === 'object') {
        return target.set(
            finiteNumber(value.x ?? value[0], fallbackX),
            finiteNumber(value.y ?? value[1], fallbackY),
            finiteNumber(value.z ?? value[2], fallbackZ)
        );
    }
    return target.set(fallbackX, fallbackY, fallbackZ);
}

function readQuaternionInput(value, target) {
    if (value?.isEuler) {
        return target.setFromEuler(value);
    }
    if (Array.isArray(value) || ArrayBuffer.isView(value)) {
        return target.set(
            finiteNumber(value[0], 0),
            finiteNumber(value[1], 0),
            finiteNumber(value[2], 0),
            finiteNumber(value[3], 1)
        ).normalize();
    }
    if (value && typeof value === 'object') {
        return target.set(
            finiteNumber(value.x ?? value[0], 0),
            finiteNumber(value.y ?? value[1], 0),
            finiteNumber(value.z ?? value[2], 0),
            finiteNumber(value.w ?? value[3], 1)
        ).normalize();
    }
    return target.identity();
}

function readEulerInput(value, target) {
    if (value?.isQuaternion) {
        return target.setFromQuaternion(value);
    }
    if (Array.isArray(value) || ArrayBuffer.isView(value)) {
        const order = typeof value[3] === 'string' ? value[3] : (target.order || 'XYZ');
        return target.set(
            finiteNumber(value[0], 0),
            finiteNumber(value[1], 0),
            finiteNumber(value[2], 0),
            order
        );
    }
    if (value && typeof value === 'object') {
        return target.set(
            finiteNumber(value.x ?? value[0], 0),
            finiteNumber(value.y ?? value[1], 0),
            finiteNumber(value.z ?? value[2], 0),
            value.order || target.order || 'XYZ'
        );
    }
    return target.set(0, 0, 0, target.order || 'XYZ');
}

const VECTOR3_MUTATORS = [
    'set', 'setScalar', 'setX', 'setY', 'setZ', 'setComponent',
    'copy', 'add', 'addScalar', 'addVectors', 'addScaledVector',
    'sub', 'subScalar', 'subVectors', 'multiply', 'multiplyScalar',
    'multiplyVectors', 'applyEuler', 'applyAxisAngle', 'applyMatrix3',
    'applyNormalMatrix', 'applyMatrix4', 'applyQuaternion', 'project',
    'unproject', 'transformDirection', 'divide', 'divideScalar', 'min',
    'max', 'clamp', 'clampScalar', 'clampLength', 'floor', 'ceil',
    'round', 'roundToZero', 'negate', 'normalize', 'setLength', 'lerp',
    'lerpVectors', 'cross', 'crossVectors', 'projectOnVector',
    'projectOnPlane', 'reflect', 'setFromMatrixPosition',
    'setFromMatrixScale', 'setFromMatrixColumn', 'setFromMatrix3Column',
    'fromArray', 'fromBufferAttribute', 'random', 'randomDirection',
];

const QUATERNION_MUTATORS = [
    'set', 'copy', 'setFromEuler', 'setFromAxisAngle', 'setFromRotationMatrix',
    'setFromUnitVectors', 'rotateTowards', 'identity', 'invert', 'conjugate',
    'normalize', 'multiply', 'premultiply', 'multiplyQuaternions', 'slerp',
    'slerpQuaternions', 'fromArray', 'random',
];

const EULER_MUTATORS = [
    'set', 'copy', 'setFromRotationMatrix', 'setFromQuaternion',
    'setFromVector3', 'reorder', 'fromArray',
];

function createLiveVector3Facade(THREE, readInto, writeFrom, fallback = [0, 0, 0]) {
    const vector = new THREE.Vector3();
    const backing = new THREE.Vector3();
    let suppressWrite = false;

    function syncFromScene() {
        if (!suppressWrite) readInto(backing);
        return backing;
    }

    function commitToScene() {
        writeFrom(backing);
    }

    function defineComponent(key, index) {
        Object.defineProperty(vector, key, {
            enumerable: true,
            configurable: true,
            get() {
                syncFromScene();
                return backing[key];
            },
            set(value) {
                if (!suppressWrite) syncFromScene();
                backing[key] = finiteNumber(value, fallback[index]);
                if (!suppressWrite) commitToScene();
            },
        });
    }

    defineComponent('x', 0);
    defineComponent('y', 1);
    defineComponent('z', 2);

    for (const method of VECTOR3_MUTATORS) {
        const original = THREE.Vector3.prototype[method];
        if (typeof original !== 'function') continue;
        Object.defineProperty(vector, method, {
            configurable: true,
            value(...args) {
                syncFromScene();
                suppressWrite = true;
                let result;
                try {
                    result = original.apply(vector, args);
                } finally {
                    suppressWrite = false;
                }
                commitToScene();
                return result === vector ? vector : result;
            },
        });
    }

    Object.defineProperty(vector, '_maxjsSync', {
        configurable: true,
        value() {
            syncFromScene();
            return vector;
        },
    });

    return vector;
}

function createLiveQuaternionFacade(THREE, readInto, writeFrom) {
    const quaternion = new THREE.Quaternion();
    const backing = new THREE.Quaternion();
    let suppressWrite = false;

    function syncFromScene() {
        if (!suppressWrite) {
            readInto(backing);
            quaternion._x = backing.x;
            quaternion._y = backing.y;
            quaternion._z = backing.z;
            quaternion._w = backing.w;
        }
        return backing;
    }

    function commitFromFacade() {
        backing.set(
            finiteNumber(quaternion._x, 0),
            finiteNumber(quaternion._y, 0),
            finiteNumber(quaternion._z, 0),
            finiteNumber(quaternion._w, 1)
        ).normalize();
        quaternion._x = backing.x;
        quaternion._y = backing.y;
        quaternion._z = backing.z;
        quaternion._w = backing.w;
        writeFrom(backing);
    }

    function defineComponent(key, internalKey, fallback) {
        Object.defineProperty(quaternion, key, {
            enumerable: true,
            configurable: true,
            get() {
                syncFromScene();
                return quaternion[internalKey];
            },
            set(value) {
                syncFromScene();
                quaternion[internalKey] = finiteNumber(value, fallback);
                if (!suppressWrite) commitFromFacade();
            },
        });
    }

    defineComponent('x', '_x', 0);
    defineComponent('y', '_y', 0);
    defineComponent('z', '_z', 0);
    defineComponent('w', '_w', 1);

    for (const method of QUATERNION_MUTATORS) {
        const original = THREE.Quaternion.prototype[method];
        if (typeof original !== 'function') continue;
        Object.defineProperty(quaternion, method, {
            configurable: true,
            value(...args) {
                syncFromScene();
                suppressWrite = true;
                let result;
                try {
                    result = original.apply(quaternion, args);
                } finally {
                    suppressWrite = false;
                }
                commitFromFacade();
                return result === quaternion ? quaternion : result;
            },
        });
    }

    Object.defineProperty(quaternion, '_maxjsSync', {
        configurable: true,
        value() {
            syncFromScene();
            return quaternion;
        },
    });

    return quaternion;
}

function createLiveEulerFacade(THREE, readInto, writeFrom) {
    const euler = new THREE.Euler();
    const backing = new THREE.Euler();
    let suppressWrite = false;

    function syncFromScene() {
        if (!suppressWrite) {
            readInto(backing);
            euler._x = backing.x;
            euler._y = backing.y;
            euler._z = backing.z;
            euler._order = backing.order || 'XYZ';
        }
        return backing;
    }

    function commitFromFacade() {
        backing.set(
            finiteNumber(euler._x, 0),
            finiteNumber(euler._y, 0),
            finiteNumber(euler._z, 0),
            euler._order || 'XYZ'
        );
        euler._x = backing.x;
        euler._y = backing.y;
        euler._z = backing.z;
        euler._order = backing.order;
        writeFrom(backing);
    }

    function defineComponent(key, internalKey, fallback) {
        Object.defineProperty(euler, key, {
            enumerable: true,
            configurable: true,
            get() {
                syncFromScene();
                return euler[internalKey];
            },
            set(value) {
                syncFromScene();
                euler[internalKey] = key === 'order' ? (value || 'XYZ') : finiteNumber(value, fallback);
                if (!suppressWrite) commitFromFacade();
            },
        });
    }

    defineComponent('x', '_x', 0);
    defineComponent('y', '_y', 0);
    defineComponent('z', '_z', 0);
    defineComponent('order', '_order', 'XYZ');

    for (const method of EULER_MUTATORS) {
        const original = THREE.Euler.prototype[method];
        if (typeof original !== 'function') continue;
        Object.defineProperty(euler, method, {
            configurable: true,
            value(...args) {
                syncFromScene();
                suppressWrite = true;
                let result;
                try {
                    result = original.apply(euler, args);
                } finally {
                    suppressWrite = false;
                }
                commitFromFacade();
                return result === euler ? euler : result;
            },
        });
    }

    Object.defineProperty(euler, '_maxjsSync', {
        configurable: true,
        value() {
            syncFromScene();
            return euler;
        },
    });

    return euler;
}

function createMaxNodeAdapter({
    handle,
    getObject,
    THREE,
    createAnchor,
    layerId,
    getTransformApi,
    setMaterialMap,
    setPropertyOverride,
    clearPropertyOverride,
    hasPropertyOverride,
    getNodeAdapter,
    cloneFromMax,
    setVisibilityOverride,
    clearVisibilityOverride,
    isActive = () => true,
}) {
    const scratch = {
        vA: new THREE.Vector3(),
        vB: new THREE.Vector3(),
        vC: new THREE.Vector3(),
        nA: new THREE.Vector3(),
        nB: new THREE.Vector3(),
        nC: new THREE.Vector3(),
        uvA: new THREE.Vector2(),
        uvB: new THREE.Vector2(),
        uvC: new THREE.Vector2(),
        edgeAB: new THREE.Vector3(),
        edgeAC: new THREE.Vector3(),
        localPoint: new THREE.Vector3(),
        localNormal: new THREE.Vector3(),
        normalMatrix: new THREE.Matrix3(),
        position: new THREE.Vector3(),
        scale: new THREE.Vector3(),
        quaternion: new THREE.Quaternion(),
        euler: new THREE.Euler(),
    };
    const transform = getTransformApi(handle, getObject, layerId);

    function readLocalPosition(target) {
        const obj = getObject();
        return obj?.isObject3D ? target.copy(obj.position) : target.set(0, 0, 0);
    }

    function readLocalScale(target) {
        const obj = getObject();
        return obj?.isObject3D ? target.copy(obj.scale) : target.set(1, 1, 1);
    }

    function readLocalQuaternion(target) {
        const obj = getObject();
        return obj?.isObject3D ? target.copy(obj.quaternion) : target.identity();
    }

    function readLocalRotation(target) {
        const obj = getObject();
        if (!obj?.isObject3D) return target.set(0, 0, 0, target.order || 'XYZ');
        return target.copy(obj.rotation);
    }

    function setLocalPosition(value) {
        readVectorInput(value, scratch.position, 0, 0, 0);
        return transform.setPosition(scratch.position.x, scratch.position.y, scratch.position.z);
    }

    function setLocalScale(value) {
        readVectorInput(value, scratch.scale, 1, 1, 1);
        return transform.setScale(scratch.scale.x, scratch.scale.y, scratch.scale.z);
    }

    function setLocalQuaternion(value) {
        readQuaternionInput(value, scratch.quaternion);
        return transform.setQuaternion(
            scratch.quaternion.x,
            scratch.quaternion.y,
            scratch.quaternion.z,
            scratch.quaternion.w
        );
    }

    function setLocalRotation(value) {
        readEulerInput(value, scratch.euler);
        return transform.setRotationEuler(
            scratch.euler.x,
            scratch.euler.y,
            scratch.euler.z,
            { order: scratch.euler.order }
        );
    }

    function applyLocalVisibility(obj, next) {
        if (!obj?.isObject3D) return false;
        obj.userData ??= {};
        obj.userData.maxjsVisible = next;
        obj.visible = true;
        obj.layers?.set?.(next ? 0 : 31);
        const materials = Array.isArray(obj.material)
            ? obj.material
            : (obj.material ? [obj.material] : []);
        for (const material of materials) {
            if (material) material.visible = true;
        }
        return true;
    }

    function setNodeVisible(value) {
        if (!isActive()) return false;
        const obj = getObject();
        if (!obj) return false;
        const next = value !== false;
        setVisibilityOverride?.(handle, next, obj);
        return applyLocalVisibility(obj, next);
    }

    function resetNodeVisibility() {
        if (!isActive()) return false;
        const obj = getObject();
        if (clearVisibilityOverride) return clearVisibilityOverride(handle, obj);
        if (obj?.isObject3D) {
            obj.userData ??= {};
            delete obj.userData.maxjsVisible;
            obj.visible = true;
            obj.layers?.set?.(0);
            return true;
        }
        return false;
    }

    const positionFacade = createLiveVector3Facade(
        THREE,
        readLocalPosition,
        value => transform.setPosition(value.x, value.y, value.z),
        [0, 0, 0]
    );
    const scaleFacade = createLiveVector3Facade(
        THREE,
        readLocalScale,
        value => transform.setScale(value.x, value.y, value.z),
        [1, 1, 1]
    );
    const quaternionFacade = createLiveQuaternionFacade(
        THREE,
        readLocalQuaternion,
        value => transform.setQuaternion(value.x, value.y, value.z, value.w)
    );
    const rotationFacade = createLiveEulerFacade(
        THREE,
        readLocalRotation,
        value => transform.setRotationEuler(value.x, value.y, value.z, { order: value.order })
    );

    function collectSampleableMeshes(root, includeInvisible = false) {
        if (!root?.isObject3D) return [];
        const meshes = [];
        root.updateWorldMatrix(true, true);
        root.traverse(obj => {
            if (!obj?.isMesh) return;
            if (!includeInvisible && !obj.visible) return;
            const topology = getSurfaceTopologyCache(obj.geometry, THREE);
            if (!topology) return;
            meshes.push({ mesh: obj, topology });
        });
        meshes.sort((a, b) => {
            const aHandle = Number(a.mesh.userData?.maxjsHandle);
            const bHandle = Number(b.mesh.userData?.maxjsHandle);
            if (Number.isFinite(aHandle) && Number.isFinite(bHandle) && aHandle !== bHandle) return aHandle - bHandle;
            if (Number.isFinite(aHandle) !== Number.isFinite(bHandle)) return Number.isFinite(aHandle) ? -1 : 1;
            return String(a.mesh.name ?? '').localeCompare(String(b.mesh.name ?? ''))
                || String(a.mesh.uuid ?? '').localeCompare(String(b.mesh.uuid ?? ''));
        });
        return meshes;
    }

    function sampleMeshSurface(mesh, topology, options = {}, distribution = null) {
        const rng = resolveSurfaceRng(options);
        const point = options.point ?? new THREE.Vector3();
        const normal = options.normal ?? new THREE.Vector3();
        const barycentric = options.barycentric ?? new THREE.Vector3();
        const uvAttribute = mesh.geometry?.getAttribute?.('uv') ?? mesh.geometry?.attributes?.uv ?? null;
        const uv = uvAttribute ? (options.uv ?? new THREE.Vector2()) : null;
        const surfaceDistribution = distribution ?? getSurfaceDistribution(mesh, topology, options, THREE);
        if (!(surfaceDistribution.totalArea > 0) || surfaceDistribution.cumulativeAreas.length === 0) return null;

        const weightedIndex = pickWeightedIndex(
            surfaceDistribution.cumulativeAreas,
            surfaceDistribution.totalArea,
            rng,
        );
        const triangleIndex = surfaceDistribution.eligibleTriangles
            ? surfaceDistribution.eligibleTriangles[weightedIndex]
            : weightedIndex;
        const base = triangleIndex * 3;
        const iA = topology.triangleIndices[base];
        const iB = topology.triangleIndices[base + 1];
        const iC = topology.triangleIndices[base + 2];

        getMeshVertexPosition(mesh, iA, scratch.vA);
        getMeshVertexPosition(mesh, iB, scratch.vB);
        getMeshVertexPosition(mesh, iC, scratch.vC);

        let u = rng();
        let v = rng();
        if (u + v > 1) {
            u = 1 - u;
            v = 1 - v;
        }
        const w = 1 - u - v;
        barycentric.set(w, u, v);

        scratch.localPoint
            .copy(scratch.vA).multiplyScalar(w)
            .addScaledVector(scratch.vB, u)
            .addScaledVector(scratch.vC, v);

        scratch.edgeAB.subVectors(scratch.vB, scratch.vA);
        scratch.edgeAC.subVectors(scratch.vC, scratch.vA);
        scratch.localNormal.crossVectors(scratch.edgeAB, scratch.edgeAC);
        if (scratch.localNormal.lengthSq() > 0) scratch.localNormal.normalize();
        else scratch.localNormal.set(0, 1, 0);

        const requestedNormalMode = String(options.normalMode ?? 'face').toLowerCase();
        const normalAttribute = mesh.geometry?.getAttribute?.('normal') ?? mesh.geometry?.attributes?.normal ?? null;
        const smoothNormal = requestedNormalMode === 'smooth' && normalAttribute && !mesh.isSkinnedMesh;
        if (smoothNormal) {
            scratch.nA.fromBufferAttribute(normalAttribute, iA);
            scratch.nB.fromBufferAttribute(normalAttribute, iB);
            scratch.nC.fromBufferAttribute(normalAttribute, iC);
            scratch.localNormal
                .copy(scratch.nA).multiplyScalar(w)
                .addScaledVector(scratch.nB, u)
                .addScaledVector(scratch.nC, v);
            if (scratch.localNormal.lengthSq() > 0) scratch.localNormal.normalize();
            else scratch.localNormal.crossVectors(scratch.edgeAB, scratch.edgeAC).normalize();
        }

        if (uv) {
            scratch.uvA.fromBufferAttribute(uvAttribute, iA);
            scratch.uvB.fromBufferAttribute(uvAttribute, iB);
            scratch.uvC.fromBufferAttribute(uvAttribute, iC);
            uv.copy(scratch.uvA).multiplyScalar(w)
                .addScaledVector(scratch.uvB, u)
                .addScaledVector(scratch.uvC, v);
        }

        if (options.local === true) {
            point.copy(scratch.localPoint);
            normal.copy(scratch.localNormal);
        } else {
            point.copy(scratch.localPoint).applyMatrix4(mesh.matrixWorld);
            scratch.normalMatrix.getNormalMatrix(mesh.matrixWorld);
            normal.copy(scratch.localNormal).applyMatrix3(scratch.normalMatrix).normalize();
        }

        const materialIndex = topology.materialIndices[triangleIndex] ?? 0;
        const material = materialAt(mesh, materialIndex);
        return {
            point,
            normal,
            barycentric,
            uv,
            triangleIndex,
            material,
            materialIndex,
            materialName: material?.name ?? '',
            normalMode: smoothNormal ? 'smooth' : 'face',
            object: mesh,
            mesh,
            meshHandle: mesh.userData?.maxjsHandle ?? handle,
            meshName: mesh.name ?? '',
        };
    }

    function prepareSurfaceSampling(obj, options) {
        const meshes = obj.isMesh
            ? (() => {
                const topology = getSurfaceTopologyCache(obj.geometry, THREE);
                return topology ? [{ mesh: obj, topology }] : [];
            })()
            : collectSampleableMeshes(obj, options.includeInvisible === true);
        return meshes.map(entry => ({
            ...entry,
            distribution: getSurfaceDistribution(entry.mesh, entry.topology, options, THREE),
        })).filter(entry => entry.distribution.totalArea > 0);
    }

    function samplePreparedSurface(entries, options) {
        if (entries.length === 0) return null;
        if (entries.length === 1) {
            const { mesh, topology, distribution } = entries[0];
            return sampleMeshSurface(mesh, topology, options, distribution);
        }

        let totalArea = 0;
        for (const entry of entries) totalArea += entry.distribution.totalArea;
        if (!(totalArea > 0)) return null;
        const rng = options.rng;
        const target = Math.min(Math.max(rng(), 0), 0.9999999999999999) * totalArea;
        let running = 0;
        for (const entry of entries) {
            running += entry.distribution.totalArea;
            if (target < running) {
                return sampleMeshSurface(entry.mesh, entry.topology, options, entry.distribution);
            }
        }
        const last = entries[entries.length - 1];
        return sampleMeshSurface(last.mesh, last.topology, options, last.distribution);
    }

    return freezePlainObject({
        handle,
        get raw() { return getObject(); },
        get object() { return getObject(); },
        get exists() { return !!getObject(); },
        get name() { return getObject()?.name ?? ''; },
        get type() { return getObject()?.type ?? null; },
        get isMesh() { return !!getObject()?.isMesh; },
        get isHelper() { return !!getObject()?.userData?.maxjsHelper; },
        get position() {
            positionFacade._maxjsSync();
            return positionFacade;
        },
        set position(value) { setLocalPosition(value); },
        get rotation() {
            rotationFacade._maxjsSync();
            return rotationFacade;
        },
        set rotation(value) { setLocalRotation(value); },
        get quaternion() {
            quaternionFacade._maxjsSync();
            return quaternionFacade;
        },
        set quaternion(value) { setLocalQuaternion(value); },
        get scale() {
            scaleFacade._maxjsSync();
            return scaleFacade;
        },
        set scale(value) { setLocalScale(value); },
        get matrix() {
            const obj = getObject();
            return obj?.matrix?.clone?.() ?? null;
        },
        get matrixWorld() {
            const obj = getObject();
            return obj?.matrixWorld?.clone?.() ?? null;
        },
        get visible() {
            const obj = getObject();
            if (!obj) return false;
            return obj.userData?.maxjsVisible !== false && obj.visible !== false;
        },
        set visible(v) { setNodeVisible(v); },
        setVisible(v) { return setNodeVisible(v); },
        show() { setNodeVisible(true); return this; },
        hide() { setNodeVisible(false); return this; },
        resetVisibility() { return resetNodeVisibility(); },
        get jsmod() { return !!getObject()?.userData?.jsmod; },
        /** Max selection state (bridge stamps userData.maxjsSelected).
         *  Subscribe to bus event 'max:selection' for change notifications. */
        get selected() { return getObject()?.userData?.maxjsSelected === true; },
        /** Parsed Max user-defined properties (Object Properties → User
         *  Defined tab): { key: number|boolean|string }. Frozen; empty
         *  object when the node has none. */
        get userProps() {
            const obj = getObject();
            const raw = obj?.userData?.maxjsUserProps;
            if (!raw) return Object.freeze({});
            let cached = userPropsParseCache.get(obj);
            if (!cached || cached.raw !== raw) {
                cached = { raw, parsed: Object.freeze(parseUserProps(raw)) };
                userPropsParseCache.set(obj, cached);
            }
            return cached.parsed;
        },
        /** The raw user-properties buffer exactly as authored in Max. */
        get userPropsRaw() { return getObject()?.userData?.maxjsUserProps ?? ''; },
        /** Read-only view of the synced material(s). Mutation goes through
         *  setMap / overrides.setProperty / ctx.deform decorators. */
        get material() {
            const raw = getObject()?.material ?? null;
            if (!raw) return null;
            const list = Array.isArray(raw) ? raw.filter(Boolean) : [raw];
            return freezePlainObject({
                raw,
                list: Object.freeze([...list]),
                count: list.length,
                snapshot() { return list.map(summarizeMaterial); },
            });
        },
        get parentHandle() {
            const h = Number(getObject()?.userData?.maxjsParentHandle);
            return Number.isFinite(h) && h > 0 ? h : null;
        },
        get parent() {
            const h = Number(getObject()?.userData?.maxjsParentHandle);
            return Number.isFinite(h) && h > 0 ? getNodeAdapter?.(h) ?? null : null;
        },
        get children() {
            const obj = getObject();
            if (!obj?.children?.length) return Object.freeze([]);
            const out = [];
            for (const child of obj.children) {
                const h = child?.userData?.maxjsHandle;
                if (h != null) {
                    const adapter = getNodeAdapter?.(h);
                    if (adapter) out.push(adapter);
                }
            }
            return Object.freeze(out);
        },
        descendants(options = {}) {
            const obj = getObject();
            if (!obj?.children?.length) return Object.freeze([]);
            const out = [];
            obj.traverse(child => {
                if (child === obj) return;
                const h = child?.userData?.maxjsHandle;
                if (h != null) {
                    const adapter = getNodeAdapter?.(h);
                    if (!adapter) return;
                    if (options.meshOnly === true && !adapter.isMesh) return;
                    if (options.visibleOnly === true && !adapter.visible) return;
                    out.push(adapter);
                }
            });
            return Object.freeze(out);
        },
        get materialType() {
            const obj = getObject();
            const mat = Array.isArray(obj?.material) ? obj.material[0] : obj?.material;
            return mat?.type ?? null;
        },
        getWorldMatrix(target = new THREE.Matrix4()) {
            const obj = getObject();
            return obj ? target.copy(obj.matrixWorld) : null;
        },
        getWorldPosition(target = new THREE.Vector3()) {
            const obj = getObject();
            if (!obj) return null;
            obj.getWorldPosition(target);
            return target;
        },
        getWorldQuaternion(target = new THREE.Quaternion()) {
            const obj = getObject();
            if (!obj) return null;
            obj.getWorldQuaternion(target);
            return target;
        },
        getWorldScale(target = new THREE.Vector3()) {
            const obj = getObject();
            if (!obj) return null;
            obj.getWorldScale(target);
            return target;
        },
        getPivotWorldPosition(target = new THREE.Vector3()) {
            const obj = getObject();
            return obj ? obj.getWorldPosition(target) : null;
        },
        getVisualCenter(target = new THREE.Vector3()) {
            const obj = getObject();
            return obj ? new THREE.Box3().setFromObject(obj).getCenter(target) : null;
        },
        getPivotToVisualCenter(target = new THREE.Vector3()) {
            const obj = getObject();
            if (!obj) return null;
            const pivot = obj.getWorldPosition(scratch.vA);
            const center = new THREE.Box3().setFromObject(obj).getCenter(target);
            return center.sub(pivot);
        },
        getLocalAxesWorld() {
            const obj = getObject();
            if (!obj) return null;
            const q = obj.getWorldQuaternion(new THREE.Quaternion());
            return {
                x: new THREE.Vector3(1, 0, 0).applyQuaternion(q).normalize(),
                y: new THREE.Vector3(0, 1, 0).applyQuaternion(q).normalize(),
                z: new THREE.Vector3(0, 0, 1).applyQuaternion(q).normalize(),
            };
        },
        getOrientationSnapshot() {
            const obj = getObject();
            if (!obj) return null;
            const pivot = obj.getWorldPosition(new THREE.Vector3());
            const bbox = new THREE.Box3().setFromObject(obj);
            const center = bbox.getCenter(new THREE.Vector3());
            const dimensions = bbox.getSize(new THREE.Vector3());
            const axes = this.getLocalAxesWorld();
            return {
                handle,
                name: obj.name,
                pivot: pivot.toArray(),
                visualCenter: center.toArray(),
                dimensions: dimensions.toArray(),
                pivotToVisualCenter: center.clone().sub(pivot).toArray(),
                localAxesWorld: {
                    x: axes.x.toArray(),
                    y: axes.y.toArray(),
                    z: axes.z.toArray(),
                },
                worldMatrix: obj.matrixWorld.toArray(),
            };
        },
        get isLight() { return !!getObject()?.isLight; },
        get isDirectionalLight() { return !!getObject()?.isDirectionalLight; },
        /** For directional/spot lights: the normalized world-space direction the light shines toward.
         *  For other lights/objects without a target: the object's local -Z transformed by world rotation. */
        getLightDirection(target = new THREE.Vector3()) {
            const obj = getObject();
            if (!obj) return null;
            if (obj.target) {
                const p = new THREE.Vector3();
                obj.getWorldPosition(p);
                obj.target.getWorldPosition(target);
                target.sub(p);
            } else {
                const q = new THREE.Quaternion();
                obj.getWorldQuaternion(q);
                target.set(0, 0, -1).applyQuaternion(q);
            }
            return target.lengthSq() > 0 ? target.normalize() : target.set(0, -1, 0);
        },
        getBoundingBox(target = new THREE.Box3()) {
            const obj = getObject();
            return obj ? target.setFromObject(obj) : null;
        },
        transform,
        get base() { return transform.baseSnapshot(); },
        resetTransform() { return transform.clear(); },
        reset() {
            const transformChanged = transform.clear();
            const visibilityChanged = resetNodeVisibility();
            return transformChanged || visibilityChanged;
        },
        clone(options = {}) {
            return cloneFromMax?.(handle, options) ?? null;
        },
        // Override a material map slot on the synced mesh. Survives
        // fastsync rebuilds — registered against the handle, reapplied
        // on every scene message after the material is rebuilt. Pass
        // texture=null to clear an override.
        setMap(slot, texture) {
            if (typeof slot !== 'string' || !slot) return false;
            return setMaterialMap?.(handle, slot, texture) === true;
        },
        overrides: freezePlainObject({
            hasProperty(property) {
                if (typeof property !== 'string' || !property) return false;
                return hasPropertyOverride?.(handle, property) === true;
            },
            setProperty(property, value, options = {}) {
                if (typeof property !== 'string' || !property) return false;
                return setPropertyOverride?.(handle, property, value, {
                    ...options,
                    object: getObject(),
                }) === true;
            },
            clearProperty(property, options = {}) {
                if (typeof property !== 'string' || !property) return false;
                return clearPropertyOverride?.(handle, property, {
                    ...options,
                    object: getObject(),
                }) === true;
            },
        }),
        snapshot() {
            const obj = getObject();
            if (!obj) return null;
            const position = new THREE.Vector3();
            const quaternion = new THREE.Quaternion();
            const scale = new THREE.Vector3();
            obj.matrixWorld.decompose(position, quaternion, scale);
            return {
                handle,
                name: obj.name,
                type: obj.type,
                visible: !!obj.visible,
                matrixWorld: obj.matrixWorld.toArray(),
                position: position.toArray(),
                quaternion: quaternion.toArray(),
                scale: scale.toArray(),
            };
        },
        createAnchor(options = {}) {
            return createAnchor(handle, options);
        },
        sampleSurface: function sampleSurface(options = {}) {
            const requestedCount = options.count == null ? 0 : Number(options.count);
            if (
                !Number.isFinite(requestedCount)
                || !Number.isInteger(requestedCount)
                || requestedCount < 0
                || requestedCount > 100000
            ) {
                throw new RangeError('sampleSurface: count must be an integer between 0 and 100000');
            }
            const count = requestedCount;
            const rng = resolveSurfaceRng(options);
            const obj = getObject();
            if (!obj?.isObject3D) return null;
            if (!options.includeInvisible && !obj.visible) return null;
            const resolvedOptions = options.rng === rng ? options : { ...options, rng };
            const entries = prepareSurfaceSampling(obj, resolvedOptions);
            if (count <= 1) return samplePreparedSurface(entries, resolvedOptions);

            const batchOptions = { ...resolvedOptions };
            delete batchOptions.count;
            // A batch returns independent records. Reusing caller-provided
            // output targets here made every result alias the final sample.
            delete batchOptions.point;
            delete batchOptions.normal;
            delete batchOptions.barycentric;
            delete batchOptions.uv;
            const out = [];
            for (let i = 0; i < count; i += 1) {
                const hit = samplePreparedSurface(entries, batchOptions);
                if (hit) out.push(hit);
            }
            return Object.freeze(out);
        },
    });
}
export { createMaxNodeAdapter };

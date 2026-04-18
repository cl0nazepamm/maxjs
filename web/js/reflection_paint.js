// ReflectionPaintNode — analytical lobes painted onto the environment sphere.
// Supports circle and rectangle shapes with configurable edge sharpness and
// rotation. Anisotropic X/Y size with two-color gradient (center to edge).

import { LightingNode, Vector3, Vector4, Color } from 'three/webgpu';
import {
    Loop, vec3, float, clamp, max, abs, cross, sqrt,
    cameraPosition, positionWorld, normalWorld, roughness, select, mix as tslMix,
    smoothstep, sin, cos,
    uniform, uniformArray, renderGroup, PI, NodeUpdateType,
    int,
} from 'three/tsl';

export const MAX_REFLECTION_LIGHTS = 16;
export const REFL_PAINT_INTENSITY_KEY = 'maxjsReflPaintIntensity';

export const materialRpIntensity = /*@__PURE__*/ uniform(1)
    .onReference(({ material }) => material)
    .onObjectUpdate(({ material }) => material[REFL_PAINT_INTENSITY_KEY] ?? 1.0);

let _instance = null;

export class ReflectionPaintNode extends LightingNode {
    static get type() { return 'ReflectionPaintNode'; }

    constructor() {
        super();
        this._lights = [];
        this._nextId = 1;
        // Packed 4 vec4s per light — single UBO instead of 5 separate arrays.
        //   slot0: dir.xyz, intensity
        //   slot1: color.rgb, radiusX
        //   slot2: outerColor.rgb, radiusY
        //   slot3: edge, rotation, shape, _
        this._packed = [];
        for (let i = 0; i < MAX_REFLECTION_LIGHTS; i++) {
            this._packed.push(new Vector4(0, 1, 0, 2.0));
            this._packed.push(new Vector4(1, 1, 1, 0.15));
            this._packed.push(new Vector4(0, 0, 0, 0.15));
            this._packed.push(new Vector4(0.3, 0, 0, 0));
        }
        this.dataNode = uniformArray(this._packed, 'vec4').setGroup(renderGroup);
        this.countNode = uniform(0, 'int').setGroup(renderGroup);
        this.updateType = NodeUpdateType.RENDER;
    }

    update() {
        const count = Math.min(this._lights.length, MAX_REFLECTION_LIGHTS);
        this.countNode.value = count;
        for (let i = 0; i < count; i++) {
            const l = this._lights[i];
            const base = i * 4;
            const d = l.direction;
            const len = Math.hypot(d.x, d.y, d.z) || 1;
            this._packed[base + 0].set(d.x / len, d.y / len, d.z / len, l.intensity);
            this._packed[base + 1].set(l.color.r, l.color.g, l.color.b, l.radiusX);
            this._packed[base + 2].set(l.colorOuter.r, l.colorOuter.g, l.colorOuter.b, l.radiusY);
            this._packed[base + 3].set(l.edge, l.rotation, l.shape === 'rect' ? 1 : 0, 0);
        }
    }

    setup(builder) {
        const incident = positionWorld.sub(cameraPosition).normalize();
        const worldReflect = incident.reflect(normalWorld).normalize();
        const intensityNode = materialRpIntensity;

        const painted = vec3(0).toVar('reflPaintRadiance');
        Loop(this.countNode, ({ i }) => {
            const base = i.mul(int(4));
            const d0 = this.dataNode.element(base);                  // dir.xyz, intensity
            const d1 = this.dataNode.element(base.add(int(1)));      // color.rgb, radiusX
            const d2 = this.dataNode.element(base.add(int(2)));      // outerColor.rgb, radiusY
            const d3 = this.dataNode.element(base.add(int(3)));      // edge, rotation, shape, _

            const dir = d0.xyz.normalize();
            const intensity = d0.w;
            const col = d1.xyz;
            const radiusX = d1.w;
            const outerCol = d2.xyz;
            const radiusY = d2.w;
            const edge = d3.x;
            const rot = d3.y;
            const shapeFlag = d3.z;

            // Build tangent frame around the light direction.
            const up = select(abs(dir.y).greaterThan(float(0.99)), vec3(1, 0, 0), vec3(0, 1, 0));
            const rawTangent = cross(up, dir).normalize();
            const rawBitangent = cross(dir, rawTangent);

            // Apply rotation to the tangent frame.
            const ca = cos(rot);
            const sa = sin(rot);
            const tangent = rawTangent.mul(ca).add(rawBitangent.mul(sa));
            const bitangent = rawBitangent.mul(ca).sub(rawTangent.mul(sa));

            // Project angular offset onto the rotated tangent plane.
            const cosAngle = worldReflect.dot(dir);
            const diff = worldReflect.sub(dir.mul(cosAngle));
            const dx = diff.dot(tangent);
            const dy = diff.dot(bitangent);

            // Roughness-dependent minimum spread.
            const roughSpread = roughness.mul(PI).mul(float(0.25));
            const spreadX = max(radiusX, roughSpread);
            const spreadY = max(radiusY, roughSpread);

            const edgeW = clamp(edge, float(0.001), float(1.0));

            const nx = abs(dx).div(spreadX);
            const ny = abs(dy).div(spreadY);

            const isRect = shapeFlag.greaterThan(float(0.5));

            const dist = sqrt(nx.mul(nx).add(ny.mul(ny)));
            const circleMask = smoothstep(float(1.0), float(1.0).sub(edgeW), dist);

            const rectMaskX = smoothstep(float(1.0), float(1.0).sub(edgeW), nx);
            const rectMaskY = smoothstep(float(1.0), float(1.0).sub(edgeW), ny);
            const rectMask = rectMaskX.mul(rectMaskY);

            const mask = select(isRect, rectMask, circleMask);

            const gradColor = tslMix(outerCol, col, mask);
            painted.addAssign(gradColor.mul(mask).mul(intensity));
        });

        builder.context.radiance.addAssign(painted.mul(intensityNode));
    }

    // ── JS API ──────────────────────────────────────────

    addLight(props = {}) {
        const light = {
            id: this._nextId++,
            direction: new Vector3(0, 1, 0),
            color: new Color(1, 1, 1),
            colorOuter: new Color(0, 0, 0),
            intensity: props.intensity ?? 2.0,
            radiusX: props.radiusX ?? 0.15,
            radiusY: props.radiusY ?? 0.15,
            edge: props.edge ?? 0.3,
            rotation: props.rotation ?? 0,
            shape: props.shape ?? 'circle',
        };
        if (props.direction) light.direction.copy(props.direction).normalize();
        if (props.color) light.color.set(props.color);
        if (props.colorOuter != null) light.colorOuter.set(props.colorOuter);
        if (props.lat != null && props.lon != null) {
            dirFromLatLon(props.lat, props.lon, light.direction);
        }
        this._lights.push(light);
        return light.id;
    }

    updateLight(id, props) {
        const l = this._lights.find(x => x.id === id);
        if (!l) return;
        if (props.direction) l.direction.copy(props.direction).normalize();
        if (props.color != null) l.color.set(props.color);
        if (props.colorOuter != null) l.colorOuter.set(props.colorOuter);
        if (props.intensity != null) l.intensity = props.intensity;
        if (props.radiusX != null) l.radiusX = props.radiusX;
        if (props.radiusY != null) l.radiusY = props.radiusY;
        if (props.edge != null) l.edge = props.edge;
        if (props.rotation != null) l.rotation = props.rotation;
        if (props.shape != null) l.shape = props.shape;
        if (props.lat != null && props.lon != null) {
            dirFromLatLon(props.lat, props.lon, l.direction);
        }
    }

    removeLight(id) {
        const idx = this._lights.findIndex(x => x.id === id);
        if (idx >= 0) this._lights.splice(idx, 1);
    }

    clearLights() {
        this._lights.length = 0;
    }

    getLights() {
        return this._lights.map(l => ({
            id: l.id,
            direction: { x: l.direction.x, y: l.direction.y, z: l.direction.z },
            color: '#' + l.color.getHexString(),
            colorOuter: '#' + l.colorOuter.getHexString(),
            intensity: l.intensity,
            radiusX: l.radiusX,
            radiusY: l.radiusY,
            edge: l.edge,
            rotation: l.rotation,
            shape: l.shape,
            ...latLonFromDir(l.direction),
        }));
    }

    get count() { return this._lights.length; }
}

function dirFromLatLon(latDeg, lonDeg, target) {
    const lat = latDeg * Math.PI / 180;
    const lon = lonDeg * Math.PI / 180;
    target.set(
        Math.cos(lat) * Math.sin(lon),
        Math.sin(lat),
        Math.cos(lat) * Math.cos(lon),
    ).normalize();
    return target;
}

function latLonFromDir(dir) {
    const lat = Math.asin(Math.max(-1, Math.min(1, dir.y))) * 180 / Math.PI;
    const lon = Math.atan2(dir.x, dir.z) * 180 / Math.PI;
    return { lat, lon: ((lon % 360) + 360) % 360 };
}

export function getReflectionPaintNode() {
    if (!_instance) _instance = new ReflectionPaintNode();
    return _instance;
}

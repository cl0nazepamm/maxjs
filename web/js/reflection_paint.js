// ReflectionPaintNode — analytical lobes painted onto the environment sphere.
// Supports circle and rectangle shapes with configurable edge sharpness and
// rotation. Anisotropic X/Y size with two-color gradient (center to edge).

import { LightingNode, Vector3, Vector4, Color } from 'three/webgpu';
import {
    Loop, vec3, float, clamp, max, abs, cross, sqrt,
    cameraPosition, positionWorld, normalWorld, roughness, select, mix as tslMix,
    smoothstep, sin, cos,
    uniform, uniformArray, renderGroup, PI, NodeUpdateType,
    userData,
} from 'three/tsl';

export const MAX_REFLECTION_LIGHTS = 16;
export const REFL_PAINT_INTENSITY_KEY = 'maxjsReflPaintIntensity';

let _instance = null;

export class ReflectionPaintNode extends LightingNode {
    static get type() { return 'ReflectionPaintNode'; }

    constructor() {
        super();
        this._lights = [];
        this._nextId = 1;
        this._dirs = [];
        this._colors = [];
        this._outerColors = [];
        this._params = [];  // vec4: radiusX, radiusY, intensity, edge
        this._params2 = []; // vec4: rotation, shape(0=circle,1=rect), 0, 0
        for (let i = 0; i < MAX_REFLECTION_LIGHTS; i++) {
            this._dirs.push(new Vector3(0, 1, 0));
            this._colors.push(new Color(1, 1, 1));
            this._outerColors.push(new Color(0, 0, 0));
            this._params.push(new Vector4(0.15, 0.15, 2.0, 0.3));
            this._params2.push(new Vector4(0, 0, 0, 0));
        }
        this.dirsNode = uniformArray(this._dirs, 'vec3').setGroup(renderGroup);
        this.colorsNode = uniformArray(this._colors, 'color').setGroup(renderGroup);
        this.outerColorsNode = uniformArray(this._outerColors, 'color').setGroup(renderGroup);
        this.paramsNode = uniformArray(this._params, 'vec4').setGroup(renderGroup);
        this.params2Node = uniformArray(this._params2, 'vec4').setGroup(renderGroup);
        this.countNode = uniform(0, 'int').setGroup(renderGroup);
        this.updateType = NodeUpdateType.RENDER;
    }

    update() {
        const count = Math.min(this._lights.length, MAX_REFLECTION_LIGHTS);
        this.countNode.value = count;
        for (let i = 0; i < count; i++) {
            const l = this._lights[i];
            this._dirs[i].copy(l.direction).normalize();
            this._colors[i].copy(l.color);
            this._outerColors[i].copy(l.colorOuter);
            this._params[i].set(l.radiusX, l.radiusY, l.intensity, l.edge);
            this._params2[i].set(l.rotation, l.shape === 'rect' ? 1 : 0, 0, 0);
        }
    }

    setup(builder) {
        const incident = positionWorld.sub(cameraPosition).normalize();
        const worldReflect = incident.reflect(normalWorld).normalize();
        const intensityNode = userData(REFL_PAINT_INTENSITY_KEY, 'float');

        const painted = vec3(0).toVar('reflPaintRadiance');
        Loop(this.countNode, ({ i }) => {
            const dir = this.dirsNode.element(i).normalize();
            const col = this.colorsNode.element(i);
            const outerCol = this.outerColorsNode.element(i);
            const p = this.paramsNode.element(i);   // x=radiusX, y=radiusY, z=intensity, w=edge
            const p2 = this.params2Node.element(i); // x=rotation, y=shape

            // Build tangent frame around the light direction.
            const up = select(abs(dir.y).greaterThan(float(0.99)), vec3(1, 0, 0), vec3(0, 1, 0));
            const rawTangent = cross(up, dir).normalize();
            const rawBitangent = cross(dir, rawTangent);

            // Apply rotation to the tangent frame.
            const ca = cos(p2.x);
            const sa = sin(p2.x);
            const tangent = rawTangent.mul(ca).add(rawBitangent.mul(sa));
            const bitangent = rawBitangent.mul(ca).sub(rawTangent.mul(sa));

            // Project angular offset onto the rotated tangent plane.
            const cosAngle = worldReflect.dot(dir);
            const diff = worldReflect.sub(dir.mul(cosAngle));
            const dx = diff.dot(tangent);
            const dy = diff.dot(bitangent);

            // Roughness-dependent minimum spread.
            const roughSpread = roughness.mul(PI).mul(float(0.25));
            const spreadX = max(p.x, roughSpread);
            const spreadY = max(p.y, roughSpread);

            // Edge sharpness: 0 = razor sharp, 1 = very soft.
            // edge controls the smoothstep transition width as a fraction of the radius.
            const edgeW = clamp(p.w, float(0.001), float(1.0));

            // Normalized coordinates (0 at center, 1 at boundary).
            const nx = abs(dx).div(spreadX);
            const ny = abs(dy).div(spreadY);

            // Shape evaluation:
            // Circle: radial distance
            // Rect: max of X and Y (becomes independent axis smoothsteps)
            const isRect = p2.y.greaterThan(float(0.5));

            // Circle mask
            const dist = sqrt(nx.mul(nx).add(ny.mul(ny)));
            const circleMask = smoothstep(float(1.0), float(1.0).sub(edgeW), dist);

            // Rect mask
            const rectMaskX = smoothstep(float(1.0), float(1.0).sub(edgeW), nx);
            const rectMaskY = smoothstep(float(1.0), float(1.0).sub(edgeW), ny);
            const rectMask = rectMaskX.mul(rectMaskY);

            const mask = select(isRect, rectMask, circleMask);

            // Two-color gradient: center color at mask=1, outer color at mask=0.
            const gradColor = tslMix(outerCol, col, mask);
            painted.addAssign(gradColor.mul(mask).mul(p.z));
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

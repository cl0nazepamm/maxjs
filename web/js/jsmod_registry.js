// jsmod_registry.js — JS modifier registry for MaxJS Three.js viewport.
// When C++ detects a "three.js Deform" modifier on a Max node, it sends
// jsmod:{script, strength, speed, scale, seed, enabled} per node.
// This module clones geometry, stores rest positions, and deforms per frame.

const SCRIPT_NAMES = ['wind', 'ripple', 'twist', 'noise'];

// Simple inline value noise (no external deps)
function hash(x, y, z) {
    let h = (x * 374761393 + y * 668265263 + z * 1274126177) | 0;
    h = ((h ^ (h >> 13)) * 1103515245) | 0;
    return ((h ^ (h >> 16)) >>> 0) / 4294967296;
}

function valueNoise3D(x, y, z) {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    const fx = x - ix, fy = y - iy, fz = z - iz;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const sz = fz * fz * (3 - 2 * fz);

    const n000 = hash(ix, iy, iz);
    const n100 = hash(ix + 1, iy, iz);
    const n010 = hash(ix, iy + 1, iz);
    const n110 = hash(ix + 1, iy + 1, iz);
    const n001 = hash(ix, iy, iz + 1);
    const n101 = hash(ix + 1, iy, iz + 1);
    const n011 = hash(ix, iy + 1, iz + 1);
    const n111 = hash(ix + 1, iy + 1, iz + 1);

    const nx00 = n000 + sx * (n100 - n000);
    const nx10 = n010 + sx * (n110 - n010);
    const nx01 = n001 + sx * (n101 - n001);
    const nx11 = n011 + sx * (n111 - n011);

    const nxy0 = nx00 + sy * (nx10 - nx00);
    const nxy1 = nx01 + sy * (nx11 - nx01);

    return nxy0 + sz * (nxy1 - nxy0);  // 0..1
}

export function createJsModRegistry({ THREE, nodeMap, maxRoot, jsRoot }) {
    const modifiers = new Map();   // name -> fn
    const tracked = new Map();     // handle -> { clone, restPositions, params, original }
    const runtimeRoot = jsRoot?.isObject3D ? jsRoot : maxRoot;

    function registerModifier(name, fn) {
        modifiers.set(name, fn);
    }

    function paramsChanged(a, b) {
        if (!a || !b) return true;
        return a.script !== b.script ||
            a.strength !== b.strength ||
            a.speed !== b.speed ||
            a.scale !== b.scale ||
            a.seed !== b.seed;
    }

    function createClone(handle, original, params) {
        if (!original?.isMesh || !original.geometry) return null;

        const srcGeom = original.geometry;
        const posAttr = srcGeom.getAttribute('position');
        if (!posAttr) return null;

        // Clone geometry (deep copy of buffers)
        const clonedGeom = srcGeom.clone();
        // Snapshot rest positions
        const restPositions = new Float32Array(posAttr.array);

        // Create clone mesh sharing the original's material (no material clone)
        const clone = new THREE.Mesh(clonedGeom, original.material);
        clone.name = `${original.name || 'node'}_jsmod`;
        clone.matrixAutoUpdate = false;
        clone.frustumCulled = false;
        clone.matrix.copy(original.matrix);
        clone.matrixWorld.copy(original.matrixWorld);
        clone.matrixWorldNeedsUpdate = true;

        // Hide original, show clone under the JS runtime root so snapshots
        // serialize the deform output instead of the authored Max mesh.
        original.visible = false;
        runtimeRoot?.add(clone);

        return { clone, restPositions, params, original };
    }

    function tearDown(handle) {
        const entry = tracked.get(handle);
        if (!entry) return;
        tracked.delete(handle);

        // Restore original visibility
        if (entry.original) entry.original.visible = true;

        // Remove and dispose clone
        if (entry.clone) {
            if (entry.clone.parent) entry.clone.parent.remove(entry.clone);
            if (entry.clone.geometry) entry.clone.geometry.dispose();
            // Don't dispose material (shared with original)
        }
    }

    function processNode(handle, nodeData) {
        const jsmod = nodeData?.jsmod;
        const existing = tracked.get(handle);

        // No jsmod or disabled: tear down if tracked
        if (!jsmod || !jsmod.enabled) {
            if (existing) tearDown(handle);
            return;
        }

        const original = nodeMap.get(handle);
        if (!original?.isMesh) {
            if (existing) tearDown(handle);
            return;
        }

        if (existing) {
            // Check if geometry vertex count changed (re-snapshot needed)
            const srcPosAttr = original.geometry?.getAttribute('position');
            if (srcPosAttr && srcPosAttr.count * 3 !== existing.restPositions.length) {
                tearDown(handle);
                // Fall through to create new clone below
            } else {
                // Update params if changed, keep clone
                if (paramsChanged(existing.params, jsmod)) {
                    existing.params = { ...jsmod };
                }
                // Sync material reference in case it changed
                existing.clone.material = original.material;
                return;
            }
        }

        // Create new clone
        const entry = createClone(handle, original, { ...jsmod });
        if (entry) tracked.set(handle, entry);
    }

    function removeNode(handle) {
        tearDown(handle);
    }

    function update(dt, elapsed) {
        for (const [handle, entry] of tracked) {
            const { clone, restPositions, params, original } = entry;
            if (!clone || !original) continue;

            const scriptName = SCRIPT_NAMES[params.script] ?? SCRIPT_NAMES[0];
            const fn = modifiers.get(scriptName);
            if (!fn) continue;

            const posAttr = clone.geometry.getAttribute('position');
            if (!posAttr) continue;

            fn(posAttr.array, restPositions, params, elapsed, dt);
            posAttr.needsUpdate = true;

            // Sync transform from original
            clone.matrix.copy(original.matrix);
            clone.matrixWorld.copy(original.matrixWorld);
            clone.matrixWorldNeedsUpdate = true;

            // Keep original hidden
            original.visible = false;
        }
    }

    function dispose() {
        for (const handle of [...tracked.keys()]) {
            tearDown(handle);
        }
        modifiers.clear();
    }

    // ── Built-in modifiers ─────────────────────────────────

    // Wind: Height-based (Z-up) noise displacement. More sway at top.
    // XY displacement primarily, Z subtle.
    registerModifier('wind', (positions, rest, params, time, dt) => {
        const { strength = 1, speed = 1, scale = 1, seed = 0 } = params;
        const t = time * speed;
        const invScale = 1 / Math.max(scale, 0.001);

        // Find Z range for height normalization
        let zMin = Infinity, zMax = -Infinity;
        for (let i = 2; i < rest.length; i += 3) {
            const z = rest[i];
            if (z < zMin) zMin = z;
            if (z > zMax) zMax = z;
        }
        const zRange = zMax - zMin || 1;

        for (let i = 0; i < rest.length; i += 3) {
            const rx = rest[i], ry = rest[i + 1], rz = rest[i + 2];
            const heightFactor = Math.max(0, (rz - zMin) / zRange);
            const heightFactor2 = heightFactor * heightFactor;

            const nx = valueNoise3D(rx * invScale + seed, ry * invScale, t) * 2 - 1;
            const ny = valueNoise3D(rx * invScale, ry * invScale + seed + 31.7, t + 17.3) * 2 - 1;
            const nz = valueNoise3D(rx * invScale + 57.1, ry * invScale + seed, t + 43.9) * 2 - 1;

            positions[i]     = rx + nx * strength * heightFactor2;
            positions[i + 1] = ry + ny * strength * heightFactor2;
            positions[i + 2] = rz + nz * strength * 0.15 * heightFactor2;
        }
    });

    // Ripple: Concentric sine waves from center, displacing along Z.
    registerModifier('ripple', (positions, rest, params, time, dt) => {
        const { strength = 1, speed = 1, scale = 1, seed = 0 } = params;
        const t = time * speed + seed;
        const freq = 1 / Math.max(scale, 0.001);

        // Find XY center
        let cx = 0, cy = 0, count = rest.length / 3;
        for (let i = 0; i < rest.length; i += 3) {
            cx += rest[i];
            cy += rest[i + 1];
        }
        cx /= count;
        cy /= count;

        for (let i = 0; i < rest.length; i += 3) {
            const rx = rest[i], ry = rest[i + 1], rz = rest[i + 2];
            const dx = rx - cx, dy = ry - cy;
            const dist = Math.sqrt(dx * dx + dy * dy);

            positions[i]     = rx;
            positions[i + 1] = ry;
            positions[i + 2] = rz + Math.sin(dist * freq - t) * strength;
        }
    });

    // Twist: Rotate XY proportional to Z height + time.
    registerModifier('twist', (positions, rest, params, time, dt) => {
        const { strength = 1, speed = 1, scale = 1, seed = 0 } = params;
        const t = time * speed + seed;
        const twistRate = strength * 0.01 / Math.max(scale, 0.001);

        // Find Z range and XY center
        let zMin = Infinity, zMax = -Infinity;
        let cx = 0, cy = 0, count = rest.length / 3;
        for (let i = 0; i < rest.length; i += 3) {
            cx += rest[i];
            cy += rest[i + 1];
            const z = rest[i + 2];
            if (z < zMin) zMin = z;
            if (z > zMax) zMax = z;
        }
        cx /= count;
        cy /= count;
        const zRange = zMax - zMin || 1;

        for (let i = 0; i < rest.length; i += 3) {
            const rx = rest[i], ry = rest[i + 1], rz = rest[i + 2];
            const heightNorm = (rz - zMin) / zRange;
            const angle = heightNorm * twistRate + t;
            const dx = rx - cx, dy = ry - cy;
            const cosA = Math.cos(angle), sinA = Math.sin(angle);

            positions[i]     = cx + dx * cosA - dy * sinA;
            positions[i + 1] = cy + dx * sinA + dy * cosA;
            positions[i + 2] = rz;
        }
    });

    // Noise: Generic 3D noise displacement on all axes.
    registerModifier('noise', (positions, rest, params, time, dt) => {
        const { strength = 1, speed = 1, scale = 1, seed = 0 } = params;
        const t = time * speed;
        const invScale = 1 / Math.max(scale, 0.001);

        for (let i = 0; i < rest.length; i += 3) {
            const rx = rest[i], ry = rest[i + 1], rz = rest[i + 2];

            const nx = valueNoise3D(rx * invScale + seed, ry * invScale, rz * invScale + t) * 2 - 1;
            const ny = valueNoise3D(rx * invScale + 73.1, ry * invScale + seed + 31.7, rz * invScale + t) * 2 - 1;
            const nz = valueNoise3D(rx * invScale + 137.9, ry * invScale + 97.3, rz * invScale + seed + t) * 2 - 1;

            positions[i]     = rx + nx * strength;
            positions[i + 1] = ry + ny * strength;
            positions[i + 2] = rz + nz * strength;
        }
    });

    return { registerModifier, processNode, removeNode, update, dispose };
}

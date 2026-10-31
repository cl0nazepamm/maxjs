// ir_emitters.js - near-infrared illuminators for PowerShot's infrared and NightShot modes.
//
// A light tagged as an IR illuminator (userData.emitterClass) is invisible to the
// eye: it stays black until the imager senses NIR, then lights at white x gain,
// whatever color Max authored. Plain light color writes, so no shader rebuilds,
// and the classic WebGL renderer behaves the same.

export function isIrEmitter(light) {
    const raw = light?.userData?.emitterClass;
    if (raw === undefined || raw === null) return false;
    if (typeof raw === 'string') {
        const s = raw.trim().toLowerCase();
        return s === 'ir' || s.startsWith('ir_') || s.startsWith('ir ') || s.includes('illuminator');
    }
    return Number.isFinite(raw) && Math.trunc(raw) >= 4;
}

// Applies the NIR band to `lights` every frame (light sync may rewrite colors in
// between). Returns true when the sensed IR lighting changed.
export function createIrEmitterGate() {
    let lastKey = '';
    return function syncIrEmitters(lights, sensing, gain = 1) {
        const level = sensing ? Math.max(0, Number(gain) || 0) : 0;
        let count = 0;
        for (const light of lights) {
            if (!light?.isLight || !isIrEmitter(light)) continue;
            light.color.setScalar(level);
            count++;
        }
        const key = count ? `${count}:${level}` : '';
        if (key === lastKey) return false;
        lastKey = key;
        return true;
    };
}

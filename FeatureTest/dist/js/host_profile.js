// host_profile.js — which application is hosting the runtime.
//
// A non-Max host (the Blender add-on's webview2_shim, a future standalone
// shell) declares itself by defining `window.MAXJS_HOST_PROFILE` BEFORE the
// web bootstrap runs, e.g.:
//     window.MAXJS_HOST_PROFILE = { app: 'Blender', appFull: 'Blender', sceneExt: '.blend' };
// Every field is optional and falls back to the 3ds Max reference host, so
// the Max path renders byte-identical strings when no profile is provided.
// UI code reads this for terminology ONLY — never for behavior branches.

const DEFAULT_PROFILE = Object.freeze({
    app: 'Max',         // short app name for compact UI labels ("Optimize Max Instances")
    appFull: '3ds Max', // full app name for prose and error messages
    sceneExt: '.max',   // scene file extension shown in file-location hints
});

function readOverride() {
    const raw = typeof window !== 'undefined' ? window.MAXJS_HOST_PROFILE : null;
    if (!raw || typeof raw !== 'object') return null;
    const out = {};
    for (const key of Object.keys(DEFAULT_PROFILE)) {
        const value = raw[key];
        if (typeof value === 'string' && value.trim()) out[key] = value.trim();
    }
    return out;
}

export function getHostProfile() {
    return { ...DEFAULT_PROFILE, ...readOverride() };
}

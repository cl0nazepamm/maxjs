// EXRLoader has no parser for `m44f` (4x4 matrix) header attributes and warns
// about each one; the pixel data is unaffected. Silence just that warning
// around parse().
export function suppressKnownExrMetadataWarnings(loader) {
    if (!loader || loader.userData?.maxjsQuietM44fHeader) return loader;
    const originalParse = typeof loader.parse === 'function' ? loader.parse.bind(loader) : null;
    if (!originalParse) return loader;
    loader.parse = (...args) => {
        const previousWarn = console.warn;
        console.warn = (...warnArgs) => {
            const msg = String(warnArgs?.[0] ?? '');
            if (msg.includes('THREE.EXRLoader: Skipped unknown header attribute type') &&
                msg.includes('m44f')) {
                return;
            }
            previousWarn.apply(console, warnArgs);
        };
        try {
            return originalParse(...args);
        } finally {
            console.warn = previousWarn;
        }
    };
    loader.userData = { ...(loader.userData || {}), maxjsQuietM44fHeader: true };
    return loader;
}

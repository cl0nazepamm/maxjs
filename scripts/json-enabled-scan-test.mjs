// 1:1 JS transliteration of JsonObjectHasEnabledTrue from
// src/maxjs_panel_snapshot_export.inl — validates the algorithm against
// realistic snapshotUi payloads. Run: node scripts/json-enabled-scan-test.mjs
function jsonObjectHasEnabledTrue(json, key) {
    if (!json || !key) return false;
    const needle = `"${key}"`;
    const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r';

    let searchPos = 0;
    let pos;
    while ((pos = json.indexOf(needle, searchPos)) !== -1) {
        searchPos = pos + 1;

        let i = pos + needle.length;
        while (i < json.length && isSpace(json[i])) i++;
        if (i >= json.length || json[i] !== ':') continue;
        i++;
        while (i < json.length && isSpace(json[i])) i++;
        if (i >= json.length || json[i] !== '{') continue;

        const enabledKey = '"enabled"';
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (; i < json.length; i++) {
            const c = json[i];
            if (inString) {
                if (escaped) escaped = false;
                else if (c === '\\') escaped = true;
                else if (c === '"') inString = false;
                continue;
            }
            if (c === '"') {
                if (depth === 1 && json.startsWith(enabledKey, i)) {
                    let after = i + enabledKey.length;
                    while (after < json.length && isSpace(json[after])) after++;
                    if (after < json.length && json[after] === ':') {
                        after++;
                        while (after < json.length && isSpace(json[after])) after++;
                        return json.startsWith('true', after);
                    }
                }
                inString = true;
                continue;
            }
            if (c === '{') depth++;
            else if (c === '}') { if (--depth === 0) break; }
        }
        return false;
    }
    return false;
}

// ── Test payloads ──────────────────────────────────────────────────────
const bigLayer = { kind: 'noise', name: 'layer {with braces} and "quotes\\"', visible: true, enabled: true, opacity: 1, params: { detail: 'x'.repeat(900) } };

const snapshotUi = {
    toneMapping: 'aces',
    fx: {
        ssgi: { enabled: false, radius: 8 },
        ssr: { enabled: true, quality: 0.45 },
        bloom: { enabled: false, strength: 0.4 },
        powershot: { enabled: true, mode: 'digital', preset: 'powershot', amount: 1 },
        colorGrading: { brightness: 0, contrast: 0 },
    },
    // enabled flag AFTER a huge config (old 768-window scan would miss it)
    shaderLab: { config: { composition: { width: 1920, height: 1080 }, layers: [bigLayer], timeline: { duration: 6 } }, autoApply: true, enabled: true, passes: [] },
};

const snapshotUiDisabledLab = JSON.parse(JSON.stringify(snapshotUi));
snapshotUiDisabledLab.shaderLab.enabled = false; // nested layer still has enabled:true — must NOT leak

const snapshotUiPowershotOff = JSON.parse(JSON.stringify(snapshotUi));
snapshotUiPowershotOff.fx.powershot.enabled = false;

const cases = [
    // [json, key, expected]
    [JSON.stringify(snapshotUi), 'ssr', true],
    [JSON.stringify(snapshotUi), 'ssgi', false],          // old scan could false-positive into ssr's window
    [JSON.stringify(snapshotUi), 'bloom', false],
    [JSON.stringify(snapshotUi), 'powershot', true],      // "preset":"powershot" value must be skipped
    [JSON.stringify(snapshotUi), 'shaderLab', true],      // enabled past huge config
    [JSON.stringify(snapshotUiDisabledLab), 'shaderLab', false], // nested layer enabled:true must not leak
    [JSON.stringify(snapshotUiPowershotOff), 'powershot', false],
    [JSON.stringify(snapshotUi), 'missing', false],
    ['', 'ssr', false],
];

let failed = 0;
for (const [json, key, expected] of cases) {
    const got = jsonObjectHasEnabledTrue(json, key);
    if (got !== expected) {
        failed++;
        console.error(`FAIL key=${key} expected=${expected} got=${got}`);
    }
}
console.log(failed === 0 ? `all ${cases.length} cases passed` : `${failed}/${cases.length} FAILED`);
process.exit(failed === 0 ? 0 : 1);

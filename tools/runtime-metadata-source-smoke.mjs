import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const fullSyncSource = readFileSync(
    new URL('../src/maxjs_panel_fullsync.inl', import.meta.url), 'utf8');
const snapshotSource = readFileSync(
    new URL('../src/maxjs_panel_snapshot_export.inl', import.meta.url), 'utf8');
const syncSource = readFileSync(
    new URL('../src/maxjs_panel_sync.inl', import.meta.url), 'utf8');
const extractorSource = readFileSync(
    new URL('../src/maxjs_scene_extractors.h', import.meta.url), 'utf8');
const callbackSource = readFileSync(
    new URL('../src/maxjs_panel_callbacks.inl', import.meta.url), 'utf8');
const sceneApplierSource = readFileSync(
    new URL('../web/js/scene_applier.js', import.meta.url), 'utf8');
const sceneLightsSource = readFileSync(
    new URL('../web/js/scene_lights.js', import.meta.url), 'utf8');

function sliceBetween(source, start, end) {
    const startOffset = source.indexOf(start);
    assert.ok(startOffset >= 0, `missing source marker: ${start}`);
    const endOffset = source.indexOf(end, startOffset + start.length);
    assert.ok(endOffset >= 0, `missing source marker after ${start}: ${end}`);
    return source.slice(startOffset, endOffset);
}

function functionBody(source, signature) {
    const signatureOffset = source.indexOf(signature);
    assert.ok(signatureOffset >= 0, `missing ${signature}`);
    const bodyOffset = source.indexOf('{', signatureOffset + signature.length);
    assert.ok(bodyOffset >= 0, `missing body for ${signature}`);

    let depth = 0;
    for (let i = bodyOffset; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') {
            depth--;
            if (depth === 0) return source.slice(bodyOffset + 1, i);
        }
    }
    assert.fail(`unterminated body for ${signature}`);
}

const jsonHelper = sliceBetween(
    fullSyncSource,
    'if (IsMaxJSHierarchyNode(node, t)) {',
    '// Hidden render nodes are skipped',
);
assert.match(jsonHelper, /WriteUserPropsJson\s*\(\s*ss\s*,\s*node\s*\)/,
    'JSON helpers carry user properties');

const binaryHelper = sliceBetween(
    fullSyncSource,
    'if (ng.helper) {',
    'MaxJSPBR pbr; ExtractPBR',
);
assert.match(binaryHelper, /WriteUserPropsJson\s*\(\s*ss\s*,\s*ng\.node\s*\)/,
    'binary helpers carry user properties');

const snapshotHelper = sliceBetween(
    snapshotSource,
    'if (node.helper) {',
    'if (!node.verts.empty())',
);
assert.match(snapshotHelper, /WriteUserPropsJson\s*\(\s*ss\s*,\s*node\.node\s*\)/,
    'snapshot helpers carry user properties');

const splineMaterial = sliceBetween(
    fullSyncSource,
    '// Multi/Sub material support. Spline extraction has no',
    'geomHandles_.insert(handle);',
);
assert.doesNotMatch(splineMaterial, /if\s*\(\s*!isSpline\s*\)/,
    'JSON spline material emission is not suppressed');
assert.match(splineMaterial, /\\"matRef\\":/,
    'JSON splines have the single-material fallback');

const selectionRescan = sliceBetween(
    syncSource,
    'if (selectionRescanDirty) {',
    'std::vector<ULONG> deduplicatedVisibilityOwners',
);
assert.match(selectionRescan, /selectionDirty\.insert\s*\(\s*helperHandles_\.begin\(\)/,
    'selection rescans include helper handles');

const lightWriter = functionBody(
    syncSource,
    'bool WriteLightJson(std::wostringstream& ss, INode* node, TimeValue t,',
);
assert.match(lightWriter, /WriteUserPropsJson\s*\(\s*ss\s*,\s*node\s*\)/,
    'full light JSON carries user properties');

for (const callbackName of ['NameChanged', 'UserPropertiesChanged']) {
    assert.match(
        extractorSource,
        new RegExp(`void\\s+${callbackName}\\s*\\(\\s*NodeKeyTab&\\s+nodes\\s*\\)\\s*override`),
        `${callbackName} is registered with INodeEventCallback`,
    );
    const body = functionBody(
        callbackSource,
        `void MaxJSFastNodeEventCallback::${callbackName}(NodeKeyTab&)`,
    );
    assert.match(body, /owner_->SetDirty\s*\(\s*false\s*\)/,
        `${callbackName} uses the debounced full-sync path without arming the idle audit`);
    assert.doesNotMatch(body, /GetUserPropBuffer|Compute(?:NodeProp|LightState)Hash/,
        `${callbackName} does not add polling or hot-path hashing`);
}

const standaloneHelper = sliceBetween(
    sceneApplierSource,
    'if (nd.helper === true) {',
    '// Instance buckets',
);
assert.match(standaloneHelper, /mesh\.userData\.maxjsUserProps\s*=\s*nd\.userProps/,
    'standalone helpers stamp the raw user-property buffer');
assert.match(standaloneHelper, /delete\s+mesh\.userData\.maxjsUserProps/,
    'authoritative helper payloads clear removed user properties');

const lightMetadata = functionBody(sceneLightsSource, 'function applyLightMetadata(light, ld)');
assert.match(lightMetadata, /light\.userData\.maxjsUserProps\s*=\s*props/,
    'standalone lights stamp the raw user-property buffer');
assert.match(lightMetadata, /delete\s+light\.userData\.maxjsUserProps/,
    'authoritative light payloads clear removed user properties');
assert.ok(lightMetadata.includes('/emitterClass\\s*=\\s*([a-z_]+)/i'),
    'standalone lights derive spectral emitter class from user properties');
assert.ok(lightMetadata.includes('/colorTemp\\s*=\\s*([0-9.]+)/i'),
    'standalone lights derive color temperature from user properties');
assert.match(lightMetadata, /delete\s+light\.userData\.emitterClass/,
    'authoritative light payloads clear removed emitter metadata');
assert.match(lightMetadata, /delete\s+light\.userData\.colorTemp/,
    'authoritative light payloads clear removed color temperature');

const applyStandaloneLightMetadata = new Function('light', 'ld', lightMetadata);
const standaloneLight = {
    name: 'Neutral Light',
    userData: {
        emitterClass: 'stale',
        colorTemp: 1000,
        maxjsUserProps: 'stale=true',
    },
};
applyStandaloneLightMetadata(standaloneLight, {
    userProps: 'emitterClass = IR\ncolorTemp = 2856',
});
assert.equal(standaloneLight.userData.maxjsUserProps,
    'emitterClass = IR\ncolorTemp = 2856');
assert.equal(standaloneLight.userData.emitterClass, 'ir');
assert.equal(standaloneLight.userData.colorTemp, 2856);

applyStandaloneLightMetadata(standaloneLight, {});
assert.equal('maxjsUserProps' in standaloneLight.userData, false,
    'authoritative payload clears the raw property stamp');
assert.equal('emitterClass' in standaloneLight.userData, false,
    'authoritative payload clears stale emitter class');
assert.equal('colorTemp' in standaloneLight.userData, false,
    'authoritative payload clears stale color temperature');

standaloneLight.name = 'Warehouse_LED_Key';
applyStandaloneLightMetadata(standaloneLight, {});
assert.equal(standaloneLight.userData.emitterClass, 'led',
    'name tagging remains the metadata fallback');

const applyLightData = functionBody(sceneLightsSource, 'function applyLightData(light, ld, nodeMap, parent)');
assert.match(applyLightData, /applyLightMetadata\s*\(\s*light\s*,\s*ld\s*\)/,
    'every standalone full-light application runs metadata sync');

console.log('runtime-metadata-source-smoke: PASS');

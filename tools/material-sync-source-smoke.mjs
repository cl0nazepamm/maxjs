import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const syncSource = readFileSync(new URL('../src/maxjs_panel_sync.inl', import.meta.url), 'utf8');
const fullSyncSource = readFileSync(new URL('../src/maxjs_panel_fullsync.inl', import.meta.url), 'utf8');

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

// Returns the body of the first `for (...) { ... }` loop over `loopHead`.
function loopBody(body, loopHead) {
    const headOffset = body.indexOf(loopHead);
    assert.ok(headOffset >= 0, `missing loop ${loopHead}`);
    return functionBody(body.slice(headOffset), loopHead);
}

// A full sync caused by one node of a shared material must still refresh the
// hashes of every other sharer; stopping early leaves them stale and the idle
// crawler re-syncs them one confirmed full sync (and geometry resend) at a time.
for (const [signature, loopHead] of [
    ['void NotifyMaterialEditedTarget(ReferenceTarget* target)', 'for (ULONG handle : handles)'],
    ['void CheckTrackedMaterialScalarsLive()', 'for (ULONG handle : geomHandles_)'],
]) {
    const body = functionBody(syncSource, signature);
    const loop = loopBody(body, loopHead);
    assert.doesNotMatch(loop, /SetDirtyImmediate\s*\(/,
        `${signature} requests the full sync after visiting every node`);
    assert.doesNotMatch(loop, /\breturn\s*;/,
        `${signature} never leaves the per-node loop early`);
    assert.match(body, /if\s*\(\s*needsFullSync\s*\)\s*\{[\s\S]*?SetDirtyImmediate\s*\(\s*\)/,
        `${signature} requests one full sync once the loop is done`);
}

const markMaterial = functionBody(syncSource,
    'void MarkMaterialNodesDirty(const NodeEventNamespace::NodeKeyTab& nodes, bool structured)');
assert.doesNotMatch(markMaterial, /if\s*\(\s*needsFullSync\s*\)\s*break\s*;/,
    'MarkMaterialNodesDirty refreshes every listed node before the full sync');

// Face groups only depend on the material for Multi/Sub nodes, so a single
// material's structure change (any edit on a textured material) must not throw
// away the node's geometry cache and force a resend.
const invalidate = functionBody(syncSource, 'void InvalidateMaterialGroupGeometry(INode* node, ULONG handle)');
assert.match(invalidate, /FindMultiSubMtl[\s\S]*NumSubMtls\s*\(\s*\)\s*<=\s*0\s*\)\s*return/,
    'geometry invalidation is limited to Multi/Sub materials');
const crawler = functionBody(syncSource, 'void DetectMaterialChanges()');
for (const [name, body] of [['MarkMaterialNodesDirty', markMaterial], ['DetectMaterialChanges', crawler]]) {
    assert.doesNotMatch(body, /geoHashMap_\.erase/,
        `${name} goes through InvalidateMaterialGroupGeometry`);
    assert.match(body, /InvalidateMaterialGroupGeometry\s*\(/,
        `${name} still invalidates Multi/Sub geometry on structure changes`);
}

// A delivered full sync is the viewer's material baseline.
const refresh = functionBody(syncSource, 'void RefreshMaterialSyncBaselines(TimeValue t)');
assert.match(refresh, /pendingMaterialEditTargets_\.clear\s*\(\s*\)/,
    'watcher targets queued before the full sync are covered by it');
assert.match(refresh, /mtlHashMap_\s*\[\s*handle\s*\]\s*=[\s\S]*mtlScalarHashMap_\s*\[\s*handle\s*\]\s*=[\s\S]*mtlFastScalarHashMap_\s*\[\s*handle\s*\]\s*=/,
    'full sync re-seeds all three material hashes');
// The full-sync serializers stream brace literals (L'}'), so anchor on the
// scene post result instead of brace-matching their bodies.
const postedRefreshes = fullSyncSource.match(
    /if\s*\(\s*FAILED\s*\(\s*scenePostResult\s*\)\s*\)\s*\{\s*HandleFullSyncDeliveryFailure\s*\(\s*\)\s*;\s*return\s+false\s*;\s*\}[^}]*?ResetFastPathState\s*\(\s*true\s*\)\s*;\s*RefreshMaterialSyncBaselines\s*\(\s*t\s*\)/g) ?? [];
assert.equal(postedRefreshes.length, 2,
    'SendFullSync and SendFullSyncBinary refresh material baselines only after a successful post');

console.log('material sync source smoke: PASS');

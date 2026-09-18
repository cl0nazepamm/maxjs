import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from '../web/node_modules/three/build/three.core.js';

// Execute the production settings glue without a GPU or editor host.
const source = readFileSync(new URL('../web/js/editor/gi_volume_glue.js', import.meta.url), 'utf8');
const makeGlue = new Function('THREE', 'window', source.replace(/^import .*;\r?\n/gm, '').replace('export { createGiVolumeGlue };', 'return createGiVolumeGlue;'));
const windowStub = {};
let saves = 0;
const calls = [];
let normalDetail;
let autoPadding;
const field = {
    setAutoPadding: value => { autoPadding = value; },
    setNormalDetail: value => { normalDetail = value; },
    setJitterMode: value => calls.push(['mode', value]),
    setHysteresis: value => calls.push(['history', value]),
};
const deps = { renderer: {}, isStudioMode: false, speedballGi: { field },
    bridge: { on() {} }, hostBridge: { onSharedBuffer() {} }, savePostFxState() { saves++; } };
const glue = makeGlue(THREE, windowStub)(deps);
const defaults = { ...glue.getSpeedballGiSettings() };
assert.equal(defaults.jitterMode, 'gated');
assert.equal(defaults.reflectionQuality, 'off');
for (const old of [false, true]) {
    const normalized = glue.normalizeSpeedballGiSettings({ roughReflections: old });
    assert.equal(normalized.reflectionQuality, old ? 'ultra' : 'off');
}
for (const quality of ['off', 'rough', 'high', 'ultra']) {
    const normalized = glue.normalizeSpeedballGiSettings({ reflectionQuality: quality, roughReflections: false });
    assert.equal(normalized.reflectionQuality, quality);
    assert.equal(normalized.roughReflections, quality !== 'off');
}
assert.equal(glue.normalizeSpeedballGiSettings({ jitterMode: 'invalid' }).jitterMode, 'gated');
assert.equal(glue.normalizeSpeedballGiSettings({ reflectionQuality: 'invalid' }).reflectionQuality, 'off');
glue.applySpeedballGiState({ jitterMode: 'montecarlo', hysteresis: 0.97, reflectionQuality: 'high' }, { persist: true });
assert.equal(saves, 1);
assert.deepEqual(calls.slice(-2), [['mode', 'montecarlo'], ['history', 0.97]]);
const saved = JSON.parse(JSON.stringify(glue.serializeSpeedballGiState()));
glue.resetSpeedballGiToDefaults();
glue.applySpeedballGiState(saved);
assert.equal(glue.getSpeedballGiSettings().jitterMode, 'montecarlo');
assert.equal(glue.getSpeedballGiSettings().reflectionQuality, 'high');
assert.equal(glue.getSpeedballGiSettings().hysteresis, 0.97);
glue.setSpeedballGiSetting('intensity', 4);
assert.equal(glue.getSpeedballGiSettings().reflectionQuality, 'high', 'partial updates retain tier');
glue.setSpeedballGiSetting('jitterMode', 'gated');
assert.equal(glue.getSpeedballGiSettings().hysteresis, 0.97, 'mode switch preserves authored smoothing');

// Snapshot deserialization and tuning must replay the same authored state.
const snapshotSource = readFileSync(new URL('../web/js/snapshot_boot.js', import.meta.url), 'utf8');
const settingsStart = snapshotSource.indexOf('const SNAPSHOT_SPEEDBALL_GI_DEFAULTS');
const settingsEnd = snapshotSource.indexOf('function snapshotSpeedballVolumeBoxes', settingsStart);
const applyStart = snapshotSource.indexOf('function applySnapshotSpeedballGiSettings');
const applyEnd = snapshotSource.indexOf('async function createSnapshotSpeedballGi', applyStart);
const { normalize, apply } = new Function(snapshotSource.slice(settingsStart, settingsEnd)
    + snapshotSource.slice(applyStart, applyEnd)
    + '; return {normalize: normalizeSnapshotSpeedballGiState, apply: applySnapshotSpeedballGiSettings};')();
const restored = normalize({ speedballGi: saved });
assert.equal(restored.jitterMode, 'montecarlo');
assert.equal(restored.reflectionQuality, 'high');
apply(field, restored);
assert.deepEqual(calls.slice(-2), [['mode', 'montecarlo'], ['history', 0.97]]);
assert.equal(normalize({ speedballGi: { roughReflections: true } }).reflectionQuality, 'ultra');
assert.equal(normalize({ speedballGi: {} }).jitterMode, 'gated');
assert.equal(normalize({ speedballGi: { reflectionQuality: 'off', roughReflections: true } }).reflectionQuality, 'off');
console.log('GI quality settings smoke passed: legacy migration, save/restore, partial updates, snapshot parity');

// Detail must reach the actual field API; snap range tracks authored hysteresis.
glue.setSpeedballGiSetting('detail', 0.25);
assert.equal(normalDetail, 0.25);
const snap = glue.SPEEDBALL_GI_NUMERIC_CONTROLS.find(c => c.key === 'snapAmount');
for (const [hysteresis, max] of [[0.99, 0.44], [0.9, 0.35], [0.6, 0.05], [0.5, 0]]) {
    assert.equal(snap.maxFor({ hysteresis }), max);
    const editor = glue.normalizeSpeedballGiSettings({ hysteresis, snapAmount: 0.9 });
    const snapshot = normalize({ speedballGi: { hysteresis, snapAmount: 0.9 } });
    assert.equal(editor.snapAmount, max);
    assert.equal(snapshot.snapAmount, max);
    assert.ok(normalize({ speedballGi: { hysteresis } }).snapAmount <= max);
}
glue.applySpeedballGiState({ hysteresis: 0.99, snapAmount: 0.44 });
glue.setSpeedballGiSetting('hysteresis', 0.6);
assert.equal(glue.getSpeedballGiSettings().snapAmount, 0.05, 'partial hysteresis updates re-clamp snap');
apply(field, { ...restored, detail: 0.75 });
assert.equal(normalDetail, 0.75, 'snapshot uses the same detail API');
console.log('GI slider regression passed: real detail API, dynamic snap range, snapshot migration');

assert.equal(glue.normalizeSpeedballGiSettings({}).autoPadding, 1);
assert.equal(normalize({ speedballGi: {} }).autoPadding, 1);
for (const [input, expected] of [[0, 0], [0.5, 0.5], [2, 2], [-1, 0], [9, 4]]) {
    glue.setSpeedballGiSetting('autoPadding', input);
    assert.equal(autoPadding, expected);
    const state = JSON.parse(JSON.stringify(glue.serializeSpeedballGiState()));
    const snapshot = normalize({ speedballGi: state });
    assert.equal(snapshot.autoPadding, expected);
    apply(field, snapshot);
    assert.equal(autoPadding, expected);
}
assert.equal(glue.formatSpeedballGiValue('autoPadding', 1), '1.00x');
console.log('Auto padding settings passed: bounds, legacy default, field API and snapshot round trip');

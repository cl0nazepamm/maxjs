import assert from 'node:assert/strict';

let nextRaf = 1;
const rafCallbacks = new Map();
globalThis.requestAnimationFrame = (callback) => {
    const id = nextRaf++;
    rafCallbacks.set(id, callback);
    return id;
};
globalThis.cancelAnimationFrame = (id) => rafCallbacks.delete(id);

const { maxTimeline } = await import(`../web/js/maxjs_timeline.js?smoke=${Date.now()}`);
const changes = [];
const transitions = [];
maxTimeline.on('change', (state) => changes.push(state));
maxTimeline.on('play', (state) => transitions.push({ event: 'play', state }));
maxTimeline.on('pause', (state) => transitions.push({ event: 'pause', state }));

for (let frame = 0; frame < 100; frame++) {
    maxTimeline.onTime({ ticks: frame * 160, tpf: 160, stateFlags: 0 });
}

assert.equal(maxTimeline.frame(), 99, 'authoritative paused-scrub state updates synchronously');
assert.equal(changes.length, 0, 'layer subscribers do not run inside transport callbacks');
assert.equal(rafCallbacks.size, 1, '100 paused scrub packets coalesce into one rAF notification');

const [id, callback] = rafCallbacks.entries().next().value;
rafCallbacks.delete(id);
callback(0);
assert.equal(changes.length, 1);
assert.equal(changes[0].frame, 99, 'coalesced notification carries the latest pose');

const beforeSceneSync = maxTimeline.lastUpdateMs();
maxTimeline.noteSceneSync();
assert.ok(maxTimeline.lastUpdateMs() >= beforeSceneSync,
    'geometry delivery extends the interaction/settle clock');

maxTimeline.onTime({ ticks: 16000, tpf: 160, stateFlags: 1 });
maxTimeline.onTime({ ticks: 16160, tpf: 160, stateFlags: 1 });
maxTimeline.onTime({ ticks: 16160, tpf: 160, stateFlags: 0 });
assert.equal(maxTimeline.playing(), false, 'stop is authoritative before notification delivery');
assert.equal(transitions.length, 0, 'play/pause listeners do not run inside onTime');
assert.equal(rafCallbacks.size, 1, 'play/stop burst shares the same latest-state mailbox');

const [stopId, stopCallback] = rafCallbacks.entries().next().value;
rafCallbacks.delete(stopId);
stopCallback(0);
assert.equal(changes.at(-1).playing, false);
assert.equal(changes.at(-1).ticks, 16160);
assert.deepEqual(transitions.map(({ event }) => event), ['play', 'pause'],
    'multiple transitions preserve their authored order after the shared rAF flush');
assert.equal(transitions[0].state.playing, true, 'play carries its captured transition state');
assert.equal(transitions[0].state.ticks, 16000, 'play snapshot is not overwritten by later packets');
assert.equal(transitions[1].state.playing, false, 'pause carries its captured transition state');
assert.equal(transitions[1].state.ticks, 16160, 'pause snapshot captures the stopping tick');

console.log('maxjs-timeline-coalesce-smoke: OK');

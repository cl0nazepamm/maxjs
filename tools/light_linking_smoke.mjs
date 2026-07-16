import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sourceUrl = new URL('../web/js/light_linking_core.js', import.meta.url);
const source = await readFile(sourceUrl, 'utf8');
const core = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const {
    LIGHT_MASK_HI_KEY,
    LIGHT_MASK_LO_KEY,
    LIGHT_MASK_READY_KEY,
    createLightLinkMaskApplier,
    deserializeLightLinks,
    hasActiveLightLinksPayload,
    serializeLightLinks,
} = core;

function light(name) {
    return { name, userData: {} };
}

function mesh(name) {
    return { isMesh: true, name, userData: {} };
}

function makeHarness(lightCount = 1) {
    const lightHandleMap = new Map();
    for (let i = 0; i < lightCount; i++) lightHandleMap.set(i + 1, light(`Light ${i + 1}`));
    const meshes = new Map([
        ['10', mesh('Object A')],
        ['11', mesh('Object B')],
    ]);
    let traversals = 0;
    const applier = createLightLinkMaskApplier({
        lightHandleMap,
        forEachRenderableMesh(fn) {
            traversals++;
            for (const [handle, object] of meshes) fn(handle, object);
        },
    });
    return { lightHandleMap, meshes, applier, get traversals() { return traversals; } };
}

function bit(meshObject, id = 0) {
    const key = id < 32 ? LIGHT_MASK_LO_KEY : LIGHT_MASK_HI_KEY;
    return ((meshObject.userData[key] >>> (id & 31)) & 1) === 1;
}

{
    const h = makeHarness();
    const result = h.applier.apply(new Map());
    assert.equal(result.activeCount, 0);
    assert.equal(h.traversals, 0, 'ordinary lighting must not walk meshes');
    assert.equal(h.lightHandleMap.get(1).userData.maxjsLightLinked, false);
    assert.equal(h.lightHandleMap.get(1).userData.maxjsLightId, -1);
}

{
    const h = makeHarness();
    const result = h.applier.apply(new Map([['1', { mode: 'include', objects: new Set() }]]));
    assert.equal(result.activeCount, 1);
    assert.equal(h.lightHandleMap.get(1).userData.maxjsLightLinked, true);
    assert.equal(h.lightHandleMap.get(1).userData.maxjsLightId, 0);
    for (const object of h.meshes.values()) {
        assert.equal(object.userData[LIGHT_MASK_READY_KEY], 1);
        assert.equal(bit(object), false, 'Include with no objects must be black everywhere');
    }
}

{
    const h = makeHarness();
    h.applier.apply(new Map([['1', { mode: 'exclude', objects: new Set() }]]));
    for (const object of h.meshes.values()) {
        assert.equal(bit(object), true, 'Exclude with no objects must still light everything');
    }
}

{
    const h = makeHarness();
    h.applier.apply(new Map([['1', { mode: 'include', objects: new Set(['10']) }]]));
    assert.equal(bit(h.meshes.get('10')), true);
    assert.equal(bit(h.meshes.get('11')), false);

    h.applier.apply(new Map([['1', { mode: 'exclude', objects: new Set(['10']) }]]));
    assert.equal(bit(h.meshes.get('10')), false);
    assert.equal(bit(h.meshes.get('11')), true);

    h.applier.apply(new Map());
    assert.equal(h.lightHandleMap.get(1).userData.maxjsLightLinked, false, 'None must restore stock lighting');
}

{
    const h = makeHarness();
    h.applier.apply(new Map([['1', { mode: 'include', objects: new Set(['10']) }]]));
    const detached = h.meshes.get('10');
    const staleGeneration = detached.userData[LIGHT_MASK_READY_KEY];
    h.meshes.delete('10');
    const next = h.applier.apply(new Map([['1', { mode: 'include', objects: new Set() }]]));
    assert.notEqual(staleGeneration, next.generation);
    assert.equal((next.defaultLo & 1) !== 0, false, 'stale detached meshes must fall back to Include black');
}

{
    const h = makeHarness(100);
    const result = h.applier.apply(new Map([['100', { mode: 'include', objects: new Set() }]]));
    assert.equal(result.fastCount, 1, 'inactive authored lights must not consume mask slots');
    assert.equal(h.lightHandleMap.get(100).userData.maxjsLightId, 0);
}

{
    const h = makeHarness(65);
    const links = new Map();
    for (let i = 1; i <= 65; i++) links.set(String(i), { mode: 'include', objects: new Set() });
    const result = h.applier.apply(links);
    const overflowLight = h.lightHandleMap.get(65);
    assert.equal(result.fastCount, 64);
    assert.equal(result.overflowCount, 1);
    assert.equal(overflowLight.userData.maxjsLightLinked, true);
    assert.equal(overflowLight.userData.maxjsLightId, -1);
    assert.match(overflowLight.userData.maxjsLightMaskKey, /^maxjsLightMaskExtra/);
    for (const object of h.meshes.values()) {
        assert.equal(object.userData[overflowLight.userData.maxjsLightMaskKey], 0);
    }
    const retiredKey = overflowLight.userData.maxjsLightMaskKey;
    h.applier.apply(new Map());
    h.applier.apply(new Map([['1', { mode: 'exclude', objects: new Set() }]]));
    for (const object of h.meshes.values()) {
        assert.equal(retiredKey in object.userData, false, 'retired overflow fields must be reclaimed');
    }
}

{
    const lightHandleMap = new Map([
        [1, light('Duplicate')],
        [2, light('Duplicate')],
    ]);
    const nodeMap = new Map([
        [10, mesh('Same Name')],
        [11, mesh('Same Name')],
    ]);
    const links = new Map([
        ['1', { mode: 'include', objects: new Set(['10']) }],
        ['2', { mode: 'exclude', objects: new Set(['11']) }],
    ]);
    const payload = serializeLightLinks(links, { lightHandleMap, nodeMap });
    const restored = deserializeLightLinks(payload, { lightHandleMap, nodeMap });

    assert.equal(payload.linkEntries.length, 2);
    assert.deepEqual([...restored.get('1').objects], ['10']);
    assert.deepEqual([...restored.get('2').objects], ['11']);
    assert.equal(restored.get('1').mode, 'include');
    assert.equal(restored.get('2').mode, 'exclude');

    const emptyInclude = serializeLightLinks(
        new Map([['1', { mode: 'include', objects: new Set() }]]),
        { lightHandleMap, nodeMap },
    );
    assert.equal(hasActiveLightLinksPayload(emptyInclude), true);
    assert.equal(deserializeLightLinks(emptyInclude, { lightHandleMap, nodeMap }).get('1').objects.size, 0);

    const lateRuntimeTarget = deserializeLightLinks({
        linkEntries: [{
            lightHandle: '1',
            lightName: 'Duplicate',
            mode: 'include',
            objectHandles: ['999'],
            objectNames: ['Same Name'],
        }],
    }, { lightHandleMap, nodeMap });
    assert.deepEqual(
        [...lateRuntimeTarget.get('1').objects],
        ['999'],
        'v2 handles must survive without rebinding to a same-name base object',
    );

    const lateLight = deserializeLightLinks({
        linkEntries: [{
            lightHandle: '9999',
            lightName: 'Duplicate',
            mode: 'exclude',
            objectHandles: [],
            objectNames: [],
        }],
    }, { lightHandleMap, nodeMap });
    assert.equal(lateLight.has('9999'), true, 'v2 light handles must not rebind by duplicate name');

    const unresolvedLegacyName = deserializeLightLinks({
        links: { Duplicate: { mode: 'include', objects: ['Missing Name'] } },
    }, { lightHandleMap, nodeMap });
    assert.equal(unresolvedLegacyName.get('1').objects.size, 0, 'names-only v1 must still require lookup');
}

console.log('light_linking_smoke: PASS');

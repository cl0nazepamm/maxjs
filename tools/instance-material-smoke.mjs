import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
    instanceGroupHasExactMaterialDescriptor,
    isExactInstanceMaterialDescriptor,
} from '../web/js/instance_batching.js';

const exactModels = [
    'MaterialXMaterial',
    'MeshBackdropNodeMaterial',
    'MeshSSSNodeMaterial',
    'MeshTSLNodeMaterial',
];

for (const model of exactModels) {
    assert.equal(isExactInstanceMaterialDescriptor({ model }), true, model);
}
for (const source of ['tslCode', 'materialXInline', 'materialXFile']) {
    assert.equal(isExactInstanceMaterialDescriptor({
        model: 'MeshStandardMaterial',
        [source]: 'source',
    }), true, source);
}
for (const source of ['mapTSL', 'roughMapHTML']) {
    assert.equal(isExactInstanceMaterialDescriptor({
        model: 'MeshStandardMaterial',
        [source]: 'source',
    }), true, source);
}
assert.equal(isExactInstanceMaterialDescriptor({ model: 'MeshStandardMaterial' }), false);
assert.equal(instanceGroupHasExactMaterialDescriptor({
    mat: { model: 'MeshTSLNodeMaterial' },
}), true);
assert.equal(instanceGroupHasExactMaterialDescriptor({
    groups: Array.from({ length: 9 }, (_, index) => [index * 3, 3, index]),
    mats: [
        { model: 'MeshStandardMaterial' },
        { model: 'MaterialXMaterial' },
    ],
}), true);
assert.equal(instanceGroupHasExactMaterialDescriptor({
    mats: [{ model: 'MeshStandardMaterial' }],
}), false);

for (const relative of ['../web/js/scene_applier.js', '../web/js/editor/scene_extras.js']) {
    const source = await readFile(new URL(relative, import.meta.url), 'utf8');
    assert.match(source, /if \(isExactInstanceMaterialDescriptor\(md\)\) return md;/);
    assert.match(source, /if \(instanceGroupHasExactMaterialDescriptor\(grp\)\) return false;/);
}

const snapshotBoot = await readFile(new URL('../web/js/snapshot_boot.js', import.meta.url), 'utf8');
assert.match(snapshotBoot, /for \(const group of \(meta\?\.forestInstances \?\? \[\]\)\)/);
assert.match(snapshotBoot, /valueReferencesTslTextures\(group\?\.mat\)/);
assert.match(snapshotBoot, /valueReferencesTslTextures\(group\?\.mats\)/);

console.log('OK: exact node/source materials survive WebGPU forest instancing');

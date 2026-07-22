// ── In-place bounds refit for a flattened, threaded BLAS node range ──
//
// spectral_scene.js pools every BLAS into flat bvhNodes/triIndex/vertexData
// buffers (see its header). When a mesh DEFORMS without changing topology
// (streamed vertex buffers, morphs, CPU skinning), the tree STRUCTURE stays
// valid — only the node bounds go stale. This refit rewrites them in place,
// so a deform costs O(verts + nodes) instead of a ~200 ms synchronous
// MeshBVH rebuild on the render thread.
//
// Layout contract (flattenBVHRoot + the pool assembly in spectral_scene.js):
//   • nodes are PRE-ORDER: an interior node's left child is at i+1;
//   • the miss/escape link of the left child IS the right child's index
//     (a node's miss = first slot after its whole subtree, so the left
//     subtree's escape lands exactly on its right sibling);
//   • node stride 8 u32: f32 bounds [minX,minY,minZ,maxX,maxY,maxZ] at +0..5,
//     miss at +6, leaf word at +7 (0xFFFFFFFF = interior, else
//     (triCount << 24) | triOffset with POOL-ABSOLUTE triOffset).
//
// Walking the range in REVERSE therefore visits every child before its
// parent: leaves recompute exact bounds from the (already re-gathered)
// pooled vertices; interiors union their two children. Bounds stay exact
// per refit — they never accumulate slack. Only the PARTITION quality is
// frozen at build-time topology, which for bounded deforms (skinned
// characters, morphs) costs a little traversal efficiency, never
// correctness.
//
// Deliberately dependency-free (no three, no three-mesh-bvh) so node smoke
// tests can exercise the walk without a browser or installed peers.
//
// Returns false — WITHOUT finishing the write — if the threaded-layout
// invariant is violated (right child outside (left, end)); the caller must
// treat that as "layout drifted, full rebuild required", matching
// flattenBVHRoot's fail-loudly policy.
export function refitFlatBlasRange({ nodesF, nodesU, triIndex, vertexData, root, end, nodeStrideU32 = 8, vertexDataStride = 8 }) {
    for (let i = end - 1; i >= root; i--) {
        const base = i * nodeStrideU32;
        const info = nodesU[base + 7];
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        if (info !== 0xFFFFFFFF) {
            const triOff = info & 0x00FFFFFF;
            const triCnt = info >>> 24;
            if (triCnt === 0) continue; // MeshBVH never emits empty leaves; keep stale bounds over ±Infinity
            for (let t = triOff, tEnd = triOff + triCnt; t < tEnd; t++) {
                const t3 = t * 3;
                for (let k = 0; k < 3; k++) {
                    const dd = triIndex[t3 + k] * vertexDataStride;
                    const x = vertexData[dd], y = vertexData[dd + 1], z = vertexData[dd + 2];
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                    if (z < minZ) minZ = z;
                    if (z > maxZ) maxZ = z;
                }
            }
        } else {
            const l = i + 1;
            if (l >= end) return false;
            const r = nodesU[l * nodeStrideU32 + 6]; // threaded: left child's escape IS the right child
            if (!(r > l && r < end)) return false;   // layout drifted → caller must full-rebuild
            const lb = l * nodeStrideU32, rb = r * nodeStrideU32;
            minX = Math.min(nodesF[lb], nodesF[rb]);
            minY = Math.min(nodesF[lb + 1], nodesF[rb + 1]);
            minZ = Math.min(nodesF[lb + 2], nodesF[rb + 2]);
            maxX = Math.max(nodesF[lb + 3], nodesF[rb + 3]);
            maxY = Math.max(nodesF[lb + 4], nodesF[rb + 4]);
            maxZ = Math.max(nodesF[lb + 5], nodesF[rb + 5]);
        }
        nodesF[base] = minX;
        nodesF[base + 1] = minY;
        nodesF[base + 2] = minZ;
        nodesF[base + 3] = maxX;
        nodesF[base + 4] = maxY;
        nodesF[base + 5] = maxZ;
    }
    return true;
}

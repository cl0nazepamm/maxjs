// Viewport-texture clone reaper. r185 ViewportTextureNode keeps a
// WeakMap<RenderTarget, FramebufferTexture> and silently clones a full-res
// framebuffer copy for EVERY render target it is sampled in — but never
// disposes the clones. Every pipeline rebuild retires the pre/scene pass
// targets, stranding one GPU copy per viewport node per dead target (~37MB
// each at 4K-ish sizes; this was the DOF-slider VRAM leak, 2026-07-23).
// Any glue that mints a viewport texture node must register it here;
// fx/core calls purgeViewportCachesForTarget() for each render target it
// disposes. Registration is WeakRef-based so dead nodes stay collectable.
import { RenderTarget } from 'three';
import { viewportLinearDepth, viewportMipTexture, viewportOpaqueMipTexture } from 'three/tsl';

const refs = new Set();
const registeredNodes = new WeakSet();

export function registerViewportNode(node) {
    if (node && !registeredNodes.has(node)) {
        registeredNodes.add(node);
        refs.add(new WeakRef(node));
    }
    return node;
}

// Three also owns private ViewportTextureNode singletons (notably the
// back-side transmission buffer) that cannot be imported and registered by
// name. Auto-register the cache owner whenever any viewport node resolves a
// reference so those private framebuffer clones follow RenderTarget disposal.
try {
    const viewportPrototype = Object.getPrototypeOf(viewportMipTexture());
    const patchKey = Symbol.for('maxjs.viewportRegistry.autoRegister');
    if (viewportPrototype?.getTextureForReference && !viewportPrototype[patchKey]) {
        const baseGetTextureForReference = viewportPrototype.getTextureForReference;
        viewportPrototype.getTextureForReference = function (reference = null) {
            const cacheOwner = this.referenceNode ?? this;
            if (cacheOwner?._cacheTextures) registerViewportNode(cacheOwner);
            return baseGetTextureForReference.call(this, reference);
        };
        Object.defineProperty(viewportPrototype, patchKey, { value: true });
    }
} catch (_) { /* viewport node shape changed — named registrations remain */ }

// Built-in module-level singletons with the same per-target clone cache:
// - the opaque viewport texture sampled by transmissive node materials
//   (viewportOpaqueMipTexture's base node)
// - the ViewportDepthTextureNode inside viewportLinearDepth (its clones are
//   the stray DepthTextures — full-res, or 1x1 when the target died before
//   the first resize)
try {
    const opaqueBase = viewportOpaqueMipTexture()?.referenceNode;
    if (opaqueBase?._cacheTextures) registerViewportNode(opaqueBase);
} catch (_) { /* singleton shape changed — nothing to reap */ }
try {
    const depthTexNode = viewportLinearDepth?.valueNode;
    if (depthTexNode?._cacheTextures) registerViewportNode(depthTexNode);
} catch (_) { /* singleton shape changed — nothing to reap */ }

export function purgeViewportCachesForTarget(renderTarget) {
    if (!renderTarget || !renderTarget.isRenderTarget) return;
    for (const ref of refs) {
        const node = ref.deref();
        if (!node) { refs.delete(ref); continue; }
        const cache = node._cacheTextures;
        if (!cache || typeof cache.get !== 'function') continue;
        const clone = cache.get(renderTarget);
        if (clone) {
            try { clone.dispose(); } catch (_) { /* best effort */ }
            cache.delete(renderTarget);
        }
    }
}

// Not every retiring target flows through fx/core disposal — effect nodes
// (TRAA and friends) dispose their internal render targets privately, and
// the scene renders into some of those, so viewport clones key on them too.
// Hook the base dispose so ANY dying target reaps its clones.
const baseRenderTargetDispose = RenderTarget.prototype.dispose;
RenderTarget.prototype.dispose = function () {
    purgeViewportCachesForTarget(this);
    return baseRenderTargetDispose.call(this);
};

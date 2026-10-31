// PMREMGenerator returns a render target. Disposing only its texture frees
// nothing: three attaches no dispose listener to render-target textures. Wrap
// the texture so dispose() releases the whole target, letting callers treat a
// PMREM environment map as a plain texture.
export function retainPMREMTexture(renderTarget) {
    const texture = renderTarget?.texture ?? null;
    if (!texture) {
        renderTarget?.dispose?.();
        return null;
    }
    texture.userData ??= {};
    if (!texture.userData.maxjsPMREMDisposeWrapped) {
        let disposed = false;
        const originalDispose = texture.dispose?.bind(texture);
        texture.dispose = () => {
            if (disposed) return;
            disposed = true;
            const target = texture.userData?.maxjsPMREMRenderTarget;
            if (target) target.dispose?.();
            else originalDispose?.();
            if (texture.userData) {
                delete texture.userData.maxjsPMREMRenderTarget;
                delete texture.userData.maxjsPMREMDisposeWrapped;
            }
        };
        texture.userData.maxjsPMREMDisposeWrapped = true;
    }
    texture.userData.maxjsPMREMRenderTarget = renderTarget;
    return texture;
}

// texture_pipeline.js - bitmap, video, TSL, MaterialX, bake, and HTML texture loading.
import * as THREE from 'three';
import * as THREE_STD from 'three-std';
import { MaterialXLoader } from 'three/addons/loaders/MaterialXLoader.js';
import { createTSLCompiler, makeBakeNodeToTexture } from '../tsl_materials.js';
import { getOrCreateHTMLTexture } from '../html_texture.js';
import {
    applyTextureChannelSelection as applyTextureChannelSelectionShared,
    applyTextureTransform as applyTextureTransformShared,
    applyTextureUvChannel as applyTextureUvChannelShared,
    maxMapChannelFromMapName as maxMapChannelFromMapNameShared,
    maxMapChannelToTextureChannel as maxMapChannelToTextureChannelShared,
    normalizeTextureTransform as normalizeTextureTransformShared,
    optimizedTextureTransformForSlot as optimizedTextureTransformForSlotShared,
    resolveLightMapMaxMapChannel as resolveLightMapMaxMapChannelShared,
    resolveTextureColorSpace as resolveTextureColorSpaceShared,
} from '../material_contract.js';

async function createTexturePipeline(deps = {}) {
        const {
            TSL,
            fallbackWhiteTexture,
            isFiniteArray,
            rememberMaterialEmissiveBase = () => {},
        } = deps;
        const textureCache = new Map();
        const failedTextureCache = new Set();
        const materialXLoadCache = new Map();


        function normalizeTextureTransform(xf) {
            return normalizeTextureTransformShared(xf);
        }

        function applyTextureTransform(tex, xf) {
            return applyTextureTransformShared(tex, xf);
        }

        function applyFallbackImage(tex, fallbackTex, colorSpace, xf, url) {
            tex.image = fallbackTex.image;
            tex.colorSpace = colorSpace;
            applyTextureTransform(tex, xf);
            tex.needsUpdate = true;
            console.warn('max.js missing texture, using fallback:', url);
        }

        function configureGradientTexture(tex) {
            if (!tex) return null;
            tex.colorSpace = THREE.NoColorSpace;
            tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
            tex.minFilter = tex.magFilter = THREE.NearestFilter;
            tex.generateMipmaps = false;
            tex.needsUpdate = true;
            return tex;
        }

        function applyTextureChannelSelection(tex, xf) {
            return applyTextureChannelSelectionShared(tex, xf);
        }

        function maxMapChannelToTextureChannel(maxMapChannel, fallbackMaxChannel = 1) {
            return maxMapChannelToTextureChannelShared(maxMapChannel, fallbackMaxChannel);
        }

        function maxMapChannelFromMapName(value, fallbackMaxChannel = 2) {
            return maxMapChannelFromMapNameShared(value, fallbackMaxChannel);
        }

        function applyTextureUvChannel(tex, maxMapChannel, fallbackMaxChannel = 1) {
            return applyTextureUvChannelShared(tex, maxMapChannel, fallbackMaxChannel);
        }

        const textureUvChannelViews = new WeakMap();

        function textureWithUvChannel(tex, maxMapChannel, fallbackMaxChannel = 1) {
            if (!tex?.isTexture) return tex;
            const channel = maxMapChannelToTextureChannel(maxMapChannel, fallbackMaxChannel);
            if (tex.channel === channel) return tex;

            let byChannel = textureUvChannelViews.get(tex);
            if (!byChannel) {
                byChannel = new Map();
                textureUvChannelViews.set(tex, byChannel);
            }
            let view = byChannel.get(channel);
            if (!view) {
                view = tex.clone();
                view.userData = { ...(tex.userData || {}), maxjsUvChannelViewOf: tex.uuid };
                byChannel.set(channel, view);
            }
            view.channel = channel;
            view.needsUpdate = true;
            return view;
        }

        // Shared with the snapshot builder — see material_contract.js.
        const resolveLightMapMaxMapChannel = resolveLightMapMaxMapChannelShared;

        function withMaxMapChannelOverride(xf, maxMapChannel) {
            if (!Number.isFinite(Number(maxMapChannel))) return xf;
            const uvChannel = Math.max(1, Math.round(Number(maxMapChannel)));
            return { ...((xf && typeof xf === 'object') ? xf : {}), uvChannel };
        }

        function optimizedTextureTransformForSlot(key, xf) {
            return optimizedTextureTransformForSlotShared(key, xf);
        }

        function resolveColorSpace(slotColorSpace, xf) {
            return resolveTextureColorSpaceShared(slotColorSpace, xf);
        }

        function isAbsoluteWindowsPath(path) {
            return /^[a-zA-Z]:[\\/]/.test(path) || /^\\\\/.test(path);
        }

        function toAssetUrl(filePath) {
            const normalized = String(filePath ?? '').replace(/\\/g, '/');
            const segments = normalized.split('/').filter((segment, index) => segment.length > 0 || index === 0);
            const encoded = segments.map(segment => encodeURIComponent(segment)).join('/');
            return `https://maxjs-assets.local/${encoded}`;
        }

        function normalizeMaterialXResourceUrl(url) {
            const value = String(url ?? '').trim();
            if (!value) return value;
            if (/^(?:data:|blob:|https?:)/i.test(value)) return value;
            if (isAbsoluteWindowsPath(value)) return toAssetUrl(value);
            return value.replace(/\\/g, '/');
        }

        function pickMaterialXMaterial(materials, md) {
            const entries = Object.entries(materials ?? {});
            if (!entries.length) return null;

            const requestedName = String(md.materialXName ?? '').trim();
            if (requestedName) {
                const namedEntry = entries.find(([name]) => name === requestedName);
                if (namedEntry) return namedEntry[1];
            }

            const requestedIndex = Number.isFinite(md.materialXIndex)
                ? Math.max(1, Math.round(md.materialXIndex))
                : 1;
            return entries[Math.min(entries.length - 1, requestedIndex - 1)][1];
        }

        function createPendingMaterialXMaterial(md) {
            const material = new THREE.MeshPhysicalNodeMaterial({
                color: new THREE.Color(md.color[0], md.color[1], md.color[2]),
                roughness: md.rough ?? 0.5,
                metalness: md.metal ?? 0.0,
                side: md.side === 0 ? THREE.FrontSide : THREE.DoubleSide,
            });

            if (md.opacity != null && md.opacity < 0.999) {
                material.transparent = true;
                material.opacity = md.opacity;
            }

            material.userData ??= {};
            material.userData.maxjsMaterialXPending = true;
            material.needsUpdate = true;
            return material;
        }

        function normalizeMaterialXDocument(text) {
            const source = String(text ?? '');
            if (!source.trim()) return source;

            const parser = new DOMParser();
            const doc = parser.parseFromString(source, 'application/xml');
            if (doc.querySelector('parsererror')) return source;

            const hasNamedChild = (node, name) => Array.from(node.children).some(child => child.getAttribute('name') === name);
            const appendElement = (node, tagName, attrs) => {
                const child = doc.createElement(tagName);
                for (const [key, value] of Object.entries(attrs)) child.setAttribute(key, value);
                node.appendChild(child);
            };

            const ensureNamedChild = (selector, name, tagName, attrs) => {
                for (const node of doc.querySelectorAll(selector)) {
                    if (!hasNamedChild(node, name)) appendElement(node, tagName, { name, ...attrs });
                }
            };

            // Max's MaterialX export can omit the procedural coordinate input,
            // while Three's MaterialXLoader only wires what is explicitly present.
            ensureNamedChild('noise2d, cellnoise2d, worleynoise2d, unifiednoise2d', 'texcoord', 'texcoord', { type: 'vector2' });
            ensureNamedChild('noise3d, cellnoise3d, worleynoise3d, unifiednoise3d', 'texcoord', 'position', { type: 'vector3' });
            ensureNamedChild('fractal3d', 'position', 'position', { type: 'vector3' });
            // image: loader does texture(file, texcoord) — missing texcoord => broken sampling.
            ensureNamedChild('image', 'texcoord', 'texcoord', { type: 'vector2' });
            // tiledimage: mx_transform_uv(uvtiling, uvoffset); both must exist or the spread is empty.
            ensureNamedChild('tiledimage', 'uvtiling', 'input', { type: 'vector2', value: '1, 1' });
            ensureNamedChild('tiledimage', 'uvoffset', 'input', { type: 'vector2', value: '0, 0' });

            // Max exports emission=1.0 even when emission_color is black — force emission to 0
            for (const ss of doc.querySelectorAll('standard_surface')) {
                const emissionInput = Array.from(ss.children).find(c => c.getAttribute('name') === 'emission');
                const emColorInput = Array.from(ss.children).find(c => c.getAttribute('name') === 'emission_color');
                if (emissionInput && !emColorInput) {
                    // No emission color means it defaults to black — zero out emission weight
                    emissionInput.setAttribute('value', '0');
                } else if (emissionInput && emColorInput && !emColorInput.getAttribute('nodename')) {
                    const val = emColorInput.getAttribute('value') || '0, 0, 0';
                    const parts = val.split(',').map(v => parseFloat(v.trim()));
                    if (parts.every(v => v < 0.001)) {
                        emissionInput.setAttribute('value', '0');
                    }
                }
            }

            // If Max exports a standard_surface or gltf_pbr without a <surfacematerial> wrapper,
            // inject one so the loader creates MeshPhysicalNodeMaterial instead of unlit MeshBasicNodeMaterial.
            const root = doc.documentElement;
            if (!root.querySelector('surfacematerial')) {
                const shaderNode = root.querySelector('standard_surface, gltf_pbr');
                if (shaderNode) {
                    const shaderName = shaderNode.getAttribute('name') || 'SR_default';
                    const smName = shaderName + '_material';
                    // Only wrap if not already inside a surfacematerial
                    if (!shaderNode.closest('surfacematerial')) {
                        const sm = doc.createElement('surfacematerial');
                        sm.setAttribute('name', smName);
                        sm.setAttribute('type', 'material');
                        const inp = doc.createElement('input');
                        inp.setAttribute('name', 'surfaceshader');
                        inp.setAttribute('type', 'surfaceshader');
                        inp.setAttribute('nodename', shaderName);
                        sm.appendChild(inp);
                        root.appendChild(sm);
                    }
                }
            }

            // Fix unconnected <output> nodes with default values — Three.js loader can't handle them.
            // Convert: <output name="X" type="T" value="V"/> → <constant name="X_const" type="T" value="V"/>
            // and rewire the output to point at the constant node.
            for (const output of doc.querySelectorAll('output[value]')) {
                if (output.getAttribute('nodename')) continue; // already connected
                const name = output.getAttribute('name');
                const type = output.getAttribute('type');
                const value = output.getAttribute('value');
                if (!name || !type || !value) continue;
                const constName = `${name}_const`;
                const parent = output.parentNode;
                const constant = doc.createElement('constant');
                constant.setAttribute('name', constName);
                constant.setAttribute('type', type);
                const valInput = doc.createElement('input');
                valInput.setAttribute('name', 'value');
                valInput.setAttribute('type', type);
                valInput.setAttribute('value', value);
                constant.appendChild(valInput);
                parent.insertBefore(constant, output);
                output.removeAttribute('value');
                output.setAttribute('nodename', constName);
            }

            return new XMLSerializer().serializeToString(doc);
        }

        function applyLoadedMaterialXTemplate(target, source, md) {
            target.copy(source);
            for (const key of Object.keys(source)) {
                if (key.endsWith('Node')) target[key] = source[key];
            }
            target.name = source.name || target.name;
            target.side = md.side === 0 ? THREE.FrontSide : THREE.DoubleSide;
            target.userData ??= {};
            target.userData.maxjsMaterialXPending = false;
            target.userData.maxjsMaterialXSourceName = source.name || '';
            rememberMaterialEmissiveBase(target);
            target.needsUpdate = true;
        }

        function applyLoadedTSLTemplate(target, source, md) {
            target.copy(source);
            for (const key of Object.keys(source)) {
                if (key.endsWith('Node')) target[key] = source[key];
            }
            target.name = source.name || target.name;
            target.side = md.side === 0 ? THREE.FrontSide : THREE.DoubleSide;
            target.userData ??= {};
            target.userData.maxjsMaterialXPending = false;
            target.userData.maxjsMaterialXFallback = true;
            rememberMaterialEmissiveBase(target);
            target.needsUpdate = true;
        }

        async function ensureMaterialXTemplateLoaded(cacheKey, template, md) {
            if (!md.materialXFile && !md.materialXInline) return template;

            let pending = materialXLoadCache.get(cacheKey);
            if (pending) return pending;

            const materialXBase = md.materialXBase || '';
            const isDataTextureUrl = (url) => {
                const lower = String(url || '').toLowerCase();
                return (
                    lower.includes('normal') ||
                    lower.includes('rough') ||
                    lower.includes('metal') ||
                    lower.includes('orm') ||
                    lower.includes('ao') ||
                    lower.includes('occlusion') ||
                    lower.includes('height') ||
                    lower.includes('displace') ||
                    lower.includes('displacement') ||
                    lower.includes('bump') ||
                    lower.includes('mask')
                );
            };
            const manager = new THREE.LoadingManager();
            manager.setURLModifier(url => {
                const normalized = normalizeMaterialXResourceUrl(url);
                if (materialXBase && !/^(?:data:|blob:|https?:)/i.test(normalized)) {
                    return materialXBase + (materialXBase.endsWith('/') ? '' : '/') + normalized;
                }
                return normalized;
            });
            manager.onError = url => console.error('[MaterialX] Failed to load:', url);

            // ImageBitmapLoader can produce blank textures in WebView2 virtual hosts.
            // Use a handler that loads via HTMLImageElement instead.
            const imgLoader = {
                load(url, onLoad, onProgress, onError) {
                    const resolvedUrl = manager.resolveURL(url);
                    const img = new Image();
                    img.crossOrigin = 'anonymous';
                    img.onload = () => { manager.itemEnd(resolvedUrl); if (onLoad) onLoad(img); };
                    img.onerror = (e) => { manager.itemEnd(resolvedUrl); manager.itemError(resolvedUrl); if (onError) onError(e); };
                    manager.itemStart(resolvedUrl);
                    img.src = resolvedUrl;
                }
            };
            // EXRLoader returns DataTexture; mark likely utility maps as raw data.
            const exrHandler = {
                load(url, onLoad, onProgress, onError) {
                    const resolvedUrl = manager.resolveURL(url);
                    manager.itemStart(resolvedUrl);
                    deps.exrLoader.load(resolvedUrl,
                        (texture) => {
                            texture.colorSpace = isDataTextureUrl(resolvedUrl)
                                ? THREE.NoColorSpace
                                : THREE.LinearSRGBColorSpace;
                            manager.itemEnd(resolvedUrl);
                            if (onLoad) onLoad(texture);
                        },
                        onProgress,
                        (e) => { manager.itemEnd(resolvedUrl); manager.itemError(resolvedUrl); if (onError) onError(e); }
                    );
                }
            };
            manager.addHandler(/\.exr$/i, exrHandler);
            manager.addHandler(/\./, imgLoader);

            const loader = new MaterialXLoader(manager);
            // Don't call loader.setPath() — URLModifier already handles materialXBase

            // Get MaterialX XML — either from inline string or file fetch
            const getXml = md.materialXInline
                ? Promise.resolve(md.materialXInline)
                : fetch(md.materialXFile, { cache: 'no-store' })
                    .then(response => {
                        if (!response.ok) {
                            throw new Error(`MaterialX fetch failed: ${response.status} ${response.statusText}`);
                        }
                        return response.text();
                    });

            pending = getXml
                .then(text => loader.parse(normalizeMaterialXDocument(text)))
                .then(({ materials }) => {
                    const loadedMaterial = pickMaterialXMaterial(materials, md);
                    if (!loadedMaterial) {
                        throw new Error(`No MaterialX material resolved for ${md.materialXFile || 'inline'}`);
                    }

                    applyLoadedMaterialXTemplate(template, loadedMaterial, md);
                    return template;
                })
                .catch(error => {
                    console.error('[MaterialX] Load failed:', error);
                    if (md.model === 'MeshTSLNodeMaterial' && md.tslCode) {
                        try {
                            const fallback = tslCompiler.createTSLMaterial({
                                ...md,
                                materialXFile: '',
                                materialXInline: '',
                                materialXBase: '',
                                materialXName: '',
                                materialXIndex: 1,
                            });
                            applyLoadedTSLTemplate(template, fallback, md);
                            deps.maxjsDebugWarn('[MaterialX] Falling back to TSL code for MeshTSLNodeMaterial');
                            return template;
                        } catch (fallbackError) {
                            console.error('[MaterialX] TSL fallback failed:', fallbackError);
                        }
                    }
                    template.color?.set?.(0xff00ff);
                    template.wireframe = true;
                    template.userData ??= {};
                    template.userData.maxjsMaterialXPending = false;
                    template.needsUpdate = true;
                    return template;
                })
                .finally(() => {
                    materialXLoadCache.delete(cacheKey);
                });

            materialXLoadCache.set(cacheKey, pending);
            return pending;
        }

        function canUploadVideoFrame(video) {
            return !!video &&
                !video.error &&
                !video.seeking &&
                video.readyState >= video.HAVE_CURRENT_DATA &&
                video.videoWidth > 0 &&
                video.videoHeight > 0;
        }

        function installSafeVideoTexturePump(tex, video) {
            if (!tex || !video) return;
            let disposed = false;
            let frameCallbackId = 0;
            if (tex.source) tex.source.dataReady = false;

            if (tex._requestVideoFrameCallbackId &&
                typeof video.cancelVideoFrameCallback === 'function') {
                try { video.cancelVideoFrameCallback(tex._requestVideoFrameCallbackId); } catch {}
                tex._requestVideoFrameCallbackId = 0;
            }

            const markReadyFrame = () => {
                if (!canUploadVideoFrame(video)) return;
                if (tex.source) tex.source.dataReady = true;
                tex.needsUpdate = true;
            };

            tex.update = markReadyFrame;

            const scheduleFrameCallback = () => {
                if (disposed || typeof video.requestVideoFrameCallback !== 'function') return;
                frameCallbackId = video.requestVideoFrameCallback(() => {
                    frameCallbackId = 0;
                    markReadyFrame();
                    scheduleFrameCallback();
                });
                tex._requestVideoFrameCallbackId = frameCallbackId;
            };

            const onReady = () => {
                markReadyFrame();
                if (!frameCallbackId) scheduleFrameCallback();
            };
            const onNotReady = () => {
                if (tex.source) tex.source.dataReady = false;
            };

            video.addEventListener('loadeddata', onReady);
            video.addEventListener('canplay', onReady);
            video.addEventListener('playing', onReady);
            video.addEventListener('seeked', onReady);
            video.addEventListener('seeking', onNotReady);
            video.addEventListener('waiting', onNotReady);
            video.addEventListener('stalled', onNotReady);

            const disposeBase = tex.dispose.bind(tex);
            tex.dispose = () => {
                disposed = true;
                video.removeEventListener('loadeddata', onReady);
                video.removeEventListener('canplay', onReady);
                video.removeEventListener('playing', onReady);
                video.removeEventListener('seeked', onReady);
                video.removeEventListener('seeking', onNotReady);
                video.removeEventListener('waiting', onNotReady);
                video.removeEventListener('stalled', onNotReady);
                if (frameCallbackId && typeof video.cancelVideoFrameCallback === 'function') {
                    try { video.cancelVideoFrameCallback(frameCallbackId); } catch {}
                }
                frameCallbackId = 0;
                tex._requestVideoFrameCallbackId = 0;
                disposeBase();
            };

            onReady();
        }

        function loadVideoTexture(url, xf, colorSpace = THREE.SRGBColorSpace) {
            const normalizedXf = normalizeTextureTransform(xf);
            const playbackKey = JSON.stringify({
                loop: xf?.loop !== false,
                muted: xf?.muted !== false,
                rate: xf?.rate ?? 1.0,
            });
            // Distinct UV transforms must not clobber a shared cached texture.
            const cacheKey = `video:${url}:${playbackKey}:${JSON.stringify(normalizedXf)}`;
            if (textureCache.has(cacheKey)) return textureCache.get(cacheKey);
            const video = document.createElement('video');
            video.crossOrigin = 'anonymous';
            video.loop = xf?.loop !== false;
            video.muted = xf?.muted !== false;
            video.playbackRate = xf?.rate ?? 1.0;
            video.playsInline = true;
            video.autoplay = true;
            video.preload = 'auto';
            video.src = url;
            video.load?.();
            video.play().catch(() => {});
            const tex = new THREE.VideoTexture(video);
            // Slot-driven, matching the snapshot builder: a video in a
            // normal/roughness/opacity slot is data and must stay linear.
            tex.colorSpace = colorSpace;
            tex.minFilter = THREE.LinearFilter;
            tex.magFilter = THREE.LinearFilter;
            installSafeVideoTexturePump(tex, video);
            // Honor Max UV tiling/offset/rotation/wrap + channel select, the
            // same as still-image textures (loadTexture) — video previously
            // ignored all of these.
            applyTextureChannelSelection(tex, normalizedXf);
            applyTextureTransform(tex, normalizedXf);
            textureCache.set(cacheKey, tex);
            return tex;
        }

        function loadTexture(url, colorSpace = THREE.LinearSRGBColorSpace, xf = null, fallbackTex = fallbackWhiteTexture) {
            if (!url) return null;
            colorSpace = resolveColorSpace(colorSpace, xf);
            if (xf?.video) return loadVideoTexture(url, xf, colorSpace);
            const ext = deps.getTextureExtension(url);
            // A plain Max Bitmap can point straight at a video file (no custom
            // Video Texture map). Route those to the video loader instead of
            // rejecting them as an unsupported still-image format.
            if (deps.isVideoTextureExtension(ext)) return loadVideoTexture(url, xf, colorSpace);
            const textureColorSpace = deps.colorSpaceForTextureExtension(ext, colorSpace);
            const normalizedXf = normalizeTextureTransform(xf);
            const cacheKey = JSON.stringify([url, String(textureColorSpace), normalizedXf]);
            if (textureCache.has(cacheKey)) return textureCache.get(cacheKey);
            if (!deps.canBrowserLoadTextureExtension(ext)) {
                const placeholder = fallbackTex || fallbackWhiteTexture;
                textureCache.set(cacheKey, placeholder);
                console.warn('max.js skipped unsupported browser texture format:', url);
                return placeholder;
            }
            if (ext === 'exr' || ext === 'hdr') {
                const loader = ext === 'exr' ? deps.exrLoader : deps.rgbeLoader;
                const placeholder = fallbackTex || fallbackWhiteTexture;
                textureCache.set(cacheKey, placeholder);
                deps.beginTextureLoad();
                loader.load(url, loadedTex => {
                    deps.endTextureLoad();
                    // colorSpace first: channel selection needs it to decide
                    // whether Output LUTs run through sRGB decode/encode.
                    loadedTex.colorSpace = textureColorSpace;
                    applyTextureChannelSelection(loadedTex, normalizedXf);
                    applyTextureTransform(loadedTex, normalizedXf);
                    loadedTex.needsUpdate = true;
                    textureCache.set(cacheKey, loadedTex);
                    if (deps.bakeOverrides.enabled) deps.reapplyBakeOverridesToScene?.();
                    deps.maxjsFx.markOutputChanged?.();
                }, undefined, () => {
                    deps.endTextureLoad();
                });
                return placeholder;
            }
            deps.beginTextureLoad();
            const tex = deps.textureLoader.load(
                url,
                loadedTex => {
                    deps.endTextureLoad();
                    loadedTex.colorSpace = textureColorSpace;
                    applyTextureChannelSelection(loadedTex, normalizedXf);
                    applyTextureTransform(loadedTex, normalizedXf);
                    loadedTex.needsUpdate = true;
                },
                undefined,
                () => {
                    deps.endTextureLoad();
                    applyFallbackImage(tex, fallbackTex, textureColorSpace, normalizedXf, url);
                }
            );
            tex.colorSpace = textureColorSpace;
            applyTextureTransform(tex, normalizedXf);
            textureCache.set(cacheKey, tex);
            return tex;
        }

        // Shared TSL material/texture compiler (extracted to js/tsl_materials.js so the
        // standalone snapshot path can run the exact same code). The vendored tsl-textures
        // namespace and the node->texture bake helper are wired in lazily below.
        const tslCompiler = createTSLCompiler({
            THREE,
            TSL,
            loadTexture,
            textureCache,
            debugWarn: deps.maxjsDebugWarn,
            // Bake TSL color nodes (bitmap presets) into textures; redraw when ready.
            bakeNodeToTexture: makeBakeNodeToTexture(deps.renderer, THREE, {
                onComplete: () => deps.maxjsFx.markOutputChanged?.(),
            }),
        });
        // Load the procedural-texture preset library before materials can compile
        // so first-use preset snippets resolve the injected TEXTURES namespace.
        await import('tsl-textures')
            .then((ns) => tslCompiler.setTextures(ns))
            .catch(() => { /* only present when tsl-textures presets are used */ });

        function isWebGLTexturePathActive() {
            const label = String(deps.rendererBackendLabel || '');
            return !!deps.renderer?.isWebGLRenderer || label.startsWith('WebGL') || label === 'TSL_GL';
        }

        function prepareLoadedBakeTexture(loadedTex, colorSpace, maxMapChannel) {
            if (!loadedTex?.isTexture) return null;
            let tex = loadedTex;
            if (isWebGLTexturePathActive() && loadedTex.isDataTexture && loadedTex.image?.data) {
                const image = loadedTex.image;
                tex = new THREE_STD.DataTexture(image.data, image.width, image.height);
                tex.format = loadedTex.format;
                tex.type = loadedTex.type;
                tex.mapping = loadedTex.mapping;
                tex.wrapS = loadedTex.wrapS;
                tex.wrapT = loadedTex.wrapT;
                tex.magFilter = loadedTex.magFilter;
                tex.minFilter = loadedTex.minFilter;
                tex.generateMipmaps = loadedTex.generateMipmaps;
                tex.flipY = loadedTex.flipY;
                tex.unpackAlignment = loadedTex.unpackAlignment;
            }
            tex.colorSpace = colorSpace;
            applyTextureUvChannel(tex, maxMapChannel, 2);
            tex.needsUpdate = true;
            return tex;
        }

        function loadBakeTexture(url, colorSpace = THREE.LinearSRGBColorSpace, maxMapChannel = 2) {
            if (!url) return null;
            colorSpace = resolveColorSpace(colorSpace, null);
            const ext = deps.getTextureExtension(url);
            const textureColorSpace = deps.colorSpaceForTextureExtension(ext, colorSpace);
            const channel = maxMapChannelToTextureChannel(maxMapChannel, 2);
            const cacheKey = JSON.stringify(['bake', url, String(textureColorSpace), channel]);
            const cached = textureCache.get(cacheKey);
            if (cached?.isTexture) return cached;
            if (cached?.pending) return null;
            if (failedTextureCache.has(cacheKey)) return null;

            if (!deps.canBrowserLoadTextureExtension(ext)) {
                failedTextureCache.add(cacheKey);
                console.warn('max.js skipped unsupported bake texture format:', url);
                return null;
            }

            const loader = ext === 'exr'
                ? deps.exrLoader
                : (ext === 'hdr' ? deps.rgbeLoader : (isWebGLTexturePathActive() ? deps.webglTextureLoader : deps.textureLoader));
            textureCache.set(cacheKey, { pending: true });
            loader.load(
                url,
                loadedTex => {
                    const bakeTex = prepareLoadedBakeTexture(loadedTex, textureColorSpace, maxMapChannel);
                    if (!bakeTex) {
                        failedTextureCache.add(cacheKey);
                        textureCache.delete(cacheKey);
                        return;
                    }
                    failedTextureCache.delete(cacheKey);
                    textureCache.set(cacheKey, bakeTex);
                    if (deps.bakeOverrides.enabled) deps.reapplyBakeOverridesToScene?.();
                    deps.maxjsFx.markOutputChanged?.();
                },
                undefined,
                () => {
                    failedTextureCache.add(cacheKey);
                    textureCache.delete(cacheKey);
                    if (deps.bakeOverrides.enabled) deps.reapplyBakeOverridesToScene?.();
                    deps.maxjsFx.markOutputChanged?.();
                }
            );
            return null;
        }

        function loadBakeTextureFromCandidates(candidates, colorSpace = THREE.LinearSRGBColorSpace) {
            let selected = null;
            for (const candidate of candidates || []) {
                const tex = loadBakeTexture(candidate.url, colorSpace, candidate.maxMapChannel);
                if (tex && !selected) selected = { ...candidate, texture: tex };
            }
            return selected;
        }

        function bakeExposureScale() {
            const scale = deps.bakeOverrides.intensity * Math.pow(2, deps.bakeOverrides.bakeExposure);
            return Number.isFinite(scale) ? Math.max(0, scale) : 1;
        }

        function isDisplayBakedBeautyProxy(url = '') {
            if (deps.bakeOverrides.proxyDisplay !== true || deps.bakeOverrides.mode !== 'beauty') return false;
            const ext = deps.getTextureExtension(url);
            return ext !== 'exr' && ext !== 'hdr';
        }

        function clearBakeTextureLoadFailures() {
            for (const key of [...failedTextureCache]) {
                if (String(key).startsWith('["bake",')) failedTextureCache.delete(key);
            }
            for (const [key, value] of [...textureCache]) {
                if (String(key).startsWith('["bake",') && value?.pending) textureCache.delete(key);
            }
        }

        // TSL texture/material compile moved to js/tsl_materials.js (tslCompiler.evalTSLTexture).

        const HTML_TEXTURE_AUTO_FIT_KEYS = [
            'map', 'opMap', 'emMap', 'roughMap', 'metalMap', 'normMap',
            'bumpMap', 'dispMap', 'parallaxMap', 'aoMap', 'lmMap',
            'gradMap', 'sssMap', 'matcapMap',
            'specMap', 'specIntMap', 'specColMap', 'transMap',
            'ccMap', 'ccRoughMap', 'ccNormMap',
            'sheenColMap', 'sheenRoughMap',
        ];
        const HTML_TEXTURE_AUTO_FIT_MAX_TRIANGLES = 20000;

        function materialFlagEnabled(value) {
            return value === true || value === 1 || value === '1' || value === 'true';
        }

        function clampHTMLTextureDimension(value, fallback = 1024) {
            const n = Math.round(Number(value));
            if (!Number.isFinite(n)) return fallback;
            return Math.max(64, Math.min(4096, n));
        }

        function manualHTMLTextureSize(md, key) {
            return {
                width: clampHTMLTextureDimension(md?.[key + 'HTMLW'], 1024),
                height: clampHTMLTextureDimension(md?.[key + 'HTMLH'], 1024),
            };
        }

        function htmlTextureAutoFitEnabled(md, key) {
            return !!md?.[key + 'HTML'] && materialFlagEnabled(md?.[key + 'HTMLAutoFit']);
        }

        function fitHTMLTextureSizeToAspect(maxSize, aspect) {
            if (!Number.isFinite(aspect) || aspect <= 0) return maxSize;
            const maxW = clampHTMLTextureDimension(maxSize.width, 1024);
            const maxH = clampHTMLTextureDimension(maxSize.height, 1024);
            const maxAspect = maxW / Math.max(1, maxH);
            let width = maxW;
            let height = maxH;
            if (aspect >= maxAspect) {
                width = maxW;
                height = maxW / aspect;
            } else {
                height = maxH;
                width = maxH * aspect;
            }
            return {
                width: clampHTMLTextureDimension(width, maxW),
                height: clampHTMLTextureDimension(height, maxH),
            };
        }

        function matrixScaleSignature(matrixArray) {
            if (!isFiniteArray(matrixArray, 16)) return '1,1,1';
            const sx = Math.hypot(matrixArray[0], matrixArray[1], matrixArray[2]);
            const sy = Math.hypot(matrixArray[4], matrixArray[5], matrixArray[6]);
            const sz = Math.hypot(matrixArray[8], matrixArray[9], matrixArray[10]);
            const round = (value) => Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 1;
            return `${round(sx)},${round(sy)},${round(sz)}`;
        }

        function estimateGeometryUvAspect(geometry, materialIndex = null, matrixArray = null) {
            const position = geometry?.getAttribute?.('position');
            const uv = geometry?.getAttribute?.('uv');
            if (!position || !uv || position.count < 3 || uv.count < 3) return 1;

            const index = geometry.index;
            const indexCount = index ? index.count : position.count;
            const ranges = [];
            if (materialIndex != null && Array.isArray(geometry.groups) && geometry.groups.length) {
                for (const group of geometry.groups) {
                    if (group?.materialIndex === materialIndex && group.count >= 3) {
                        ranges.push({
                            start: Math.max(0, group.start || 0),
                            count: Math.max(0, Math.min(group.count || 0, indexCount - (group.start || 0))),
                        });
                    }
                }
            }
            if (ranges.length === 0) ranges.push({ start: 0, count: indexCount });

            let totalTriangles = 0;
            for (const range of ranges) totalTriangles += Math.floor(range.count / 3);
            if (totalTriangles <= 0) return 1;

            const sampleStep = Math.max(1, Math.ceil(totalTriangles / HTML_TEXTURE_AUTO_FIT_MAX_TRIANGLES));
            const p0 = new THREE.Vector3();
            const p1 = new THREE.Vector3();
            const p2 = new THREE.Vector3();
            const dp1 = new THREE.Vector3();
            const dp2 = new THREE.Vector3();
            const tangent = new THREE.Vector3();
            const bitangent = new THREE.Vector3();
            const cross = new THREE.Vector3();
            const matrix = isFiniteArray(matrixArray, 16) ? new THREE.Matrix4().fromArray(matrixArray) : null;
            let tangentSum = 0;
            let bitangentSum = 0;
            let weightSum = 0;
            let triangleOrdinal = 0;

            const vertexIndexAt = (drawIndex) => index ? index.getX(drawIndex) : drawIndex;

            for (const range of ranges) {
                const end = range.start + range.count - 2;
                for (let draw = range.start; draw < end; draw += 3) {
                    if ((triangleOrdinal++ % sampleStep) !== 0) continue;
                    const i0 = vertexIndexAt(draw);
                    const i1 = vertexIndexAt(draw + 1);
                    const i2 = vertexIndexAt(draw + 2);
                    if (
                        i0 < 0 || i1 < 0 || i2 < 0 ||
                        i0 >= position.count || i1 >= position.count || i2 >= position.count ||
                        i0 >= uv.count || i1 >= uv.count || i2 >= uv.count
                    ) {
                        continue;
                    }

                    p0.fromBufferAttribute(position, i0);
                    p1.fromBufferAttribute(position, i1);
                    p2.fromBufferAttribute(position, i2);
                    if (matrix) {
                        p0.applyMatrix4(matrix);
                        p1.applyMatrix4(matrix);
                        p2.applyMatrix4(matrix);
                    }
                    const u0 = uv.getX(i0), v0 = uv.getY(i0);
                    const u1 = uv.getX(i1), v1 = uv.getY(i1);
                    const u2 = uv.getX(i2), v2 = uv.getY(i2);
                    const du1 = u1 - u0, dv1 = v1 - v0;
                    const du2 = u2 - u0, dv2 = v2 - v0;
                    const det = du1 * dv2 - du2 * dv1;
                    if (Math.abs(det) < 1.0e-8) continue;

                    dp1.subVectors(p1, p0);
                    dp2.subVectors(p2, p0);
                    const weight = cross.crossVectors(dp1, dp2).length();
                    if (!Number.isFinite(weight) || weight <= 1.0e-8) continue;

                    const invDet = 1 / det;
                    tangent.copy(dp1).multiplyScalar(dv2).addScaledVector(dp2, -dv1).multiplyScalar(invDet);
                    bitangent.copy(dp2).multiplyScalar(du1).addScaledVector(dp1, -du2).multiplyScalar(invDet);
                    const tLen = tangent.length();
                    const bLen = bitangent.length();
                    if (!Number.isFinite(tLen) || !Number.isFinite(bLen) || tLen <= 1.0e-8 || bLen <= 1.0e-8) {
                        continue;
                    }

                    tangentSum += tLen * weight;
                    bitangentSum += bLen * weight;
                    weightSum += weight;
                }
            }

            if (weightSum <= 0 || bitangentSum <= 0) return 1;
            const aspect = tangentSum / bitangentSum;
            if (!Number.isFinite(aspect) || aspect <= 0) return 1;
            return Math.max(0.05, Math.min(20, aspect));
        }

        function getMaterialContextUvAspect(materialContext) {
            if (!materialContext?.geometry) return 1;
            const materialIndex = materialContext.materialIndex ?? null;
            const key = (materialIndex == null ? '__all__' : String(materialIndex)) + ':' +
                matrixScaleSignature(materialContext.matrixArray);
            materialContext.htmlTextureAutoFitAspectCache ??= new Map();
            if (!materialContext.htmlTextureAutoFitAspectCache.has(key)) {
                materialContext.htmlTextureAutoFitAspectCache.set(
                    key,
                    estimateGeometryUvAspect(materialContext.geometry, materialIndex, materialContext.matrixArray)
                );
            }
            return materialContext.htmlTextureAutoFitAspectCache.get(key);
        }

        function resolveHTMLTextureSize(md, key, materialContext = null) {
            const manualSize = manualHTMLTextureSize(md, key);
            if (!htmlTextureAutoFitEnabled(md, key)) return manualSize;
            const aspect = getMaterialContextUvAspect(materialContext);
            return fitHTMLTextureSizeToAspect(manualSize, aspect);
        }

        function withHTMLAutoFitIdentity(md, materialContext = null) {
            if (!md || typeof md !== 'object') return md;
            let sizes = null;
            for (const key of HTML_TEXTURE_AUTO_FIT_KEYS) {
                if (!htmlTextureAutoFitEnabled(md, key)) continue;
                const size = resolveHTMLTextureSize(md, key, materialContext);
                sizes ??= {};
                sizes[key] = size.width + 'x' + size.height;
            }
            return sizes ? { ...md, __maxjsHTMLAutoFitSizes: sizes } : md;
        }

        // Load a map slot — priority: HTML texmap → TSL procedural → URL bitmap.
        function loadMapSlot(md, key, colorSpace, xfKey, fallback, materialContext = null, maxMapChannelOverride = null) {
            const xfSource = withMaxMapChannelOverride(xfKey ? md[xfKey] : null, maxMapChannelOverride);
            const htmlUrl = md[key + 'HTML'];
            if (htmlUrl) {
                const normalizedXf = normalizeTextureTransform(xfSource);
                const baseUrl = md[key + 'HTMLBase'] || '';
                const filename = md[key + 'HTMLName'] || '';
                // Prefer baseUrl + filename so snapshot-mode relative URLs
                // resolve inside the copied directory (and sibling images
                // in the HTML file keep working).
                const resolved = (baseUrl && filename)
                    ? (baseUrl + encodeURIComponent(filename))
                    : htmlUrl;
                const htmlSize = resolveHTMLTextureSize(md, key, materialContext);
                const handle = getOrCreateHTMLTexture(THREE, resolved, {
                    width: htmlSize.width,
                    height: htmlSize.height,
                    params: md[key + 'HTMLParams'],
                    cacheKey: resolved,
                });
                applyTextureTransform(handle.texture, normalizedXf);
                applyTextureUvChannel(handle.texture, normalizedXf?.uvChannel, 1);
                return handle.texture;
            }
            const tslCode = md[key + 'TSL'];
            if (tslCode) return tslCompiler.evalTSLTexture(tslCode, md[key + 'TSLParams']);
            const url = md[key];
            if (url) return loadTexture(url, colorSpace, optimizedTextureTransformForSlot(key, xfSource), fallback);
            return null;
        }

        function isHTMLTexture(tex) {
            return !!tex?.userData?.maxjsHTMLHost;
        }

        function applyOpacityTextureSlot(material, tex) {
            if (!tex || !material) return false;
            if (!(Number.isFinite(material.alphaTest) && material.alphaTest > 0)) {
                material.transparent = true;
            }
            if (isHTMLTexture(tex) && !material.map) {
                // HTML texmaps commonly carry both color and alpha. Treating
                // them as alphaMap-only discards the color and renders the
                // material's white diffuse through the mask.
                material.map = tex;
                if ('alphaMap' in material) material.alphaMap = null;
                return true;
            }
            if ('alphaMap' in material) material.alphaMap = tex;
            return true;
        }

        const MAXJS_HTML_COLOR_MAP_FRAGMENT = `
vec4 maxjsHTMLColor = vec4( 0.0 );
#ifdef USE_MAP
    vec4 sampledDiffuseColor = texture2D( map, vMapUv );
    #ifdef DECODE_VIDEO_TEXTURE
        sampledDiffuseColor = sRGBTransferEOTF( sampledDiffuseColor );
    #endif
    maxjsHTMLColor = sampledDiffuseColor;
#endif
`;

        const MAXJS_HTML_COLOR_OVERLAY_FRAGMENT = `
#ifdef USE_MAP
    outgoingLight = mix( outgoingLight, maxjsHTMLColor.rgb, maxjsHTMLColor.a );
#endif
#include <opaque_fragment>
`;

        function preserveOpacityForHTMLColorMap(material, tex) {
            if (!material || !isHTMLTexture(tex)) return false;
            material.userData ??= {};
            material.userData.maxjsHTMLColorMapPreserveOpacity = true;

            if (!material.onBeforeCompile?.maxjsHTMLColorMapPreserveOpacity) {
                const previousOnBeforeCompile = material.onBeforeCompile;
                const patchedOnBeforeCompile = function(shader, renderer) {
                    previousOnBeforeCompile?.call(this, shader, renderer);
                    shader.fragmentShader = shader.fragmentShader.replace(
                        '#include <map_fragment>',
                        MAXJS_HTML_COLOR_MAP_FRAGMENT
                    );
                    shader.fragmentShader = shader.fragmentShader.replace(
                        '#include <opaque_fragment>',
                        MAXJS_HTML_COLOR_OVERLAY_FRAGMENT
                    );
                };
                patchedOnBeforeCompile.maxjsHTMLColorMapPreserveOpacity = true;
                material.onBeforeCompile = patchedOnBeforeCompile;
                material.customProgramCacheKey = () => 'maxjs-html-color-map-preserve-opacity-v1';
            }

            material.needsUpdate = true;
            return true;
        }

        function wantsHTMLTextureOverrideMaterial(md) {
            return !!md?.mapHTML && (md.mapHTMLOverride === true || md.mapHTMLOverride === 1);
        }

        function htmlTextureOverrideIdentity(md, materialContext = null) {
            const size = resolveHTMLTextureSize(md, 'map', materialContext);
            return {
                name: md?.name || '',
                side: md?.side ?? 1,
                mapHTML: md?.mapHTML || '',
                mapHTMLBase: md?.mapHTMLBase || '',
                mapHTMLName: md?.mapHTMLName || '',
                mapHTMLW: size.width,
                mapHTMLH: size.height,
                mapHTMLParams: md?.mapHTMLParams || null,
                mapXf: md?.mapXf || null,
                mapHTMLOverride: true,
                mapHTMLAutoFit: !!md?.mapHTMLAutoFit,
            };
        }

        function createHTMLTextureOverrideMaterial(md, materialContext = null) {
            const tex = loadMapSlot(md, 'map', THREE.SRGBColorSpace, 'mapXf', fallbackWhiteTexture, materialContext);
            if (!isHTMLTexture(tex)) return null;
            const material = new THREE.MeshBasicMaterial({
                color: 0xffffff,
                map: tex,
                side: md.side === 0 ? THREE.FrontSide : THREE.DoubleSide,
                transparent: true,
                opacity: 1.0,
                depthWrite: false,
                fog: false,
                toneMapped: false,
            });
            material.alphaTest = 0.0;
            material.premultipliedAlpha = false;
            material.userData ??= {};
            material.userData.maxjsHTMLTextureOverride = true;
            material.needsUpdate = true;
            return material;
        }



        return {
            configureGradientTexture,
            maxMapChannelFromMapName,
            textureWithUvChannel,
            resolveLightMapMaxMapChannel,
            createPendingMaterialXMaterial,
            ensureMaterialXTemplateLoaded,
            loadTexture,
            tslCompiler,
            isWebGLTexturePathActive,
            loadBakeTextureFromCandidates,
            bakeExposureScale,
            isDisplayBakedBeautyProxy,
            clearBakeTextureLoadFailures,
            HTML_TEXTURE_AUTO_FIT_KEYS,
            htmlTextureAutoFitEnabled,
            matrixScaleSignature,
            withHTMLAutoFitIdentity,
            loadMapSlot,
            applyOpacityTextureSlot,
            preserveOpacityForHTMLColorMap,
            wantsHTMLTextureOverrideMaterial,
            htmlTextureOverrideIdentity,
            createHTMLTextureOverrideMaterial,
            textureCache,
            get textureCount() { return textureCache.size; },
        };
}

export { createTexturePipeline };

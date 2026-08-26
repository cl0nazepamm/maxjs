// panels_misc.js - editor rail buttons, panel visibility, clay/ascii, and studio persistence glue.
import * as THREE from 'three';
import { AsciiEffect } from 'three/addons/effects/AsciiEffect.js';
import { getReflectionPaintNode } from '../max_lights_node.js';
import { createCanvasPanel } from '../canvas_panel.js';
import { createShaderLabPanel } from '../shader_lab_panel.js';
import { getHostProfile } from '../host_profile.js';
import { COMPOSITION_GUIDES, COMPOSITION_ASPECTS } from '../composition_overlay.js';

function createPanelsMisc(deps = {}) {
        const STUDIO_ONLY_RAIL_IDS = [];

        function setRailButtonMeta(button, { label, badge } = {}) {
            if (!button) return;
            if (typeof label === 'string') {
                const labelEl = button.querySelector('.rail-btn-label');
                if (labelEl) labelEl.textContent = label;
            }
            if (typeof badge === 'string') {
                const badgeEl = button.querySelector('.rail-btn-badge');
                if (badgeEl) badgeEl.textContent = badge;
            }
        }


        function syncAudioMuteButtonUi() {
            const button = document.getElementById('btnMuteAudio');
            if (!button) return;
            const label = deps.audioMuted ? 'Unmute audio' : 'Mute audio';
            button.classList.toggle('active', deps.audioMuted);
            button.title = label;
            button.setAttribute('aria-label', label);
        }


        // ── Clay Mode ───────────────────────────────────
        let clayModeActive = false;
        const defaultShadingLabel = 'Default Shading';
        const shadingMenuLabel = document.querySelector('[data-shading-label]');

        function updateShadingMenuLabel(isClay) {
            if (!shadingMenuLabel) return;
            const label = isClay ? 'Clay' : defaultShadingLabel;
            if (shadingMenuLabel.textContent !== label) shadingMenuLabel.textContent = label;
        }

        // ── ASCII Effect (full takeover) ──
        let asciiPreFxSnapshot = null;
        const ASCII_COLORS = { white: '#fff', green: '#0f0', amber: '#ffb000' };
        const ASCII_CHARS = ' .:-=+*#%@';

        function enterAsciiMode() {
            if (deps.asciiActive) return true;
            if (deps.shaderLabFx?.isEnabled?.()) {
                deps.perfHud?.setStatus?.('max.js - ASCII unavailable while Shader Lab is active');
                deps.syncPostFxPanel(true);
                return false;
            }
            asciiPreFxSnapshot = {
                ssgi: deps.maxjsFx.isEnabled(), ssr: deps.maxjsFx.isSSREnabled(), gtao: deps.maxjsFx.isGTAOEnabled(),
                bloom: deps.maxjsFx.isBloomEnabled(), toonOutline: deps.maxjsFx.isToonOutlineEnabled(),
                motionBlur: deps.maxjsFx.isMotionBlurEnabled(), traa: deps.maxjsFx.isTRAAEnabled(),
                contactShadow: deps.maxjsFx.isContactShadowEnabled(), retro: deps.maxjsFx.isRetroEnabled(),
                volumetric: deps.maxjsFx.isVolumetricEnabled(), pixel: deps.maxjsFx.isPixelEnabled(),
                powershot: deps.maxjsFx.isPowerShotEnabled(),
            };
            deps.maxjsFx.setEnabled(false); deps.maxjsFx.setSSREnabled(false); deps.maxjsFx.setGTAOEnabled(false);
            deps.maxjsFx.setBloomEnabled(false); deps.maxjsFx.setToonOutlineEnabled(false);
            deps.maxjsFx.setMotionBlurEnabled(false); deps.maxjsFx.setTRAAEnabled(false);
            deps.maxjsFx.setContactShadowEnabled(false); deps.maxjsFx.setRetroEnabled(false);
            deps.maxjsFx.setVolumetricEnabled(false); deps.maxjsFx.setPixelEnabled(false);
            deps.maxjsFx.setPowerShotEnabled(false);
            rebuildAsciiEffect();
            deps.asciiActive = true;
            deps.renderer.domElement.style.display = 'none';
            document.querySelector('.sidepanel-body')?.classList.add('ascii-takeover');
            return true;
        }

        function exitAsciiMode() {
            if (!deps.asciiActive) return;
            deps.asciiActive = false;
            if (deps.asciiEffect) { deps.asciiEffect.domElement.remove(); deps.asciiEffect = null; }
            deps.renderer.domElement.style.display = '';
            document.querySelector('.sidepanel-body')?.classList.remove('ascii-takeover');
            if (asciiPreFxSnapshot) {
                const s = asciiPreFxSnapshot;
                deps.maxjsFx.setGTAOEnabled(s.gtao); deps.maxjsFx.setEnabled(s.ssgi);
                deps.maxjsFx.setSSREnabled(s.ssr); deps.maxjsFx.setBloomEnabled(s.bloom);
                deps.maxjsFx.setToonOutlineEnabled(s.toonOutline); deps.maxjsFx.setMotionBlurEnabled(s.motionBlur);
                deps.maxjsFx.setTRAAEnabled(s.traa); deps.maxjsFx.setContactShadowEnabled(s.contactShadow);
                deps.maxjsFx.setRetroEnabled(s.retro); deps.maxjsFx.setVolumetricEnabled(s.volumetric);
                deps.maxjsFx.setPixelEnabled(s.pixel); deps.maxjsFx.setPowerShotEnabled(s.powershot);
                asciiPreFxSnapshot = null;
            }
            deps.syncPostFxPanel(true);
        }

        function rebuildAsciiEffect() {
            if (deps.asciiEffect) deps.asciiEffect.domElement.remove();
            deps.asciiEffect = new AsciiEffect(deps.renderer, ASCII_CHARS, {
                invert: deps.asciiSettings.invert, resolution: deps.asciiSettings.resolution,
            });
            const rect = deps.getViewportFrameRect();
            deps.asciiEffect.setSize(rect.width, rect.height);
            deps.asciiEffect.domElement.style.cssText = 'position:absolute;inset:0;z-index:1;color:' +
                (ASCII_COLORS[deps.asciiSettings.color] || '#fff') + ';background:#000;overflow:hidden';
            deps.applyFrameElementStyle(deps.asciiEffect.domElement, rect);
            document.body.appendChild(deps.asciiEffect.domElement);
        }
        let clayPreFxSnapshot = null;
        const clayMat = new THREE.MeshStandardMaterial({
            color: 0x9d3d31, roughness: 0.6, metalness: 0.05, side: THREE.DoubleSide,
        });

        function enterClayMode() {
            if (!clayPreFxSnapshot) {
                // Snapshot current FX state once. Forced native resends must not
                // overwrite the user's restore target with the already-muted clay state.
                clayPreFxSnapshot = {
                    ssgi: deps.maxjsFx.isEnabled(),
                    ssr: deps.maxjsFx.isSSREnabled(),
                    gtao: deps.maxjsFx.isGTAOEnabled(),
                    bloom: deps.maxjsFx.isBloomEnabled(),
                    toonOutline: deps.maxjsFx.isToonOutlineEnabled(),
                    motionBlur: deps.maxjsFx.isMotionBlurEnabled(),
                    traa: deps.maxjsFx.isTRAAEnabled(),
                    contactShadow: deps.maxjsFx.isContactShadowEnabled(),
                    retro: deps.maxjsFx.isRetroEnabled(),
                    volumetric: deps.maxjsFx.isVolumetricEnabled(),
                    pixel: deps.maxjsFx.isPixelEnabled(),
                    powershot: deps.maxjsFx.isPowerShotEnabled(),
                    clone: deps.maxjsFx.isCloneEnabled(),
                };
                // Disable everything
                deps.maxjsFx.setCloneEnabled(false);
                deps.maxjsFx.setEnabled(false);
                deps.maxjsFx.setSSREnabled(false);
                deps.maxjsFx.setBloomEnabled(false);
                deps.maxjsFx.setToonOutlineEnabled(false);
                deps.maxjsFx.setMotionBlurEnabled(false);
                deps.maxjsFx.setTRAAEnabled(false);
                deps.maxjsFx.setContactShadowEnabled(false);
                deps.maxjsFx.setRetroEnabled(false);
                deps.maxjsFx.setVolumetricEnabled(false);
                deps.maxjsFx.setPixelEnabled(false);
                deps.maxjsFx.setPowerShotEnabled(false);
                deps.maxjsFx.setGTAOEnabled(false);
            }
            if (deps.maxjsFx.setClayOverride) deps.maxjsFx.setClayOverride(true);

            // Use scene.overrideMaterial — renderer + shadow system use it natively,
            // no per-mesh swap needed, no stale WebGPU TextureNode references.
            deps.scene.overrideMaterial = clayMat;
            deps.maxjsFx.markOutputChanged?.();
        }

        function exitClayMode() {
            deps.scene.overrideMaterial = null;

            // Restore FX state
            if (clayPreFxSnapshot) {
                if (deps.maxjsFx.setClayOverride) deps.maxjsFx.setClayOverride(false);
                deps.maxjsFx.setGTAOEnabled(clayPreFxSnapshot.gtao);
                deps.maxjsFx.setEnabled(clayPreFxSnapshot.ssgi);
                deps.maxjsFx.setSSREnabled(clayPreFxSnapshot.ssr);
                deps.maxjsFx.setBloomEnabled(clayPreFxSnapshot.bloom);
                deps.maxjsFx.setToonOutlineEnabled(clayPreFxSnapshot.toonOutline);
                deps.maxjsFx.setMotionBlurEnabled(clayPreFxSnapshot.motionBlur);
                deps.maxjsFx.setTRAAEnabled(clayPreFxSnapshot.traa);
                deps.maxjsFx.setContactShadowEnabled(clayPreFxSnapshot.contactShadow);
                deps.maxjsFx.setRetroEnabled(clayPreFxSnapshot.retro);
                deps.maxjsFx.setVolumetricEnabled(clayPreFxSnapshot.volumetric);
                deps.maxjsFx.setPixelEnabled(clayPreFxSnapshot.pixel);
                deps.maxjsFx.setPowerShotEnabled(clayPreFxSnapshot.powershot);
                deps.maxjsFx.setCloneEnabled(clayPreFxSnapshot.clone);
                clayPreFxSnapshot = null;
            }
            deps.maxjsFx.markOutputChanged?.();
        }

        deps.bridge.on('clay_mode', msg => {
            if (deps.renderToImageActive) return;  // suppress during production render
            const enabled = !!msg.enabled;
            const needsApply = enabled
                ? (!clayModeActive || deps.scene.overrideMaterial !== clayMat)
                : (clayModeActive || deps.scene.overrideMaterial === clayMat || !!clayPreFxSnapshot);
            if (!needsApply) {
                updateShadingMenuLabel(enabled);
                return;
            }
            clayModeActive = enabled;
            updateShadingMenuLabel(enabled);
            if (enabled) enterClayMode(); else exitClayMode();
            deps.syncPostFxPanel(true, { persist: false });
        });


        // ── Reflection Paint Panel ──────────────────────────
        const reflPaintPanel = document.getElementById('reflPaintPanel');
        const reflPaint = getReflectionPaintNode();
        let reflPaintPanelVisible = false;
        const REFL_PAINT_STORAGE_KEY = 'maxjs-reflection-paint';

        function notifyReflectionPaintChanged(wasActive, options = {}) {
            if (wasActive !== reflPaint.active) deps.maxjsFx.markSceneChanged?.();
            deps.maxjsFx.markOutputChanged?.();
            if (deps.lightLinkPanelVisible && (options.rebuildLightPanel || wasActive !== reflPaint.active)) {
                deps.rebuildLightLinkPanel();
            }
        }

        function setReflPaintPanelVisible(v) {
            if (v && !deps.isStudioMode) return;
            reflPaintPanelVisible = !!v;
            reflPaintPanel.classList.toggle('visible', reflPaintPanelVisible);
            reflPaintPanel.toggleAttribute('inert', !reflPaintPanelVisible);
            reflPaintPanel.setAttribute('aria-hidden', String(!reflPaintPanelVisible));
            document.getElementById('btnReflPaint')?.classList.toggle('active', reflPaintPanelVisible);
            if (reflPaintPanelVisible) rebuildReflPaintPanel();
        }

        function saveReflPaint(options = {}) {
            saveStudioState(options);
        }

        function serializeReflectionPaintState() {
            return {
                intensity: reflPaint.getGlobalIntensity?.() ?? 1.0,
                lights: reflPaint.getLights(),
            };
        }

        function applyReflectionPaintState(payload) {
            try {
                const lights = Array.isArray(payload) ? payload : payload?.lights;
                const wasActive = reflPaint.active;
                if (Number.isFinite(payload?.intensity)) {
                    reflPaint.setGlobalIntensity(payload.intensity);
                } else if (payload && !Array.isArray(payload)) {
                    reflPaint.setGlobalIntensity(1.0);
                }
                reflPaint.clearLights();
                for (const l of (Array.isArray(lights) ? lights : [])) {
                    reflPaint.addLight({
                        id: l.id,
                        lat: l.lat, lon: l.lon,
                        color: l.color,
                        colorOuter: l.colorOuter,
                        intensity: l.intensity,
                        radiusX: l.radiusX ?? l.radius ?? 0.15,
                        radiusY: l.radiusY ?? l.radius ?? 0.15,
                        edge: l.edge ?? 0.3,
                        shape: l.shape ?? 'circle',
                        rotation: l.rotation ?? 0,
                    });
                }
                notifyReflectionPaintChanged(wasActive);
            } catch {}
        }

        function readLegacyReflectionPaintState() {
            try {
                const raw = localStorage.getItem(REFL_PAINT_STORAGE_KEY);
                return raw ? { lights: JSON.parse(raw) } : null;
            } catch {
                return null;
            }
        }

        function rpRow(cls, id, label, type, min, max, step, value, displayVal) {
            return `<label class="fx-check"><span>${label}</span><div style="display:flex;align-items:center;gap:4px;flex:1;min-width:0;">` +
                `<input type="${type}" class="fx-range ${cls}" data-id="${id}" min="${min}" max="${max}" step="${step}" value="${value}">` +
                `<span class="${cls}-val" data-id="${id}" style="width:32px;font-size:9px;text-align:right;color:#999;font-variant-numeric:tabular-nums;flex-shrink:0;">${displayVal}</span></div></label>`;
        }

        function handleReflPaintInput(ev) {
            const el = ev.target;
            const sec = el.closest('[data-id]');
            const id = Number(sec?.dataset.id || el.dataset.id);
            if (!id) return;
            const wasActive = reflPaint.active;
            const props = {};
            if (el.classList.contains('rp-lat') || el.classList.contains('rp-lon')) {
                const latEl = reflPaintPanel.querySelector(`.rp-lat[data-id="${id}"]`);
                const lonEl = reflPaintPanel.querySelector(`.rp-lon[data-id="${id}"]`);
                props.lat = parseFloat(latEl.value);
                props.lon = parseFloat(lonEl.value);
                const latV = reflPaintPanel.querySelector(`.rp-lat-val[data-id="${id}"]`);
                const lonV = reflPaintPanel.querySelector(`.rp-lon-val[data-id="${id}"]`);
                if (latV) latV.textContent = Math.round(props.lat);
                if (lonV) lonV.textContent = Math.round(props.lon);
            } else if (el.classList.contains('rp-color')) {
                props.color = el.value;
            } else if (el.classList.contains('rp-color-outer')) {
                props.colorOuter = el.value;
            } else if (el.classList.contains('rp-int')) {
                props.intensity = parseFloat(el.value);
                const v = reflPaintPanel.querySelector(`.rp-int-val[data-id="${id}"]`);
                if (v) v.textContent = props.intensity.toFixed(1);
            } else if (el.classList.contains('rp-sx')) {
                props.radiusX = parseFloat(el.value);
                const v = reflPaintPanel.querySelector(`.rp-sx-val[data-id="${id}"]`);
                if (v) v.textContent = props.radiusX.toFixed(2);
            } else if (el.classList.contains('rp-sy')) {
                props.radiusY = parseFloat(el.value);
                const v = reflPaintPanel.querySelector(`.rp-sy-val[data-id="${id}"]`);
                if (v) v.textContent = props.radiusY.toFixed(2);
            } else if (el.classList.contains('rp-shape')) {
                props.shape = el.value;
            } else if (el.classList.contains('rp-rot')) {
                props.rotation = parseFloat(el.value) * Math.PI / 180;
                const v = reflPaintPanel.querySelector(`.rp-rot-val[data-id="${id}"]`);
                if (v) v.textContent = Math.round(parseFloat(el.value));
            } else if (el.classList.contains('rp-edge')) {
                props.edge = parseFloat(el.value);
                const v = reflPaintPanel.querySelector(`.rp-edge-val[data-id="${id}"]`);
                if (v) v.textContent = props.edge.toFixed(3);
            } else {
                return;
            }
            reflPaint.updateLight(id, props);
            if (deps.lightLinking.getReflectionPaintConstrainToCamera()) {
                deps.lightLinking.captureReflectionPaintCameraDirections();
            }
            saveReflPaint();
            notifyReflectionPaintChanged(wasActive);
        }

        reflPaintPanel.addEventListener('input', handleReflPaintInput);
        reflPaintPanel.addEventListener('change', () => saveReflPaint({ flush: true }));

        function rebuildReflPaintPanel() {
            const lights = reflPaint.getLights();
            let html = `<div class="sidepanel-header"><div><div class="sidepanel-title">Reflection Paint</div>` +
                `<div class="sidepanel-subtitle">Global painted HDRI overlay</div></div>` +
                `<div style="display:flex;gap:4px"><button id="rp-add" type="button">+ Add</button>` +
                `<button id="rp-hide" type="button">Hide</button></div></div>`;
            html += `<div class="sidepanel-body">`;

            if (lights.length === 0) {
                html += `<div style="color:#555;font-size:10px;padding:4px 0;">No paint lights. Click + Add to paint one on the environment sphere.</div>`;
            }

            for (const l of lights) {
                const rotDeg = Math.round((l.rotation || 0) * 180 / Math.PI);
                html += `<section class="fx-section" data-id="${l.id}">`;
                html += `<div class="fx-section-title" style="margin-bottom:8px;">`;
                html += `<span style="flex:1;">Paint ${l.id}</span>`;
                html += `<button class="rp-del" data-id="${l.id}" type="button" style="color:#c66;">Delete</button>`;
                html += `</div>`;
                html += `<div class="fx-grid">`;
                html += rpRow('rp-lat', l.id, 'Latitude', 'range', -90, 90, 1, Math.round(l.lat), Math.round(l.lat));
                html += rpRow('rp-lon', l.id, 'Longitude', 'range', 0, 360, 1, Math.round(l.lon), Math.round(l.lon));
                html += `<label class="fx-check"><span>Color</span><div style="display:flex;align-items:center;gap:6px;">` +
                    `<input type="color" class="rp-color" data-id="${l.id}" value="${l.color}" style="width:24px;height:16px;border:1px solid rgba(255,255,255,0.1);padding:0;background:none;cursor:pointer;" title="Center">` +
                    `<span style="font-size:9px;color:#666;">Edge</span>` +
                    `<input type="color" class="rp-color-outer" data-id="${l.id}" value="${l.colorOuter}" style="width:24px;height:16px;border:1px solid rgba(255,255,255,0.1);padding:0;background:none;cursor:pointer;" title="Edge gradient">` +
                    `</div></label>`;
                html += rpRow('rp-int', l.id, 'Intensity', 'range', 0, 10, 0.1, l.intensity, l.intensity.toFixed(1));
                html += rpRow('rp-sx', l.id, 'Size X', 'range', 0.01, 1.5, 0.01, l.radiusX, l.radiusX.toFixed(2));
                html += rpRow('rp-sy', l.id, 'Size Y', 'range', 0.01, 1.5, 0.01, l.radiusY, l.radiusY.toFixed(2));
                html += `<label class="fx-check"><span>Shape</span>` +
                    `<select class="rp-shape" data-id="${l.id}" style="background:rgba(255,255,255,0.05);color:#bbb;border:1px solid rgba(255,255,255,0.08);padding:3px 6px;font:9px/1 -apple-system,'Segoe UI',system-ui,sans-serif;">` +
                    `<option value="circle"${l.shape === 'circle' ? ' selected' : ''}>Circle</option>` +
                    `<option value="rect"${l.shape === 'rect' ? ' selected' : ''}>Rectangle</option></select></label>`;
                html += rpRow('rp-rot', l.id, 'Rotation', 'range', 0, 360, 1, rotDeg, rotDeg);
                html += rpRow('rp-edge', l.id, 'Edge', 'range', 0.001, 1, 0.001, l.edge, l.edge.toFixed(3));
                html += `</div></section>`;
            }

            html += `</div>`;
            reflPaintPanel.innerHTML = html;

            document.getElementById('rp-add')?.addEventListener('click', () => {
                const wasActive = reflPaint.active;
                reflPaint.addLight({ lat: 45, lon: 90, intensity: 2.0, radiusX: 0.15, radiusY: 0.15, edge: 0.3, shape: 'circle', rotation: 0 });
                if (deps.lightLinking.getReflectionPaintConstrainToCamera()) {
                    deps.lightLinking.captureReflectionPaintCameraDirections();
                }
                saveReflPaint({ flush: true });
                notifyReflectionPaintChanged(wasActive, { rebuildLightPanel: true });
                rebuildReflPaintPanel();
            });
            document.getElementById('rp-hide')?.addEventListener('click', () => {
                setReflPaintPanelVisible(false);
            });

            for (const btn of reflPaintPanel.querySelectorAll('.rp-del')) {
                btn.addEventListener('click', () => {
                    const wasActive = reflPaint.active;
                    reflPaint.removeLight(Number(btn.dataset.id));
                    if (deps.lightLinking.getReflectionPaintConstrainToCamera()) {
                        deps.lightLinking.captureReflectionPaintCameraDirections();
                    }
                    saveReflPaint({ flush: true });
                    notifyReflectionPaintChanged(wasActive);
                    rebuildReflPaintPanel();
                });
            }
        }

        document.getElementById('btnReflPaint')?.addEventListener('click', () => {
            if (deps.isSimpleWebGLPipelineActive()) {
                deps.perfHud.setStatus('max.js - Reflection Paint is unavailable in the simple WebGL pipeline');
                return;
            }
            if (!deps.isStudioMode) {
                deps.perfHud.setStatus('max.js - Reflection Paint is available in Advanced mode only');
                return;
            }
            setReflPaintPanelVisible(!reflPaintPanelVisible);
        });

        // ── Studio State Persistence ────────────────────────
        let studioPersistTimer = 0;
        let lastProjectStudioSignature = '';
        let queuedProjectStudioSignature = '';
        let queuedProjectStudioPayload = null;
        let studioPersistInFlight = false;
        let newestLocalStudioSignature = '';
        let suppressStudioPersistenceDepth = 0;
        let retainedReflectionPaintState = null;
        const STUDIO_PERSIST_IDLE_MS = 550;

        function withStudioPersistenceSuppressed(fn) {
            suppressStudioPersistenceDepth += 1;
            try {
                return fn();
            } finally {
                suppressStudioPersistenceDepth = Math.max(0, suppressStudioPersistenceDepth - 1);
            }
        }

        function serializeStudioState() {
            const reflectionPaint = deps.isStudioMode
                ? serializeReflectionPaintState()
                : (retainedReflectionPaintState ?? serializeReflectionPaintState());
            if (deps.isStudioMode) retainedReflectionPaintState = reflectionPaint;
            return {
                version: 2,
                lightLinking: deps.lightLinking.serialize(),
                reflectionPaint,
            };
        }

        function applyStudioState(payload) {
            if (!payload || typeof payload !== 'object') return;
            withStudioPersistenceSuppressed(() => {
                retainedReflectionPaintState = payload.reflectionPaint
                    ?? retainedReflectionPaintState
                    ?? { lights: [], intensity: 1.0 };
                // Reflection Paint remains a Spectral-only feature. Light links
                // are renderer-agnostic across every node-renderer raster mode.
                if (deps.isStudioMode) {
                    applyReflectionPaintState(retainedReflectionPaintState);
                }
                deps.lightLinking.applyPayload(payload.lightLinking);
                if (deps.lightLinkPanelVisible) deps.rebuildLightLinkPanel();
                if (reflPaintPanelVisible) rebuildReflPaintPanel();
            });
        }

        function saveLegacyStudioStateFallback(payload) {
            if (window.chrome?.webview) return;
            try {
                localStorage.setItem(LIGHT_LINK_STORAGE_KEY, JSON.stringify(payload.lightLinking ?? {}));
                localStorage.setItem(REFL_PAINT_STORAGE_KEY, JSON.stringify(payload.reflectionPaint?.lights ?? []));
            } catch {}
        }

        function restoreLegacyStudioStateFallback() {
            if (window.chrome?.webview) return false;
            withStudioPersistenceSuppressed(() => {
                deps.lightLinking.restoreFromStorage();
                retainedReflectionPaintState = readLegacyReflectionPaintState()
                    ?? retainedReflectionPaintState
                    ?? { lights: [], intensity: 1.0 };
                if (deps.isStudioMode) applyReflectionPaintState(retainedReflectionPaintState);
            });
            return true;
        }

        function scheduleProjectStudioSave(delayMs = STUDIO_PERSIST_IDLE_MS) {
            clearTimeout(studioPersistTimer);
            studioPersistTimer = setTimeout(() => {
                studioPersistTimer = 0;
                void flushProjectStudioSave();
            }, delayMs);
        }

        async function flushProjectStudioSave() {
            const projectRuntime = deps._projectRuntimeRef;
            if (!projectRuntime?.setStudioState || studioPersistInFlight) return;
            const payload = queuedProjectStudioPayload;
            const signature = queuedProjectStudioSignature;
            if (!payload || !signature) return;

            queuedProjectStudioPayload = null;
            queuedProjectStudioSignature = '';
            studioPersistInFlight = true;
            try {
                await projectRuntime.setStudioState(payload);
                lastProjectStudioSignature = signature;
                if (newestLocalStudioSignature === signature && !queuedProjectStudioPayload) {
                    newestLocalStudioSignature = '';
                }
            } catch (error) {
                deps.reportBridgeError('studio state save', error);
            } finally {
                studioPersistInFlight = false;
                if (queuedProjectStudioPayload) scheduleProjectStudioSave();
            }
        }

        function saveStudioState(options = {}) {
            if (suppressStudioPersistenceDepth > 0) return;
            const payload = serializeStudioState();
            const signature = JSON.stringify(payload);
            const projectRuntime = deps._projectRuntimeRef;
            if (projectRuntime?.setStudioState) {
                if (signature === lastProjectStudioSignature && !queuedProjectStudioPayload) return;
                if (signature === queuedProjectStudioSignature) return;
                newestLocalStudioSignature = signature;
                lastProjectStudioSignature = signature;
                queuedProjectStudioPayload = payload;
                queuedProjectStudioSignature = signature;
                scheduleProjectStudioSave(options.flush ? 0 : STUDIO_PERSIST_IDLE_MS);
                return;
            }
            saveLegacyStudioStateFallback(payload);
        }

        function restoreStudioState() {
            const projectRuntime = deps._projectRuntimeRef;
            const projectPayload = projectRuntime?.getStudioState?.();
            if (projectPayload) {
                lastProjectStudioSignature = JSON.stringify(projectPayload);
                newestLocalStudioSignature = '';
                queuedProjectStudioSignature = '';
                queuedProjectStudioPayload = null;
                applyStudioState(projectPayload);
                return;
            }
            if (projectRuntime) return;
            restoreLegacyStudioStateFallback();
        }

        function syncProjectStudioState() {
            const payload = deps._projectRuntimeRef?.getStudioState?.();
            if (!payload) return;
            const signature = JSON.stringify(payload);
            if (!signature || signature === lastProjectStudioSignature) return;
            if (newestLocalStudioSignature && signature !== newestLocalStudioSignature) return;
            lastProjectStudioSignature = signature;
            applyStudioState(payload);
        }


        function syncEnvButtonUi() {
            const el = document.getElementById('btnEnv');
            if (!el) return;
            el.classList.toggle('active', deps.envVisible);
            el.title = deps.envVisible ? 'Environment backdrop visible' : 'Environment backdrop hidden';
            el.setAttribute('aria-pressed', deps.envVisible ? 'true' : 'false');
            el.setAttribute('aria-label', deps.envVisible ? 'Environment backdrop visible' : 'Environment backdrop hidden');
        }


        // ── Composition guide controls ──────────────────────────────────
        (function wireCompositionOverlay() {
            if (!deps.compositionOverlay) return;
            const st0 = deps.compositionOverlay.getState();
            const button = document.getElementById('btnComposition');
            const popover = document.getElementById('compositionPopover');
            const closeBtn = document.getElementById('compClose');
            const chipGrid = document.getElementById('compGuideGrid');
            const spiralSwitch = document.getElementById('compSpiralOrient');
            const spiralRow = document.querySelector('[data-comp-suboption="spiral"]');
            const gridRow = document.querySelector('[data-comp-suboption="grid"]');
            const gridDiv = document.getElementById('compGridDiv');
            const gridDivVal = document.getElementById('compGridDivVal');
            const aspectSel = document.getElementById('compAspect');
            const colorInput = document.getElementById('compColor');
            const colorFill = document.querySelector('.comp-color-fill');
            const opacity = document.getElementById('compOpacity');
            const thickness = document.getElementById('compThickness');
            const clearBtn = document.getElementById('compClear');

            function refreshChrome() {
                const st = deps.compositionOverlay.getState();
                button?.classList.toggle('active', deps.compositionOverlay.isActive());
                spiralRow?.classList.toggle('is-hidden', !st.guides.spiral);
                gridRow?.classList.toggle('is-hidden', !st.guides.grid);
            }

            function setPopover(open) {
                if (!popover) return;
                popover.hidden = !open;
                popover.setAttribute('aria-hidden', open ? 'false' : 'true');
                popover.classList.toggle('open', open);
                button?.setAttribute('aria-expanded', open ? 'true' : 'false');
            }
            if (button && popover) {
                button.addEventListener('click', () => setPopover(popover.hidden));
                closeBtn?.addEventListener('click', () => setPopover(false));
                document.addEventListener('pointerdown', (e) => {
                    if (popover.hidden) return;
                    if (e.target.closest('#compositionPopover') || e.target.closest('#btnComposition')) return;
                    setPopover(false);
                });
                document.addEventListener('keydown', (e) => {
                    if (e.key === 'Escape' && !popover.hidden) setPopover(false);
                });
            }

            if (chipGrid) {
                for (const g of COMPOSITION_GUIDES) {
                    const chip = document.createElement('button');
                    chip.type = 'button';
                    chip.className = 'comp-chip';
                    chip.dataset.guide = g.id;
                    chip.textContent = g.label;
                    chip.title = g.title;
                    const on = !!st0.guides[g.id];
                    chip.classList.toggle('active', on);
                    chip.setAttribute('aria-pressed', on ? 'true' : 'false');
                    chip.addEventListener('click', () => {
                        const next = deps.compositionOverlay.toggleGuide(g.id);
                        chip.classList.toggle('active', next);
                        chip.setAttribute('aria-pressed', next ? 'true' : 'false');
                        refreshChrome();
                    });
                    chipGrid.appendChild(chip);
                }
            }

            if (spiralSwitch) {
                const markActive = (v) => spiralSwitch.querySelectorAll('.rail-mode-option').forEach((b) => {
                    b.classList.toggle('active', Number(b.dataset.spiralOrient) === v);
                });
                markActive(st0.spiralOrientation);
                spiralSwitch.addEventListener('click', (e) => {
                    const btn = e.target.closest('[data-spiral-orient]');
                    if (!btn) return;
                    const v = Number(btn.dataset.spiralOrient) & 3;
                    deps.compositionOverlay.setSpiralOrientation(v);
                    markActive(v);
                });
            }

            if (gridDiv) {
                gridDiv.value = String(st0.gridDivisions);
                if (gridDivVal) gridDivVal.textContent = String(st0.gridDivisions);
                gridDiv.addEventListener('input', () => {
                    deps.compositionOverlay.setGridDivisions(gridDiv.value);
                    if (gridDivVal) gridDivVal.textContent = String(Math.round(Number(gridDiv.value)));
                });
            }

            if (aspectSel) {
                for (const a of COMPOSITION_ASPECTS) {
                    const opt = document.createElement('option');
                    opt.value = a.id;
                    opt.textContent = a.id === 'off' ? 'No mask' : a.label;
                    aspectSel.appendChild(opt);
                }
                aspectSel.value = st0.aspect;
                aspectSel.addEventListener('change', () => {
                    deps.compositionOverlay.setAspect(aspectSel.value);
                    refreshChrome();
                });
            }

            if (colorInput) {
                colorInput.value = st0.color;
                if (colorFill) colorFill.style.fill = st0.color;
                colorInput.addEventListener('input', () => {
                    deps.compositionOverlay.setColor(colorInput.value);
                    if (colorFill) colorFill.style.fill = colorInput.value;
                });
            }

            if (opacity) {
                opacity.value = String(st0.opacity);
                opacity.addEventListener('input', () => deps.compositionOverlay.setOpacity(opacity.value));
            }
            if (thickness) {
                thickness.value = String(st0.thickness);
                thickness.addEventListener('input', () => deps.compositionOverlay.setThickness(thickness.value));
            }

            if (clearBtn) {
                clearBtn.addEventListener('click', () => {
                    deps.compositionOverlay.clearGuides();
                    chipGrid?.querySelectorAll('.comp-chip').forEach((c) => {
                        c.classList.remove('active');
                        c.setAttribute('aria-pressed', 'false');
                    });
                    if (aspectSel) aspectSel.value = 'off';
                    refreshChrome();
                });
            }

            refreshChrome();
        })();


        const btnCam = document.getElementById('btnCamLock');
        btnCam.onclick = () => {
            deps.camLock = !deps.camLock;
            deps.syncCameraLockButtonUi();
            deps.syncCameraControlAvailability();
            deps.savePostFxState();
        };

        const btnEnv = document.getElementById('btnEnv');
        btnEnv.onclick = () => {
            deps.envVisible = !deps.envVisible;
            syncEnvButtonUi();
            if (deps.isLocalHdriActive()) {
                deps.applyLocalHDRIToScene();
            } else {
                deps.syncEnvironmentDisplay();
            }
            deps.savePostFxState();
        };

        deps.syncCameraLockButtonUi();
        syncEnvButtonUi();

        const btnLightProbe = document.getElementById('btnLightProbe');
        btnLightProbe.onclick = () => {
            deps.lightProbeEnabled = !deps.lightProbeEnabled;
            btnLightProbe.classList.toggle('active', deps.lightProbeEnabled);
            deps.applyLightProbeState();
            if (deps.lightProbeEnabled) deps.refreshLightProbeFromCurrentHDRI();
            deps.savePostFxState();
        };

        const renderModeSwitch = document.getElementById('renderModeSwitch');
        const modeLabels = {
            standard: 'Standard',
            spectral: 'Spectral',
        };
        if (renderModeSwitch) {
            renderModeSwitch.title = 'Render mode: Standard, or Spectral (probe GI + live path tracer)';
            renderModeSwitch.querySelectorAll('[data-render-mode]').forEach(button => {
                const mode = button.dataset.renderMode;
                const active = mode === deps.maxjsRenderMode;
                button.classList.toggle('active', active);
                button.setAttribute('aria-pressed', active ? 'true' : 'false');
                button.title = `${modeLabels[mode] || mode} mode${active ? ' active' : ''}`;
                button.addEventListener('click', () => {
                    if (mode === deps.maxjsRenderMode) return;
                    const label = modeLabels[mode] || mode;
                    if (!confirm(`Switch to ${label} mode? Reloads the page.`)) return;
                    // Pathtracing runs on the same WebGPU backend now — no
                    // backend switch, just re-init the render mode on reload.
                    try { localStorage.setItem(deps.MAXJS_MODE_KEY, mode); } catch {}
                    location.reload();
                });
            });
        }

        // Spectral sub-view toggle: probes <-> path tracer, live (no reload).
        const spectralTraceButton = document.getElementById('btnSpectralTrace');
        window.__maxjsSyncSpectralViewUi = () => {
            if (!spectralTraceButton) return;
            const webGL = typeof deps.isWebGLPipelineActive === 'function' && deps.isWebGLPipelineActive();
            const lightLinksActive = deps.lightLinking?.hasActiveLinks?.() === true;
            spectralTraceButton.style.display = (deps.isStudioMode && !webGL) ? '' : 'none';
            spectralTraceButton.disabled = lightLinksActive;
            const active = deps.isStudioMode && deps.spectralView === 'trace';
            spectralTraceButton.classList.toggle('active', active);
            spectralTraceButton.setAttribute('aria-pressed', active ? 'true' : 'false');
            spectralTraceButton.title = lightLinksActive
                ? 'Path tracing is unavailable while Light Linking is active'
                : (active
                    ? 'Path-traced view active — click for probe GI'
                    : 'Path-traced view (spectral mode)');
        };
        spectralTraceButton?.addEventListener('click', () => {
            if (!deps.isStudioMode) return;
            if (deps.lightLinking?.hasActiveLinks?.()) {
                deps.perfHud?.setStatus?.('max.js - set linked lights to None before using Trace');
                return;
            }
            deps.setSpectralView(deps.spectralView === 'trace' ? 'probes' : 'trace');
        });
        window.__maxjsSyncSpectralViewUi();

        // Path-tracer pause toggle. Stops compute dispatch so the GPU goes idle
        // and the maxjs UI panels stay responsive while the accumulated frame
        // holds. Styled by .pt-pause-toggle (css/index.css); that rule hides it
        // outside pathtracing mode, so it can be created unconditionally.
        {
            const ptPauseBtn = document.createElement('button');
            ptPauseBtn.id = 'btnPathTracePause';
            ptPauseBtn.type = 'button';
            ptPauseBtn.className = 'pt-pause-toggle';
            deps.ptPauseUiSync = () => {
                const p = deps.pathTracingSettings.paused === true;
                ptPauseBtn.textContent = p ? '▶ Resume' : '⏸ Pause';
                ptPauseBtn.classList.toggle('is-paused', p);
                ptPauseBtn.title = p ? 'Resume path tracing' : 'Pause path tracing — frees the GPU so the UI stays responsive';
            };
            ptPauseBtn.addEventListener('click', () => {
                deps.applyPathTracingSettings({ paused: !deps.pathTracingSettings.paused }, { notify: true, sendHost: true });
            });
            document.body.appendChild(ptPauseBtn);
            deps.ptPauseUiSync();
        }

        function setViewportMenuItemHidden(el, hidden) {
            if (!el) return;
            el.hidden = !!hidden;
            el.classList.toggle('is-hidden', !!hidden);
            if (hidden) {
                el.style.setProperty('display', 'none', 'important');
            } else {
                el.style.removeProperty('display');
            }
        }

        function syncSimpleWebGLPipelineUi() {
            const simpleWebGL = deps.isSimpleWebGLPipelineActive();
            const webGLPipeline = deps.isWebGLPipelineActive();
            const tslGl = deps.isWgl2FallbackBackendActive();
            const renderModeRow = renderModeSwitch?.closest('.vpmenu-row');
            setViewportMenuItemHidden(renderModeRow, false);
            renderModeSwitch?.querySelectorAll('[data-render-mode]').forEach(button => {
                const mode = button.dataset.renderMode;
                // Spectral mode (probe GI + path tracer) requires the native
                // WebGPU stack; hide it on the WebGL pipeline.
                const hideForPipeline = webGLPipeline && mode === 'spectral';
                setViewportMenuItemHidden(button, hideForPipeline);
                const gated = hideForPipeline;
                button.disabled = gated;
                button.classList.toggle('is-gated', gated);
                button.setAttribute('aria-disabled', gated ? 'true' : 'false');
                button.title = `${modeLabels[mode] || mode} mode${mode === deps.maxjsRenderMode ? ' active' : ''}`;
                if (webGLPipeline && mode === 'spectral') {
                    button.title = 'Spectral mode requires the native WebGPU pipeline';
                }
            });

            const vrButton = document.getElementById('btnEnterVR');
            const vrRow = vrButton?.closest('.vpmenu-row');
            setViewportMenuItemHidden(vrRow, webGLPipeline);
            if (vrButton) {
                vrButton.disabled = webGLPipeline || vrButton.disabled;
                vrButton.classList.toggle('is-gated', webGLPipeline || vrButton.disabled);
                if (webGLPipeline) vrButton.title = 'VR is unavailable in the WebGL/pathtracing pipeline';
            }

            for (const id of STUDIO_ONLY_RAIL_IDS) {
                const button = document.getElementById(id);
                const row = button?.closest('.vpmenu-row');
                setViewportMenuItemHidden(row, simpleWebGL);
                if (button && simpleWebGL) {
                    button.disabled = true;
                    button.classList.add('is-gated');
                    button.setAttribute('aria-disabled', 'true');
                }
            }
            const renderMenuSep = document.querySelector('[data-menu="render"] .vpmenu-sep');
            setViewportMenuItemHidden(renderMenuSep, simpleWebGL || !deps.isStudioMode);

            const shaderLabButton = document.getElementById('btnShaderLabPanel');
            const shaderLabRow = shaderLabButton?.closest('.vpmenu-row');
            setViewportMenuItemHidden(shaderLabRow, simpleWebGL || !isShaderLabBackendAvailable());

            if (simpleWebGL) {
                deps.setLightLinkPanelVisible(false);
                setReflPaintPanelVisible(false);
            }
            window.__maxjsSyncSpectralViewUi?.();
        }

        function syncStudioOnlyUi() {
            const gated = !deps.isStudioMode;
            for (const id of STUDIO_ONLY_RAIL_IDS) {
                const button = document.getElementById(id);
                if (!button) continue;
                const row = button.closest('.vpmenu-row');
                if (deps.isSimpleWebGLPipelineActive()) {
                    setViewportMenuItemHidden(row, true);
                    continue;
                }
                setViewportMenuItemHidden(row, gated);
                if (!button.dataset.baseTitle) button.dataset.baseTitle = button.title || '';
                button.disabled = gated;
                button.classList.toggle('is-gated', gated);
                button.setAttribute('aria-disabled', gated ? 'true' : 'false');
                button.title = gated
                    ? `${button.dataset.baseTitle} (Advanced mode only)`
                    : button.dataset.baseTitle;
            }
            if (gated) {
                deps.setLightLinkPanelVisible(false);
                setReflPaintPanelVisible(false);
            }
            syncSimpleWebGLPipelineUi();
        }
        syncStudioOnlyUi();

        function syncBackgroundColorSlot() {
            const input = document.getElementById('bgColorSlot');
            const slot = document.querySelector('.vpmenu-bg-slot');
            const hex = deps.hexColorInputValue(deps.hiddenBackgroundColor);
            if (input) input.value = hex;
            if (slot) slot.style.setProperty('--vpmenu-bg-fill', hex);
        }

        // ── Theme Toggle ─────────────────────────────────
        // Icon swap is CSS-driven (body.light-mode toggles .icon-moon / .icon-sun)
        const btnMuteAudio = document.getElementById('btnMuteAudio');
        btnMuteAudio?.addEventListener('click', () => {
            deps.setAudioMuted(!deps.audioMuted);
        });
        syncAudioMuteButtonUi();

        const btnTheme = document.getElementById('btnTheme');
        btnTheme.onclick = () => {
            deps.lightMode = !deps.lightMode;
            document.body.classList.toggle('light-mode', deps.lightMode);
            try {
                localStorage.setItem(THEME_STORAGE_KEY, deps.lightMode ? 'light' : 'dark');
            } catch (e) { /* private mode */ }
        };

        const bgColorSlotInput = document.getElementById('bgColorSlot');
        bgColorSlotInput?.addEventListener('input', () => {
            const next = deps.parseHexColorInput(bgColorSlotInput.value);
            if (next == null) return;
            deps.setBackgroundColor(next);
        });
        syncBackgroundColorSlot();


        // ── Runtime Layers Panel ─────────────────────────
        const btnLayersPanel = document.getElementById('btnLayersPanel');
        const layersPanel = document.getElementById('layersPanel');
        let layersPanelVisible = false;
        let layersPanelDirty = true;
        let layersPanelRefreshQueued = false;

        function setLayersPanelVisible(visible) {
            layersPanelVisible = !!visible;
            if (!layersPanelVisible) {
                const ae = document.activeElement;
                if (ae instanceof HTMLElement && layersPanel.contains(ae)) btnLayersPanel.focus();
            }
            layersPanel.classList.toggle('visible', layersPanelVisible);
            layersPanel.toggleAttribute('inert', !layersPanelVisible);
            layersPanel.setAttribute('aria-hidden', String(!layersPanelVisible));
            btnLayersPanel?.classList.toggle('active', layersPanelVisible);
            if (layersPanelVisible) queueLayersPanelRefresh();
        }

        // ── Shader Lab Panel ────────────────────────────────
        const btnShaderLabPanel = document.getElementById('btnShaderLabPanel');
        const shaderLabPanel = document.getElementById('shaderLabPanel');
        let shaderLabPanelVisible = false;
        let shaderLabPanelApp = null;

        function isShaderLabBackendAvailable() {
            return !!deps.maxjsFx.supportsScreenSpaceEffects?.();
        }

        function syncShaderLabAvailability() {
            const available = isShaderLabBackendAvailable();
            if (btnShaderLabPanel) {
                const row = btnShaderLabPanel.closest('.vpmenu-row');
                setViewportMenuItemHidden(row, !available || deps.isSimpleWebGLPipelineActive());
                btnShaderLabPanel.disabled = !available;
                btnShaderLabPanel.classList.toggle('disabled', !available);
                btnShaderLabPanel.title = available
                    ? 'Shader Lab by basement.studio'
                    : 'Shader Lab requires WebGPU or Force WebGL';
            }
            if (!available && shaderLabPanelVisible) {
                setShaderLabPanelVisible(false);
            }
            return available;
        }

        function setShaderLabPanelVisible(visible) {
            shaderLabPanelVisible = !!visible && isShaderLabBackendAvailable();
            if (!shaderLabPanelVisible) {
                const ae = document.activeElement;
                if (ae instanceof HTMLElement && shaderLabPanel.contains(ae)) btnShaderLabPanel?.focus();
            }
            shaderLabPanel.classList.toggle('visible', shaderLabPanelVisible);
            shaderLabPanel.toggleAttribute('inert', !shaderLabPanelVisible);
            shaderLabPanel.setAttribute('aria-hidden', String(!shaderLabPanelVisible));
            btnShaderLabPanel?.classList.toggle('active', shaderLabPanelVisible);
            if (shaderLabPanelVisible && !shaderLabPanelApp) {
                createShaderLabPanel({
                    panelEl: shaderLabPanel,
                    shaderLabFx: deps.shaderLabFx,
                    onHide: () => setShaderLabPanelVisible(false),
                }).then(app => { shaderLabPanelApp = app; }).catch(err => {
                    shaderLabPanel.innerHTML =
                        '<div class="sidepanel-header"><div>' +
                        '<div class="sidepanel-title">Shader Lab</div>' +
                        '<div class="sidepanel-subtitle" style="color:#f66">' +
                        'Failed to load: ' + String(err.message || err) +
                        '</div></div></div>';
                    console.error('[ShaderLabPanel] React load failed:', err);
                });
            }
            syncShaderLabAvailability();
        }

        // ── Canvas Panel ────────────────────────────────────
        const btnCanvasPanel = document.getElementById('btnCanvasPanel');
        const canvasPanel = document.getElementById('canvasPanel');
        let canvasPanelVisible = false;
        let canvasPanelApp = null;

        function setCanvasPanelVisible(visible) {
            canvasPanelVisible = !!visible;
            if (!canvasPanelVisible) {
                const ae = document.activeElement;
                if (ae instanceof HTMLElement && canvasPanel.contains(ae)) btnCanvasPanel?.focus();
            }
            canvasPanel.classList.toggle('visible', canvasPanelVisible);
            canvasPanel.toggleAttribute('inert', !canvasPanelVisible);
            canvasPanel.setAttribute('aria-hidden', String(!canvasPanelVisible));
            btnCanvasPanel?.classList.toggle('active', canvasPanelVisible);
            if (canvasPanelVisible && !canvasPanelApp) {
                // Lazy-mount on first open so React isn't fetched on load.
                createCanvasPanel({
                    panelEl: canvasPanel,
                    getProjectBaseUrl: () => deps.projectRuntime?.getState?.().projectRootUrl || '',
                    onHide: () => setCanvasPanelVisible(false),
                }).then(app => { canvasPanelApp = app; }).catch(err => {
                    canvasPanel.innerHTML =
                        '<div class="sidepanel-header"><div>' +
                        '<div class="sidepanel-title">Canvas</div>' +
                        '<div class="sidepanel-subtitle" style="color:#f66">' +
                        'Failed to load React: ' + String(err.message || err) +
                        '</div></div></div>';
                    console.error('[CanvasPanel] React load failed:', err);
                });
            } else if (canvasPanelVisible && canvasPanelApp) {
                canvasPanelApp.render();
            }
        }
        let _layerManagerUnsub = null;
        let _projectRuntimeUnsub = null;

        function queueLayersPanelRefresh() {
            layersPanelDirty = true;
            if (!layersPanelVisible || layersPanelRefreshQueued) return;
            layersPanelRefreshQueued = true;
            requestAnimationFrame(() => {
                layersPanelRefreshQueued = false;
                if (!layersPanelVisible || !layersPanelDirty) return;
                layersPanelDirty = false;
                refreshLayersPanel();
            });
        }

        function attachLayerPanelSubscriptions() {
            _layerManagerUnsub?.();
            _projectRuntimeUnsub?.();
            _layerManagerUnsub = deps._layerManagerRef?.subscribe?.(() => queueLayersPanelRefresh()) ?? null;
            _projectRuntimeUnsub = deps._projectRuntimeRef?.subscribe?.(() => {
                queueLayersPanelRefresh();
                syncProjectStudioState();
                deps.syncProjectBakeState();
                deps.syncProjectPostFxState();
            }) ?? null;
        }

        function getPanelLayers() {
            // listEntries() is the single source of truth — driven by the
            // C++ inlines/ folder scan via inline_layers_state.
            return deps._projectRuntimeRef?.listEntries?.() ?? [];
        }

        function getProjectRuntimeState() {
            return deps._projectRuntimeRef?.getState?.() ?? {};
        }

        function getLayerStatus(layer) {
            if (layer.error) return { label: 'ERR', className: 'err' };
            if (layer.loading) return { label: 'LOAD', className: 'off' };
            if (layer.enabled === false) return { label: 'OFF', className: 'off' };
            return layer.active ? { label: 'LIVE', className: 'live' } : { label: 'OFF', className: 'off' };
        }

        function getLayerDetails(layer) {
            const details = [];
            if (layer.entry) {
                details.push(layer.source === 'inline' && layer.enabled === false
                    ? `${layer.entry}.disabled`
                    : layer.entry);
            } else if (layer.source === 'inline') {
                details.push(`inlines/${layer.id}.js${layer.enabled === false ? '.disabled' : ''}`);
            }
            if (Number.isFinite(layer.profile?.avgUpdateMs) && layer.profile.updateCount > 0) {
                details.push(`avg ${layer.profile.avgUpdateMs.toFixed(2)}ms`);
            }
            details.push(`anc ${layer.anchors ?? 0}`);
            details.push(`trk ${layer.tracked ?? 0}`);
            return details.join(' | ');
        }

        function handleLayerToggle(layer) {
            const nextEnabled = !(layer.enabled !== false);
            // Pure runtime flag flip. No await, no dispose, no remount,
            // no manifest write. File rename is fire-and-forget and never
            // blocks the UI or affects the visual state.
            try { deps._layerManagerRef?.setActive?.(layer.id, nextEnabled); }
            catch (err) { deps.maxjsDebugWarn('[max.js layer toggle] setActive failed', layer.id, err); }
            queueLayersPanelRefresh();
            deps._projectRuntimeRef?.setInlineLayerEnabled?.(layer.id, nextEnabled)
                ?.catch?.(err => {
                    deps.maxjsDebugWarn('[max.js layer toggle] persist failed', layer.id, err);
                });
        }

        async function handleLayerRemove(layer) {
            try {
                if (layer.source === 'inline' && deps._projectRuntimeRef?.removeInlineLayer) {
                    await deps._projectRuntimeRef.removeInlineLayer(layer.id);
                    deps._layerManagerRef?.remove(layer.id);
                } else if (layer.source === 'project') {
                    await deps._projectRuntimeRef?.removeLayer(layer.id);
                } else {
                    deps._layerManagerRef?.remove(layer.id);
                }
            } catch (error) {
                deps.reportBridgeError('layer remove', error);
            }
        }

        async function handleReleaseProjectManifest() {
            try {
                await deps._projectRuntimeRef?.releaseManifest?.();
            } catch (error) {
                deps.reportBridgeError('release project manifest', error);
            }
        }

        function formatLayerParamValue(param) {
            if (param?.type === 'color') return String(param.value || '#ffffff').toLowerCase();
            if (param?.type === 'bool') return param.value ? 'On' : 'Off';
            if (param?.type === 'string') return String(param.value ?? '');
            const n = Number(param?.value);
            if (!Number.isFinite(n)) return String(param?.value ?? '');
            if (Math.abs(n) >= 100) return n.toFixed(1).replace(/\.0$/, '');
            if (Math.abs(n) >= 10) return n.toFixed(2).replace(/\.?0+$/, '');
            return n.toFixed(3).replace(/\.?0+$/, '');
        }

        function layerParamNumberAttrs(param) {
            const attrs = [];
            if (Number.isFinite(Number(param.min))) attrs.push(`min="${Number(param.min)}"`);
            if (Number.isFinite(Number(param.max))) attrs.push(`max="${Number(param.max)}"`);
            if (param.step != null) attrs.push(`step="${escapeWebPanelText(param.step)}"`);
            return attrs.join(' ');
        }

        function renderLayerParamControl(layer, param) {
            const name = String(param?.name || '');
            if (!name) return '';
            const idAttr = escapeWebPanelText(layer.id);
            const nameAttr = escapeWebPanelText(name);
            const label = escapeWebPanelText(param.label || name);
            const title = escapeWebPanelText(param.description || param.label || name);
            const value = param.type === 'color'
                ? escapeWebPanelText(String(param.value || '#ffffff'))
                : escapeWebPanelText(String(param.value ?? ''));
            const common = `data-layer-param-layer="${idAttr}" data-layer-param="${nameAttr}" data-layer-param-type="${escapeWebPanelText(param.type || '')}"`;
            const valueHtml = `<span class="layer-param-value" data-layer-param-value>${escapeWebPanelText(formatLayerParamValue(param))}</span>`;

            if (param.type === 'slider') {
                return `<label class="layer-param layer-param-slider" title="${title}">
                    <span class="layer-param-head"><span>${label}</span>${valueHtml}</span>
                    <input class="layer-param-input layer-param-range fx-range" type="range" ${common} ${layerParamNumberAttrs(param)} value="${value}">
                </label>`;
            }
            if (param.type === 'float') {
                return `<label class="layer-param layer-param-float" title="${title}">
                    <span class="layer-param-head"><span>${label}</span>${valueHtml}</span>
                    <input class="layer-param-input layer-param-number" type="number" ${common} ${layerParamNumberAttrs(param)} value="${value}">
                </label>`;
            }
            if (param.type === 'color') {
                return `<label class="layer-param layer-param-color" title="${title}">
                    <span class="layer-param-head"><span>${label}</span>${valueHtml}</span>
                    <input class="layer-param-input layer-param-swatch" type="color" ${common} value="${value}">
                </label>`;
            }
            if (param.type === 'bool') {
                return `<label class="layer-param layer-param-bool" title="${title}">
                    <span class="layer-param-head"><span>${label}</span>${valueHtml}</span>
                    <input class="layer-param-input layer-param-check" type="checkbox" ${common} ${param.value ? 'checked' : ''}>
                </label>`;
            }
            if (param.type === 'string') {
                return `<label class="layer-param layer-param-string" title="${title}">
                    <span class="layer-param-head"><span>${label}</span>${valueHtml}</span>
                    <input class="layer-param-input layer-param-text" type="text" ${common} value="${value}">
                </label>`;
            }
            return '';
        }

        function renderLayerParams(layer) {
            const params = Array.isArray(layer.parameters) ? layer.parameters : [];
            if (params.length === 0) return '';
            const controls = params.map(param => renderLayerParamControl(layer, param)).filter(Boolean).join('');
            return controls ? `<div class="layer-params">${controls}</div>` : '';
        }

        function readLayerParamInput(input) {
            if (input.type === 'checkbox') return input.checked;
            return input.value;
        }

        function syncLayerParamControl(control, param) {
            if (!control || !param) return;
            const valueEl = control.querySelector('[data-layer-param-value]');
            if (valueEl) valueEl.textContent = formatLayerParamValue(param);
            control.querySelectorAll('input[data-layer-param]').forEach(input => {
                if (input.type === 'checkbox') {
                    input.checked = !!param.value;
                } else if (document.activeElement !== input || input.type === 'range' || input.type === 'color') {
                    input.value = String(param.value ?? '');
                }
            });
        }

        function handleLayerParamInput(input, commit = false) {
            if (!input) return;
            if ((input.type === 'number' || input.type === 'range') && !Number.isFinite(Number(input.value))) return;
            const layerId = input.dataset.layerParamLayer;
            const name = input.dataset.layerParam;
            if (!layerId || !name) return;
            const param = deps._layerManagerRef?.setParameter?.(layerId, name, readLayerParamInput(input), {
                source: 'ui',
                silent: !commit,
            });
            if (param) syncLayerParamControl(input.closest('.layer-param'), param);
            if (param && commit) {
                deps._projectRuntimeRef?.persistLayerParameterValue?.(layerId, name, param.value)
                    ?.catch?.(error => {
                        deps.reportBridgeError('save runtime layer parameter', error);
                    });
            }
        }

        function refreshLayersPanel() {
            if (!layersPanelVisible || !deps._layerManagerRef) return;
            const projectState = getProjectRuntimeState();
            const layers = getPanelLayers();
            const projectReady = projectState.manifestExists === true;
            const canReleaseProject = projectState.sceneSaved === true && !projectReady;
            const sceneExt = getHostProfile().sceneExt;
            const emptyHtml = !projectState.sceneSaved
                ? `<div class="layers-empty">Save the scene first. max.js creates <code>project.maxjs.json</code> and <code>inlines/</code> next to the <code>${sceneExt}</code> file.</div>`
                : !projectReady
                    ? `<div class="layers-empty">This scene has no max.js project yet. Create scene-local runtime files next to the <code>${sceneExt}</code> file.<div style="margin-top:10px"><button id="layersReleaseBtn">Release Project Manifest</button></div></div>`
                    : '<div class="layers-empty">No layers yet. Scene-local project files live in <code>project.maxjs.json</code> and <code>inlines/</code>.</div>';

            const renderLayerItem = (l) => `
                <div class="layer-item${l.error ? ' error' : ''}${!l.active ? ' inactive' : ''}">
                    <div class="layer-main">
                        <div class="layer-meta">
                            <span class="layer-name" title="${escapeWebPanelText(l.name)}">${escapeWebPanelText(l.name)}</span>
                            ${Number.isFinite(l.priority) && l.priority !== 100 ? `<span class="layer-priority" title="Load priority (lower = earlier)">${l.priority}</span>` : ''}
                            <span class="layer-source ${l.source === 'project' ? 'project' : 'inline'}">${l.source}</span>
                            <span class="layer-status ${getLayerStatus(l).className}">${getLayerStatus(l).label}</span>
                        </div>
                        <div class="layer-detail" title="${escapeWebPanelText(getLayerDetails(l))}">${escapeWebPanelText(getLayerDetails(l))}</div>
                    </div>
                    <div class="layer-actions">
                        ${l.source === 'project' || l.persisted !== false
                            ? `<button class="layer-action layer-toggle" data-layer-toggle="${escapeWebPanelText(l.id)}">${l.enabled === false ? 'Enable' : 'Disable'}</button>`
                            : ''
                        }
                    </div>
                    ${renderLayerParams(l)}
                </div>`;

            // Group by folder. Root ('') renders flat at top; named folders render as
            // <details> collapsibles below. Collapse state persists in localStorage.
            const collapseKey = 'maxjs.layers.folderCollapse';
            let collapseState = {};
            try { collapseState = JSON.parse(localStorage.getItem(collapseKey) || '{}') || {}; } catch {}

            const rootLayers = [];
            const byFolder = new Map();
            for (const l of layers) {
                const f = typeof l.folder === 'string' ? l.folder : '';
                if (!f) { rootLayers.push(l); continue; }
                let set = byFolder.get(f);
                if (!set) { set = []; byFolder.set(f, set); }
                set.push(l);
            }
            const folders = [...byFolder.keys()].sort();

            const itemsHtml = layers.length === 0
                ? emptyHtml
                : [
                    ...rootLayers.map(renderLayerItem),
                    ...folders.map(folder => {
                        const items = byFolder.get(folder).map(renderLayerItem).join('');
                        const isOpen = collapseState[folder] !== false;
                        return `<details class="layer-folder"${isOpen ? ' open' : ''} data-folder="${folder}">
                            <summary class="layer-folder-header"><span class="layer-folder-name">${folder}</span><span class="layer-folder-count">${byFolder.get(folder).length}</span></summary>
                            <div class="layer-folder-body">${items}</div>
                        </details>`;
                    }),
                ].join('');

            layersPanel.innerHTML = `
                <div class="sidepanel-header">
                    <div>
                        <div class="sidepanel-title">Runtime Layers (inlines)</div>
                        <div class="sidepanel-subtitle">${layers.length} tracked</div>
                    </div>
                    <div style="display:flex;gap:4px">
                        ${canReleaseProject && layers.length > 0 ? '<button id="layersReleaseBtn">Release Project Manifest</button>' : ''}
                        <button id="layersHideBtn">Hide</button>
                    </div>
                </div>
                <div class="sidepanel-body">${itemsHtml}</div>
            `;

            layersPanel.querySelector('#layersHideBtn')?.addEventListener('click', () => setLayersPanelVisible(false));
            layersPanel.querySelector('#layersReleaseBtn')?.addEventListener('click', () => { void handleReleaseProjectManifest(); });
            layersPanel.querySelectorAll('[data-layer-toggle]').forEach(btn => {
                btn.addEventListener('click', () => {
                    const layer = layers.find(item => item.id === btn.dataset.layerToggle);
                    if (layer) void handleLayerToggle(layer);
                });
            });
            layersPanel.querySelectorAll('[data-layer-remove]').forEach(btn => {
                btn.addEventListener('click', () => {
                    const layer = layers.find(item => item.id === btn.dataset.layerRemove);
                    if (layer) void handleLayerRemove(layer);
                });
            });
            layersPanel.querySelectorAll('input[data-layer-param]').forEach(input => {
                input.addEventListener('input', () => handleLayerParamInput(input, false));
                input.addEventListener('change', () => handleLayerParamInput(input, true));
            });
            layersPanel.querySelectorAll('details[data-folder]').forEach(el => {
                el.addEventListener('toggle', () => {
                    const folder = el.dataset.folder;
                    let state = {};
                    try { state = JSON.parse(localStorage.getItem(collapseKey) || '{}') || {}; } catch {}
                    state[folder] = el.open;
                    try { localStorage.setItem(collapseKey, JSON.stringify(state)); } catch {}
                });
            });
        }

        // ── Web Panels (WebApp Animator flipswitch) ──────────
        // List-shaped, refresh-driven — same shape as the layers panel. The
        // flipswitch never mutates viewer state directly: it sends webapp_set
        // to Max (theHold-wrapped, undoable) and re-renders from the
        // webapp_update round-trip, so the param block stays authoritative.
        const btnWebPanels = document.getElementById('btnWebPanels');
        const webPanelsPanel = document.getElementById('webPanelsPanel');
        let webPanelsVisible = false;
        let webPanelsRefreshQueued = false;

        function escapeWebPanelText(value) {
            return String(value ?? '')
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        }

        function setWebPanelsVisible(visible) {
            webPanelsVisible = !!visible;
            if (!webPanelsVisible) {
                const ae = document.activeElement;
                if (ae instanceof HTMLElement && webPanelsPanel.contains(ae)) btnWebPanels?.focus();
            }
            webPanelsPanel.classList.toggle('visible', webPanelsVisible);
            webPanelsPanel.toggleAttribute('inert', !webPanelsVisible);
            webPanelsPanel.setAttribute('aria-hidden', String(!webPanelsVisible));
            btnWebPanels?.classList.toggle('active', webPanelsVisible);
            if (webPanelsVisible) queueWebPanelsRefresh();
        }

        function queueWebPanelsRefresh() {
            if (!webPanelsVisible || webPanelsRefreshQueued) return;
            webPanelsRefreshQueued = true;
            requestAnimationFrame(() => {
                webPanelsRefreshQueued = false;
                if (webPanelsVisible) refreshWebPanelsPanel();
            });
        }

        function refreshWebPanelsPanel() {
            const panels = deps.webappSystem?.listPanels?.() ?? [];
            const renderRow = (p) => `
                <div class="layer-item${p.visible ? '' : ' inactive'}">
                    <div class="layer-main">
                        <div class="layer-meta">
                            <span class="layer-name" title="${escapeWebPanelText(p.name)}">${escapeWebPanelText(p.name)}</span>
                            <span class="layer-source inline">#${p.handle}</span>
                            ${p.layerCount > 1 ? `<span class="layer-priority" title="Layer stack">x${p.layerCount}</span>` : ''}
                        </div>
                        <div class="layer-detail" title="${escapeWebPanelText(p.url)}">${escapeWebPanelText(p.url || '(no url)')}</div>
                    </div>
                    <div class="layer-actions webpanel-switch" data-webpanel="${p.handle}">
                        <button class="fx-toggle${p.presentation === 'css3d' ? ' active' : ''}" data-presentation="0" title="DOM overlay — crisp, interactive, outside the framebuffer">CSS3D</button>
                        <button class="fx-toggle${p.presentation === 'texture' ? ' active' : ''}" data-presentation="1" title="In-scene pixels — post FX, depth, render output apply">Canvas</button>
                        <button class="fx-toggle${p.depthOcclude ? ' active' : ''}" data-depth-occlude="${p.depthOcclude ? '0' : '1'}"
                            ${p.presentation === 'texture' ? 'disabled' : ''}
                            title="CSS3D behind the canvas with punch-through compositing — scene geometry occludes the panel per pixel">Depth</button>
                    </div>
                </div>`;
            webPanelsPanel.innerHTML = `
                <div class="sidepanel-header">
                    <div>
                        <div class="sidepanel-title">Web Panels</div>
                        <div class="sidepanel-subtitle">${panels.length} WebApp Animator node${panels.length === 1 ? '' : 's'}</div>
                    </div>
                    <div style="display:flex;gap:4px">
                        <button id="webPanelsHideBtn">Hide</button>
                    </div>
                </div>
                <div class="sidepanel-body">${panels.length === 0
                    ? '<div class="layers-empty">No WebApp Animator nodes in the scene. Create one from the <code>max.js</code> category in the Create panel.</div>'
                    : panels.map(renderRow).join('')}</div>
            `;
            webPanelsPanel.querySelector('#webPanelsHideBtn')?.addEventListener('click', () => setWebPanelsVisible(false));
            webPanelsPanel.querySelectorAll('.webpanel-switch button').forEach(btn => {
                btn.addEventListener('click', () => {
                    if (btn.classList.contains('pending') || btn.disabled) return;
                    const handle = btn.closest('[data-webpanel]')?.dataset.webpanel;
                    if (!handle) return;
                    if (btn.dataset.depthOcclude !== undefined) {
                        deps.bridge.send('webapp_set', { handle: String(handle), depthOcclude: btn.dataset.depthOcclude === '1' });
                    } else {
                        if (btn.classList.contains('active')) return;
                        deps.bridge.send('webapp_set', { handle: String(handle), presentation: Number(btn.dataset.presentation) });
                    }
                    btn.classList.add('pending');  // cleared by the round-trip re-render
                });
            });
        }

        btnWebPanels?.addEventListener('click', () => setWebPanelsVisible(!webPanelsVisible));

        btnLayersPanel.addEventListener('click', () => setLayersPanelVisible(!layersPanelVisible));
        btnCanvasPanel?.addEventListener('click', () => setCanvasPanelVisible(!canvasPanelVisible));
        btnShaderLabPanel?.addEventListener('click', () => {
            if (!isShaderLabBackendAvailable()) {
                deps.perfHud.setStatus('max.js - Shader Lab requires WebGPU or Force WebGL');
                syncShaderLabAvailability();
                return;
            }
            setShaderLabPanelVisible(!shaderLabPanelVisible);
        });
        syncShaderLabAvailability();

        document.getElementById('btnLightHelpers')?.addEventListener('click', () => {
            deps.setLightHelpersVisible(!deps.lightHelpersVisible);
        });


        const btnPostFxPanel = document.getElementById('btnPostFxPanel');
        const rightDock = document.getElementById('rightDock');
        const postPanel = document.getElementById('postPanel');
        function clampDockWidth(width) {
            const numeric = Number.parseFloat(width);
            const maxWidth = Math.max(200, window.innerWidth - 16);
            return Math.max(200, Math.min(Number.isFinite(numeric) ? numeric : 240, maxWidth));
        }

        function setRightDockWidth(width) {
            const clamped = clampDockWidth(width);
            document.documentElement.style.setProperty('--dock-width', `${clamped}px`);
            if (rightDock) rightDock.style.width = '';
            return clamped;
        }



        return {
            setRailButtonMeta,
            setViewportMenuItemHidden,
            syncSimpleWebGLPipelineUi,
            syncStudioOnlyUi,
            syncAudioMuteButtonUi,
            syncBackgroundColorSlot,
            syncEnvButtonUi,
            enterAsciiMode,
            exitAsciiMode,
            rebuildAsciiEffect,
            setReflPaintPanelVisible,
            serializeReflectionPaintState,
            applyReflectionPaintState,
            readLegacyReflectionPaintState,
            rebuildReflPaintPanel,
            serializeStudioState,
            applyStudioState,
            saveLegacyStudioStateFallback,
            restoreLegacyStudioStateFallback,
            scheduleProjectStudioSave,
            flushProjectStudioSave,
            saveStudioState,
            restoreStudioState,
            syncProjectStudioState,
            setLayersPanelVisible,
            setShaderLabPanelVisible,
            isShaderLabBackendAvailable,
            syncShaderLabAvailability,
            setCanvasPanelVisible,
            attachLayerPanelSubscriptions,
            queueLayersPanelRefresh,
            setWebPanelsVisible,
            queueWebPanelsRefresh,
            escapeWebPanelText,
            setRightDockWidth,
            clampDockWidth,
            btnLightProbe,
            btnPostFxPanel,
            rightDock,
            postPanel,
            isClayModeActive: () => clayModeActive,
            setClayPreFxSnapshot: (snapshot) => { clayPreFxSnapshot = snapshot; },
        };
}

export { createPanelsMisc };

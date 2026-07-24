// snapshot_export.js - editor snapshot export settings, host wire payloads, and diagnostics overlay.
import { analyzeSnapshotPayload, formatBytes, formatPercent } from '../snapshot_diagnostics.js';

function createSnapshotExport(deps = {}) {
        const SNAPSHOT_SETTINGS_KEY = 'maxjs_snapshot_settings';
        const SNAPSHOT_SETTINGS_DEFAULTS = Object.freeze({
            includeSceneNodes: true,
            includeEnvironment: true,
            includeFog: true,
            includeLights: true,
            includeAudios: true,
            includeInstances: true,
            includeUnusedChannels: false,
            includeAllMorphTargets: false,
            includeDebugPayload: false,
            includeSnapshotUi: true,
            includeRuntimeScene: true,
            includeDisabledLayers: false,
            copyAssets: true,
            includeRapierVendor: false,
            includeGeospatialSky: false,
            includeAnimations: true,
            includeTransformAnimation: true,
            includeGeometryAnimation: true,
            includeMaterialAnimation: true,
            includeCameraAnimation: true,
            animationSampleStepFrames: 1,
        });

        function sanitizeSnapshotSettings(value) {
            const raw = value && typeof value === 'object' ? value : {};
            const sanitized = { ...SNAPSHOT_SETTINGS_DEFAULTS };
            for (const key of Object.keys(SNAPSHOT_SETTINGS_DEFAULTS)) {
                if (!(key in raw)) continue;
                if (key === 'animationSampleStepFrames') {
                    const step = Math.round(Number(raw[key]));
                    sanitized[key] = Number.isFinite(step) ? Math.min(120, Math.max(1, step)) : 1;
                } else {
                    sanitized[key] = !!raw[key];
                }
            }
            return sanitized;
        }

        function getSnapshotExportSettings() {
            const settings = sanitizeSnapshotSettings(snapshotSettings);
            // NOTE: snapshotUi (post-fx, camera) and runtimeScene (layers) are essential
            // for working snapshots - don't gate them behind includeDebugPayload
            settings.includeSnapshotUi = true;
            settings.includeRuntimeScene = true;
            if (!settings.includeAnimations) {
                settings.includeTransformAnimation = false;
                settings.includeGeometryAnimation = false;
                settings.includeMaterialAnimation = false;
                settings.includeCameraAnimation = false;
            }
            return settings;
        }

        function loadSnapshotSettings() {
            try {
                const raw = localStorage.getItem(SNAPSHOT_SETTINGS_KEY);
                if (!raw) return { ...SNAPSHOT_SETTINGS_DEFAULTS };
                return sanitizeSnapshotSettings(JSON.parse(raw));
            } catch {
                return { ...SNAPSHOT_SETTINGS_DEFAULTS };
            }
        }

        function saveSnapshotSettings() {
            try {
                localStorage.setItem(SNAPSHOT_SETTINGS_KEY, JSON.stringify(snapshotSettings));
            } catch {}
        }

        let snapshotSettings = loadSnapshotSettings();
        const btnSnapshotPanel = document.getElementById('btnSnapshotPanel');
        const snapshotPanel = document.getElementById('snapshotPanel');
        let snapshotPanelVisible = false;
        let pendingSnapshotRequestId = null;
        let pendingSnapshotServeRequestId = null;
        let pendingSnapshotServeAfterExport = false;
        let pendingSnapshotAnalyze = false;
        let lastSnapshotExportPath = '';
        let lastSnapshotServeUrl = '';

        function setSnapshotPanelVisible(visible) {
            snapshotPanelVisible = !!visible;
            if (!snapshotPanelVisible) {
                const activeElement = document.activeElement;
                if (activeElement instanceof HTMLElement && snapshotPanel.contains(activeElement)) {
                    btnSnapshotPanel.focus();
                }
            }
            snapshotPanel.classList.toggle('visible', snapshotPanelVisible);
            snapshotPanel.toggleAttribute('inert', !snapshotPanelVisible);
            snapshotPanel.setAttribute('aria-hidden', String(!snapshotPanelVisible));
            btnSnapshotPanel.classList.toggle('active', snapshotPanelVisible);
            if (snapshotPanelVisible) {
                buildSnapshotPanel();
                syncSnapshotPanel();
            }
        }

        function updateSnapshotSetting(key, value) {
            snapshotSettings = sanitizeSnapshotSettings({
                ...snapshotSettings,
                [key]: key === 'animationSampleStepFrames' ? Number(value) : !!value,
            });
            saveSnapshotSettings();
            syncSnapshotPanel();
        }

        function resetSnapshotSettings() {
            snapshotSettings = { ...SNAPSHOT_SETTINGS_DEFAULTS };
            saveSnapshotSettings();
            syncSnapshotPanel();
        }

        function buildSnapshotPanel() {
            snapshotPanel.innerHTML = `
                <div class="sidepanel-header">
                    <div>
                        <div class="sidepanel-title">Snapshot</div>
                        <div class="sidepanel-subtitle" id="snapshotPanelStatus">Saved export profile</div>
                    </div>
                    <div style="display:flex;gap:4px">
                        <button id="snapshotResetBtn" type="button">Reset</button>
                        <button id="snapshotHideBtn" type="button">Hide</button>
                    </div>
                </div>
                <div class="sidepanel-body">
                    <section class="fx-section">
                        <div class="fx-section-header">
                            <div class="fx-section-title">Content</div>
                        </div>
                        <div class="snapshot-grid">
                            <label class="fx-check" for="snapshot-includeSceneNodes"><span>Scene Nodes</span><input id="snapshot-includeSceneNodes" type="checkbox"></label>
                            <label class="fx-check" for="snapshot-includeEnvironment"><span>Environment</span><input id="snapshot-includeEnvironment" type="checkbox"></label>
                            <label class="fx-check" for="snapshot-includeFog"><span>Fog</span><input id="snapshot-includeFog" type="checkbox"></label>
                            <label class="fx-check" for="snapshot-includeLights"><span>Lights</span><input id="snapshot-includeLights" type="checkbox"></label>
                            <label class="fx-check" for="snapshot-includeAudios"><span>Audio</span><input id="snapshot-includeAudios" type="checkbox"></label>
                            <label class="fx-check" for="snapshot-includeInstances"><span>Instances</span><input id="snapshot-includeInstances" type="checkbox"></label>
                            <label class="fx-check" for="snapshot-includeUnusedChannels" title="Export stray vertex-color map channels (≥3, e.g. extra UVW sets). Off = lean export; tick only if a material reads maxjs_vc_N."><span>Unused VC Channels</span><input id="snapshot-includeUnusedChannels" type="checkbox"></label>
                            <label class="fx-check" for="snapshot-includeAllMorphTargets" title="Keep zero unkeyed Morpher channels in the snapshot. Off prunes channels that sit at 0 and have no keys."><span>All Morph Channels</span><input id="snapshot-includeAllMorphTargets" type="checkbox"></label>
                            <label class="fx-check" for="snapshot-includeDebugPayload"><span>Debug Payload</span><input id="snapshot-includeDebugPayload" type="checkbox"></label>
                            <label class="fx-check" for="snapshot-includeSnapshotUi"><span>Viewer UI State</span><input id="snapshot-includeSnapshotUi" type="checkbox"></label>
                            <label class="fx-check" for="snapshot-includeRuntimeScene"><span>JS Runtime Scene</span><input id="snapshot-includeRuntimeScene" type="checkbox"></label>
                            <label class="fx-check" for="snapshot-includeDisabledLayers" title="Archive disabled scene-script sources and runtime data into the snapshot. Off keeps deploy exports lean and prevents disabled layers from being replayed."><span>Disabled Layers</span><input id="snapshot-includeDisabledLayers" type="checkbox"></label>
                            <label class="fx-check" for="snapshot-copyAssets"><span>Copy Assets</span><input id="snapshot-copyAssets" type="checkbox"></label>
                        </div>
                        <div class="snapshot-note">Copy Assets should stay on for deployable snapshots. Debug Payload controls viewer UI, runtime scene, and debug-side snapshot extras.</div>
                    </section>
                    <section class="fx-section">
                        <div class="fx-section-header">
                            <div class="fx-section-title">Vendor</div>
                        </div>
                        <div class="snapshot-grid">
                            <label class="fx-check" for="snapshot-includeRapierVendor"><span>Rapier Physics</span><input id="snapshot-includeRapierVendor" type="checkbox"></label>
                            <label class="fx-check" for="snapshot-includeGeospatialSky" title="Bundle the @takram atmosphere packages + three/src node sources (~6 MB) needed by the planetary/geospatial sky. Off keeps exports lean; tick only for scenes using the planetary sky model."><span>Geospatial Sky</span><input id="snapshot-includeGeospatialSky" type="checkbox"></label>
                        </div>
                        <div class="snapshot-note">Only needed for physics runtime layers (Rapier) or the planetary/geospatial sky model.</div>
                    </section>
                    <section class="fx-section">
                        <div class="fx-section-header">
                            <div class="fx-section-title">Animation</div>
                        </div>
                        <div class="snapshot-grid">
                            <label class="fx-check" for="snapshot-includeAnimations"><span>Export Animation</span><input id="snapshot-includeAnimations" type="checkbox"></label>
                            <label class="fx-check" for="snapshot-includeTransformAnimation"><span>Transform + Visibility</span><input id="snapshot-includeTransformAnimation" type="checkbox"></label>
                            <label class="fx-check" for="snapshot-includeGeometryAnimation"><span>Geometry / Vertex</span><input id="snapshot-includeGeometryAnimation" type="checkbox"></label>
                            <label class="fx-check" for="snapshot-includeMaterialAnimation"><span>Material Params</span><input id="snapshot-includeMaterialAnimation" type="checkbox"></label>
                            <label class="fx-check" for="snapshot-includeCameraAnimation"><span>Active Camera</span><input id="snapshot-includeCameraAnimation" type="checkbox"></label>
                            <label class="snapshot-inline" for="snapshot-animationSampleStepFrames">
                                <span>Sample Every N Frames</span>
                                <input id="snapshot-animationSampleStepFrames" type="number" min="1" max="120" step="1">
                            </label>
                        </div>
                        <div class="snapshot-note">Material and geometry export are baked from the Max scene. Higher sample steps reduce export cost but also reduce fidelity.</div>
                    </section>
                    <section class="fx-section">
                        <div class="fx-section-header">
                            <div class="fx-section-title">Actions</div>
                        </div>
                        <div class="snapshot-actions">
                            <button id="snapshotExportBtn" type="button">Export Snapshot</button>
                            <button id="snapshotServeBtn" type="button">Serve Snapshot</button>
                            <button id="snapshotAnalyzeBtn" type="button">Analyze Snapshot</button>
                        </div>
                        <div id="snapshotExportLocation" class="snapshot-location" hidden></div>
                        <div class="snapshot-note">Settings persist across sessions.</div>
                    </section>
                </div>
            `;

            snapshotPanel.querySelector('#snapshotHideBtn')?.addEventListener('click', () => setSnapshotPanelVisible(false));
            snapshotPanel.querySelector('#snapshotResetBtn')?.addEventListener('click', () => resetSnapshotSettings());
            snapshotPanel.querySelector('#snapshotExportBtn')?.addEventListener('click', () => {
                void exportSnapshotWithSettings();
            });
            snapshotPanel.querySelector('#snapshotServeBtn')?.addEventListener('click', () => {
                void serveSnapshotWithSettings();
            });
            snapshotPanel.querySelector('#snapshotAnalyzeBtn')?.addEventListener('click', () => {
                void analyzeSnapshotFromHost();
            });

            for (const key of Object.keys(SNAPSHOT_SETTINGS_DEFAULTS)) {
                const input = snapshotPanel.querySelector(`#snapshot-${key}`);
                if (!input) continue;
                const eventName = input.type === 'number' ? 'input' : 'change';
                input.addEventListener(eventName, () => {
                    updateSnapshotSetting(key, input.type === 'number' ? input.value : input.checked);
                });
            }
        }

        function syncSnapshotPanel() {
            if (!snapshotPanelVisible) return;

            const effective = getSnapshotExportSettings();
            const exportButton = snapshotPanel.querySelector('#snapshotExportBtn');
            const serveButton = snapshotPanel.querySelector('#snapshotServeBtn');
            const analyzeButton = snapshotPanel.querySelector('#snapshotAnalyzeBtn');
            const status = snapshotPanel.querySelector('#snapshotPanelStatus');
            const location = snapshotPanel.querySelector('#snapshotExportLocation');
            if (status) {
                if (!window.chrome?.webview) status.textContent = 'Available only inside max.js';
                else if (pendingSnapshotAnalyze) status.textContent = 'Analyzing snapshot...';
                else if (pendingSnapshotServeRequestId) status.textContent = 'Serving snapshot...';
                else if (pendingSnapshotRequestId) status.textContent = 'Writing snapshot...';
                else if (lastSnapshotServeUrl) status.textContent = 'Snapshot served';
                else if (lastSnapshotExportPath) status.textContent = 'Snapshot saved';
                else status.textContent = `dist export • step ${effective.animationSampleStepFrames}f`;
            }
            if (location) {
                if (lastSnapshotServeUrl) {
                    location.hidden = false;
                    location.textContent = `Snapshot served at ${lastSnapshotServeUrl}`;
                    location.title = lastSnapshotServeUrl;
                } else if (lastSnapshotExportPath) {
                    location.hidden = false;
                    location.textContent = `Snapshot saved to ${lastSnapshotExportPath}`;
                    location.title = lastSnapshotExportPath;
                } else {
                    location.hidden = true;
                    location.textContent = '';
                    location.removeAttribute('title');
                }
            }
            if (exportButton) {
                exportButton.disabled = !window.chrome?.webview || !!pendingSnapshotRequestId || !!pendingSnapshotServeRequestId || pendingSnapshotAnalyze;
                exportButton.textContent = pendingSnapshotRequestId ? 'Writing...' : 'Export Snapshot';
            }
            if (serveButton) {
                serveButton.disabled = !window.chrome?.webview || !!pendingSnapshotRequestId || !!pendingSnapshotServeRequestId || pendingSnapshotAnalyze;
                serveButton.textContent = pendingSnapshotServeRequestId ? 'Serving...' : 'Serve Snapshot';
            }
            if (analyzeButton) {
                analyzeButton.disabled = !window.chrome?.webview || !!pendingSnapshotRequestId || !!pendingSnapshotServeRequestId || pendingSnapshotAnalyze;
                analyzeButton.textContent = pendingSnapshotAnalyze ? 'Analyzing...' : 'Analyze Snapshot';
            }

            for (const [key, defaultValue] of Object.entries(SNAPSHOT_SETTINGS_DEFAULTS)) {
                const input = snapshotPanel.querySelector(`#snapshot-${key}`);
                if (!input) continue;
                if (typeof defaultValue === 'number') input.value = snapshotSettings[key];
                else input.checked = !!snapshotSettings[key];
            }

            const animationsEnabled = !!snapshotSettings.includeAnimations;
            const sceneNodesEnabled = !!snapshotSettings.includeSceneNodes;
            const animationKeys = ['includeTransformAnimation', 'includeGeometryAnimation', 'includeMaterialAnimation'];
            for (const key of animationKeys) {
                const input = snapshotPanel.querySelector(`#snapshot-${key}`);
                if (input) input.disabled = !animationsEnabled || !sceneNodesEnabled;
            }
            // NOTE: snapshotUi and runtimeScene are NOT gated by debugPayload - they're essential
            const snapshotUiInput = snapshotPanel.querySelector('#snapshot-includeSnapshotUi');
            if (snapshotUiInput) {
                snapshotUiInput.checked = true;
                snapshotUiInput.disabled = true;
            }
            const runtimeSceneInput = snapshotPanel.querySelector('#snapshot-includeRuntimeScene');
            if (runtimeSceneInput) {
                runtimeSceneInput.checked = true;
                runtimeSceneInput.disabled = true;
            }
            const cameraInput = snapshotPanel.querySelector('#snapshot-includeCameraAnimation');
            if (cameraInput) cameraInput.disabled = !animationsEnabled;
            const stepInput = snapshotPanel.querySelector('#snapshot-animationSampleStepFrames');
            if (stepInput) stepInput.disabled = !animationsEnabled;
        }

        function escapeSnapshotDiagnosticHtml(value) {
            return String(value ?? '').replace(/[&<>"']/g, ch => ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#39;',
            }[ch]));
        }

        function snapshotDiagnosticRow(label, value) {
            return `
                <div class="snapshot-diagnostics-row">
                    <span>${escapeSnapshotDiagnosticHtml(label)}</span>
                    <strong>${escapeSnapshotDiagnosticHtml(value)}</strong>
                </div>
            `;
        }

        function renderSnapshotDiagnosticsOverlay(report, path) {
            const sceneBinBytes = report.files.sceneBin || 0;
            const channelRows = Object.entries(report.sceneBinChannels || {})
                .filter(([, bytes]) => bytes > 0)
                .sort((a, b) => b[1] - a[1])
                .map(([name, bytes]) => `
                    <tr>
                        <td>${escapeSnapshotDiagnosticHtml(name)}</td>
                        <td>${escapeSnapshotDiagnosticHtml(formatBytes(bytes))}</td>
                        <td>${escapeSnapshotDiagnosticHtml(formatPercent(bytes, sceneBinBytes))}</td>
                    </tr>
                `).join('');
            const morphRows = (report.morphNodes || []).slice(0, 18).map(node => `
                <tr>
                    <td>${escapeSnapshotDiagnosticHtml(node.name)}</td>
                    <td>${escapeSnapshotDiagnosticHtml(node.channels)}</td>
                    <td>${escapeSnapshotDiagnosticHtml(node.nonzero)}</td>
                    <td>${escapeSnapshotDiagnosticHtml(formatBytes(node.bytes))}</td>
                    <td>${escapeSnapshotDiagnosticHtml((node.names || []).join(', '))}</td>
                </tr>
            `).join('');
            const topRows = (report.topNodes || []).map(node => {
                const rigData = [
                    node.skin ? 'Skin' : '',
                    node.morphChannels ? `Morph ${node.morphChannels}` : '',
                ].filter(Boolean).join(' + ');
                return `
                    <tr>
                        <td>${escapeSnapshotDiagnosticHtml(node.name)}</td>
                        <td>${escapeSnapshotDiagnosticHtml(formatBytes(node.bytes))}</td>
                        <td>${escapeSnapshotDiagnosticHtml(Math.round(node.verts || 0).toLocaleString())}</td>
                        <td>${escapeSnapshotDiagnosticHtml(rigData)}</td>
                    </tr>
                `;
            }).join('');
            const vertexColor = report.vertexColor || {};
            const warnings = [];
            if (report.overlap > 0) warnings.push(`${formatBytes(report.overlap)} overlapping scene.bin ranges`);
            if (report.gap > 0) warnings.push(`${formatBytes(report.gap)} unaccounted scene.bin gaps`);
            if ((report.unknownTypes || []).length) warnings.push(`Unknown buffer types: ${report.unknownTypes.join(', ')}`);
            if (vertexColor.bytesStoredAsF32 > 0) warnings.push(`${formatBytes(vertexColor.bytesStoredAsF32)} vertex colors stored as f32`);

            return `
                <div class="snapshot-diagnostics-window" role="dialog" aria-modal="true" aria-labelledby="snapshotDiagnosticsTitle">
                    <div class="snapshot-diagnostics-header">
                        <div>
                            <div id="snapshotDiagnosticsTitle" class="snapshot-diagnostics-title">Snapshot Diagnostics</div>
                            <div class="snapshot-diagnostics-path">${escapeSnapshotDiagnosticHtml(path || 'Last exported snapshot')}</div>
                        </div>
                        <button id="snapshotDiagnosticsClose" type="button" aria-label="Close snapshot diagnostics">Close</button>
                    </div>
                    <div class="snapshot-diagnostics-body">
                        ${warnings.length ? `<section class="snapshot-diagnostics-alert">${warnings.map(escapeSnapshotDiagnosticHtml).join('<br>')}</section>` : ''}
                        <section class="snapshot-diagnostics-grid">
                            <div class="snapshot-diagnostics-card">
                                <h3>Files</h3>
                                ${snapshotDiagnosticRow('snapshot.json', formatBytes(report.files.snapshotJson))}
                                ${snapshotDiagnosticRow('scene.bin', formatBytes(report.files.sceneBin))}
                                ${snapshotDiagnosticRow('scene_anim.bin', report.files.sceneAnimBin ? formatBytes(report.files.sceneAnimBin) : 'none')}
                            </div>
                            <div class="snapshot-diagnostics-card">
                                <h3>Scene</h3>
                                ${snapshotDiagnosticRow('Nodes', report.totals.nodes.toLocaleString())}
                                ${snapshotDiagnosticRow('Materials', report.totals.materials.toLocaleString())}
                                ${snapshotDiagnosticRow('Vertices', report.totals.verts.toLocaleString())}
                                ${snapshotDiagnosticRow('Triangles', report.totals.tris.toLocaleString())}
                                ${snapshotDiagnosticRow('Animation clips', report.totals.animationClips.toLocaleString())}
                                ${snapshotDiagnosticRow('Morph tracks', report.totals.morphTracks.toLocaleString())}
                            </div>
                            <div class="snapshot-diagnostics-card">
                                <h3>Layout</h3>
                                ${snapshotDiagnosticRow('Accounted bytes', `${formatBytes(report.accounted)} (${formatPercent(report.accounted, sceneBinBytes)})`)}
                                ${snapshotDiagnosticRow('High water', `${formatBytes(report.highWater)} (${formatPercent(report.highWater, sceneBinBytes)})`)}
                                ${snapshotDiagnosticRow('Gaps', formatBytes(report.gap))}
                                ${snapshotDiagnosticRow('Overlaps', formatBytes(report.overlap))}
                            </div>
                            <div class="snapshot-diagnostics-card">
                                <h3>Vertex Colors</h3>
                                ${snapshotDiagnosticRow('Total', formatBytes(vertexColor.total))}
                                ${snapshotDiagnosticRow('Channels', (vertexColor.channels || 0).toLocaleString())}
                                ${snapshotDiagnosticRow('UV2 duplicates', formatBytes(vertexColor.bytesOnUv2Duplicates))}
                                ${snapshotDiagnosticRow('Channels >= 3', formatBytes(vertexColor.bytesOnChannelsGE3))}
                            </div>
                        </section>
                        <section class="snapshot-diagnostics-table">
                            <h3>scene.bin Channels</h3>
                            <table><thead><tr><th>Channel</th><th>Bytes</th><th>Share</th></tr></thead><tbody>${channelRows || '<tr><td colspan="3">No binary channels found</td></tr>'}</tbody></table>
                        </section>
                        <section class="snapshot-diagnostics-table">
                            <h3>Morph Targets</h3>
                            <table><thead><tr><th>Node</th><th>Channels</th><th>Nonzero</th><th>Bytes</th><th>Registered Names</th></tr></thead><tbody>${morphRows || '<tr><td colspan="5">No morph targets registered in snapshot</td></tr>'}</tbody></table>
                        </section>
                        <section class="snapshot-diagnostics-table">
                            <h3>Top Nodes By Bytes</h3>
                            <table><thead><tr><th>Node</th><th>Bytes</th><th>Verts</th><th>Rig Data</th></tr></thead><tbody>${topRows || '<tr><td colspan="4">No node byte data</td></tr>'}</tbody></table>
                        </section>
                    </div>
                </div>
            `;
        }

        function closeSnapshotDiagnosticsOverlay() {
            const overlay = document.getElementById('snapshotDiagnosticsOverlay');
            if (overlay) overlay.remove();
            document.removeEventListener('keydown', handleSnapshotDiagnosticsKeydown);
        }

        function handleSnapshotDiagnosticsKeydown(event) {
            if (event.key === 'Escape') closeSnapshotDiagnosticsOverlay();
        }

        function showSnapshotDiagnosticsOverlay(report, path) {
            closeSnapshotDiagnosticsOverlay();
            const overlay = document.createElement('div');
            overlay.id = 'snapshotDiagnosticsOverlay';
            overlay.className = 'snapshot-diagnostics';
            overlay.innerHTML = renderSnapshotDiagnosticsOverlay(report, path);
            overlay.addEventListener('click', event => {
                if (event.target === overlay) closeSnapshotDiagnosticsOverlay();
            });
            document.body.appendChild(overlay);
            document.getElementById('snapshotDiagnosticsClose')?.addEventListener('click', closeSnapshotDiagnosticsOverlay);
            document.addEventListener('keydown', handleSnapshotDiagnosticsKeydown);
        }

        async function analyzeSnapshotFromHost() {
            if (!window.chrome?.webview || pendingSnapshotRequestId || pendingSnapshotServeRequestId || pendingSnapshotAnalyze) return;
            pendingSnapshotAnalyze = true;
            syncSnapshotPanel();
            deps.setInfoText('max.js - analyzing snapshot...');
            try {
                const msg = await deps.requestHostAction('snapshot_analyze', { path: lastSnapshotExportPath || '' }, 120000);
                const report = analyzeSnapshotPayload({
                    snapshotJson: msg.snapshotJson,
                    files: {
                        snapshotJsonBytes: msg.snapshotJsonBytes,
                        sceneBinBytes: msg.sceneBinBytes,
                        sceneAnimBytes: msg.sceneAnimBytes,
                    },
                    options: { top: 18, morphNameLimit: 24 },
                });
                const analyzedPath = msg.path || lastSnapshotExportPath || '';
                lastSnapshotExportPath = analyzedPath || lastSnapshotExportPath;
                showSnapshotDiagnosticsOverlay(report, analyzedPath);
                deps.setInfoText('max.js - snapshot diagnostics ready');
            } catch (error) {
                deps.reportBridgeError('snapshot analyze', error);
            } finally {
                pendingSnapshotAnalyze = false;
                syncSnapshotPanel();
            }
        }

        async function exportSnapshotWithSettings(options = {}) {
            if (!window.chrome?.webview || pendingSnapshotRequestId) return;

            const settings = getSnapshotExportSettings();
            let snapshotBase64 = '';
            let runtimeSnapshotBase64 = '';
            let localHdriBase64 = '';
            let localHdriFileNameForExport = '';
            const authoredEnvironmentActive = !!(deps.skyActive || deps.currentEnvParams?.hdri);

            if (settings.includeSnapshotUi) {
                const uiState = deps.serializeSnapshotUiState({ includeDebug: settings.includeDebugPayload });
                uiState.bake = deps.serializeSnapshotBakeState();
                if (!authoredEnvironmentActive && settings.copyAssets && deps.isLocalHdriLoaded() && deps.localHdriFile instanceof Blob) {
                    try {
                        localHdriBase64 = deps.bytesToBase64(new Uint8Array(await deps.localHdriFile.arrayBuffer()));
                        localHdriFileNameForExport = deps.localHdriFile.name || deps.localHdriFileName || 'local_hdri.hdr';
                    } catch (error) {
                        deps.reportBridgeError('snapshot HDRI export', error);
                        return;
                    }
                }
                snapshotBase64 = deps.toBase64Utf8(JSON.stringify(uiState));
            }

            if (settings.includeRuntimeScene) {
                try {
                    const runtimeSnapshot = deps.layerManager.serializeSnapshot?.({
                        includeDisabledLayers: settings.includeDisabledLayers,
                    }) ?? null;
                    if (runtimeSnapshot) {
                        runtimeSnapshotBase64 = deps.toBase64Utf8(JSON.stringify(runtimeSnapshot));
                        const layerRows = runtimeSnapshot.layers?.length ?? 0;
                        const hasTransformOverrides = Array.isArray(runtimeSnapshot.transformOverrides)
                            && runtimeSnapshot.transformOverrides.length > 0;
                        if (layerRows > 0 && !runtimeSnapshot.jsRoot && !runtimeSnapshot.overlayRoot && !hasTransformOverrides) {
                            deps.maxjsDebugWarn(
                                '[max.js snapshot] Runtime scene has layer metadata but no serialized 3D (empty roots and no tracked orphans). '
                                + 'Parent effects with ctx.js.add(...) / overlay:true, or ctx.track() if you attach elsewhere.',
                            );
                        }
                    }
                } catch (error) {
                    deps.reportBridgeError('snapshot serialize', error);
                    return;
                }
            }

            pendingSnapshotRequestId = `snapshot_${Date.now()}`;
            pendingSnapshotServeAfterExport = !!options.serveAfter;
            syncSnapshotPanel();
            deps.setInfoText('max.js - writing snapshot...');
            deps.bridge.send('snapshot_export', {
                requestId: pendingSnapshotRequestId,
                snapshotBase64,
                runtimeBase64: runtimeSnapshotBase64,
                localHdriBase64,
                localHdriFileName: localHdriFileNameForExport,
                ...settings,
            });
        }

        async function serveSnapshotWithSettings() {
            if (!window.chrome?.webview || pendingSnapshotRequestId || pendingSnapshotServeRequestId) return;
            if (!lastSnapshotExportPath) {
                await exportSnapshotWithSettings({ serveAfter: true });
                return;
            }

            pendingSnapshotServeRequestId = `snapshot_serve_${Date.now()}`;
            lastSnapshotServeUrl = '';
            syncSnapshotPanel();
            deps.setInfoText('max.js - serving snapshot...');
            deps.bridge.send('snapshot_serve', {
                requestId: pendingSnapshotServeRequestId,
                path: lastSnapshotExportPath,
            });
        }

        deps.bridge.on('snapshot_export_request', () => {
            void exportSnapshotWithSettings();
        });

        btnSnapshotPanel.onclick = () => {
            setSnapshotPanelVisible(!snapshotPanelVisible);
        };

        // requestHostAction resolution lives in host_bridge.js; this handler only
        // owns the snapshot-export UI consequences.
        deps.bridge.on('host_action_result', msg => {
            if (msg.action === 'snapshot_export') {
                if (pendingSnapshotRequestId && msg.requestId && msg.requestId !== pendingSnapshotRequestId) return;
                pendingSnapshotRequestId = null;
                if (msg.ok) {
                    lastSnapshotExportPath = msg.path || 'dist';
                    lastSnapshotServeUrl = '';
                    deps.setInfoText(`max.js - Snapshot saved to ${lastSnapshotExportPath}`);
                    syncSnapshotPanel();
                    if (pendingSnapshotServeAfterExport) {
                        pendingSnapshotServeAfterExport = false;
                        void serveSnapshotWithSettings();
                    }
                } else {
                    pendingSnapshotServeAfterExport = false;
                    syncSnapshotPanel();
                    deps.reportBridgeError('snapshot export', msg.error || 'snapshot export failed');
                }
                return;
            }

            if (msg.action === 'snapshot_serve') {
                if (pendingSnapshotServeRequestId && msg.requestId && msg.requestId !== pendingSnapshotServeRequestId) return;
                pendingSnapshotServeRequestId = null;
                if (msg.ok) {
                    lastSnapshotServeUrl = msg.path || '';
                    deps.setInfoText(`max.js - Snapshot served at ${lastSnapshotServeUrl || 'localhost'}`);
                } else {
                    deps.reportBridgeError('snapshot serve', msg.error || 'snapshot serve failed');
                }
                syncSnapshotPanel();
            }
        });

        return {
            SNAPSHOT_SETTINGS_DEFAULTS,
            sanitizeSnapshotSettings,
            getSnapshotExportSettings,
            loadSnapshotSettings,
            saveSnapshotSettings,
            setSnapshotPanelVisible,
            updateSnapshotSetting,
            resetSnapshotSettings,
            buildSnapshotPanel,
            syncSnapshotPanel,
            escapeSnapshotDiagnosticHtml,
            snapshotDiagnosticRow,
            renderSnapshotDiagnosticsOverlay,
            closeSnapshotDiagnosticsOverlay,
            handleSnapshotDiagnosticsKeydown,
            showSnapshotDiagnosticsOverlay,
            analyzeSnapshotFromHost,
            exportSnapshotWithSettings,
            serveSnapshotWithSettings,
        };
}

export { createSnapshotExport };

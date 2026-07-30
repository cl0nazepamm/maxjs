#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const require = createRequire(import.meta.url);
const THREE = require('../web/vendor/three-r185/build/three.cjs');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB_ROOT = join(ROOT, 'web');
const FIXTURE_ROOT = '/__snapshot_runtime_fixture__';
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const SOURCE_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 10, 0, 0, 1];

const MIME = {
    '.bin': 'application/octet-stream',
    '.css': 'text/css; charset=utf-8',
    '.exr': 'application/octet-stream',
    '.hdr': 'application/octet-stream',
    '.html': 'text/html; charset=utf-8',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.mp4': 'video/mp4',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ttf': 'font/ttf',
    '.wasm': 'application/wasm',
    '.webm': 'video/webm',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
};

function buildRuntimeRoot(name, kind) {
    const root = new THREE.Group();
    root.name = name;

    const replayedLayer = new THREE.Group();
    replayedLayer.name = `baked-probe-${kind}`;
    replayedLayer.userData.maxjsLayerId = 'probe';
    replayedLayer.userData.fixtureOrigin = `baked-probe-${kind}`;
    replayedLayer.add(new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshBasicMaterial({ color: kind === 'js' ? 0xff00ff : 0x00ffff }),
    ));
    root.add(replayedLayer);

    const bakedOnlyLayer = new THREE.Group();
    bakedOnlyLayer.name = `baked-only-${kind}`;
    bakedOnlyLayer.userData.maxjsLayerId = `baked-only-${kind}`;
    bakedOnlyLayer.userData.fixtureOrigin = `baked-only-${kind}`;
    bakedOnlyLayer.add(new THREE.Mesh(
        new THREE.SphereGeometry(0.5, 8, 6),
        new THREE.MeshBasicMaterial({ color: kind === 'js' ? 0x44ff44 : 0xffaa00 }),
    ));
    root.add(bakedOnlyLayer);

    const brokenLayer = new THREE.Group();
    brokenLayer.name = `baked-broken-${kind}`;
    brokenLayer.userData.maxjsLayerId = 'broken';
    brokenLayer.userData.fixtureOrigin = `baked-broken-${kind}`;
    brokenLayer.add(new THREE.Mesh(
        new THREE.ConeGeometry(0.4, 1, 8),
        new THREE.MeshBasicMaterial({ color: kind === 'js' ? 0xff4444 : 0x4488ff }),
    ));
    root.add(brokenLayer);

    return root.toJSON();
}

function buildSceneBin() {
    const buffer = Buffer.alloc(48);
    const positions = [
        -1, -1, 0,
         1, -1, 0,
         0,  1, 0,
    ];
    positions.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
    [0, 1, 2].forEach((value, index) => buffer.writeInt32LE(value, 36 + index * 4));
    return buffer;
}

function buildSnapshotMeta() {
    return {
        type: 'scene_bin',
        bin: 'scene.bin',
        nodes: [{
            h: 101,
            n: 'Runtime_Hide_Source',
            t: SOURCE_MATRIX,
            vis: true,
            props: { cshadow: false },
            geo: {
                vOff: 0,
                vN: 9,
                iOff: 36,
                iN: 3,
                iType: 'u32',
            },
        }],
        lights: [],
        materials: [],
        audios: [{
            h: 201,
            n: 'Runtime_Audio_Probe',
            url: '',
            volume: 0.5,
            loop: false,
            t: IDENTITY,
            v: true,
        }],
        gltfs: [{
            h: 301,
            n: 'Runtime_GLTF_Probe',
            displayName: 'Runtime GLTF Probe',
            url: '',
            rootScale: 1,
            autoplay: false,
            t: IDENTITY,
            v: true,
        }],
        animations: {
            clips: [{
                id: 'probe-clip',
                name: 'Probe Clip',
                duration: 1,
                autoPlay: false,
                targets: [{
                    target: 'camera:active',
                    tracks: [{
                        path: 'position',
                        type: 'vector3',
                        times: [0, 1],
                        values: [0, 0, 5, 0, 0, 4],
                    }],
                }, {
                    target: 'handle:101',
                    tracks: [{
                        path: 'visible',
                        type: 'boolean',
                        times: [0, 1],
                        values: [true, true],
                    }],
                }],
            }],
        },
        runtimeFeatures: {
            renderer_pref: 'webgl',
            post_fx: [],
            audio: true,
            gltf: true,
            html_textures: false,
            volumes: false,
            physics: false,
            environment: false,
            three_addons: ['OrbitControls'],
        },
        runtimeScene: {
            version: 1,
            layers: [{
                id: 'probe',
                name: 'Snapshot Runtime Probe',
                source: 'inline',
                entry: 'inlines/probe.js',
                active: true,
                parameters: [{
                    name: 'turbidity',
                    label: 'Turbidity',
                    type: 'slider',
                    value: 3.75,
                    default: 2,
                    min: 1,
                    max: 10,
                    step: 0.05,
                    order: 0,
                }, {
                    name: 'numericLabel',
                    label: 'Numeric Label',
                    type: 'string',
                    value: '007',
                    default: 'default',
                    order: 1,
                }],
            }, {
                id: 'broken',
                name: 'Broken Snapshot Runtime Probe',
                source: 'inline',
                entry: 'inlines/broken.js',
                active: true,
                parameters: [],
            }],
            jsRoot: buildRuntimeRoot('__maxjs_snapshot_js_root__', 'js'),
            overlayRoot: buildRuntimeRoot('__maxjs_snapshot_overlay_root__', 'overlay'),
            hideMaxSyncHandles: [101],
            transformOverrides: [{
                version: 2,
                handle: 101,
                ownerLayer: 'baked-only-js',
                mode: 'additive',
                position: [2, 0, 0],
                quaternion: [0, 0, 0, 1],
                scale: [1, 1, 1],
            }],
        },
    };
}

const LAYER_SOURCE = `
export default function snapshotRuntimeProbe(ctx) {
    ctx.group.userData.fixtureOrigin = 'live-js';
    ctx.overlayGroup.userData.fixtureOrigin = 'live-overlay';
    const params = ctx.params.define({
        turbidity: { type: 'slider', value: 2, min: 1, max: 10, step: 0.05 },
        numericLabel: { type: 'string', value: 'default' },
    });

    const probe = {
        animationIds: ctx.anim.list().map(entry => entry.id),
        audioHandles: ctx.audio.list().map(entry => entry.handle),
        gltfHandles: ctx.runtime.gltf.list().map(entry => entry.handle),
        bakedTwinSeenDuringInit: 0,
        projectState: ctx.project.getState(),
        projectSetResult: null,
        projectReloadResult: null,
        projectErrors: [],
        params: {
            turbidity: params.turbidity,
            numericLabel: params.numericLabel,
        },
    };
    ctx.renderer.sceneRoot?.traverse?.((object) => {
        if (object?.userData?.fixtureOrigin === 'baked-probe-js'
            || object?.userData?.fixtureOrigin === 'baked-probe-overlay') {
            probe.bakedTwinSeenDuringInit++;
        }
    });

    try {
        probe.projectSetResult = ctx.project.setDirectory('ignored-in-snapshot');
    } catch (error) {
        probe.projectErrors.push('setDirectory: ' + String(error?.message ?? error));
    }
    try {
        probe.projectReloadResult = ctx.project.reload();
    } catch (error) {
        probe.projectErrors.push('reload: ' + String(error?.message ?? error));
    }

    globalThis.__snapshotRuntimeLayerProbe = probe;
    return {};
}
`;

const BROKEN_LAYER_SOURCE = `
export default function brokenSnapshotRuntimeProbe(ctx, THREE) {
    const source = ctx.maxScene.getNode(101);
    source?.overrides.setProperty('castShadow', true);
    const leaked = new THREE.Mesh(
        new THREE.BoxGeometry(0.25, 0.25, 0.25),
        new THREE.MeshBasicMaterial({ color: 0xff0000 }),
    );
    leaked.userData.fixtureOrigin = 'broken-live-partial';
    ctx.group.add(leaked);
    throw new Error('intentional snapshot fallback probe');
}
`;

function makeFixtureRoutes() {
    const snapshot = buildSnapshotMeta();
    const manifest = {
        version: 1,
        layers: [{
            id: 'probe',
            name: 'Snapshot Runtime Probe',
            entry: 'inlines/probe.js',
            enabled: true,
        }],
    };
    return new Map([
        [`${FIXTURE_ROOT}/snapshot.json`, {
            type: MIME['.json'],
            body: Buffer.from(JSON.stringify(snapshot), 'utf8'),
        }],
        [`${FIXTURE_ROOT}/scene.bin`, {
            type: MIME['.bin'],
            body: buildSceneBin(),
        }],
        [`${FIXTURE_ROOT}/project.maxjs.json`, {
            type: MIME['.json'],
            body: Buffer.from(JSON.stringify(manifest), 'utf8'),
        }],
        [`${FIXTURE_ROOT}/inlines/probe.js`, {
            type: MIME['.js'],
            body: Buffer.from(LAYER_SOURCE, 'utf8'),
        }],
        [`${FIXTURE_ROOT}/inlines/broken.js`, {
            type: MIME['.js'],
            body: Buffer.from(BROKEN_LAYER_SOURCE, 'utf8'),
        }],
    ]);
}

function sendResponse(req, res, statusCode, type, body) {
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8');
    res.writeHead(statusCode, {
        'content-type': type,
        'content-length': payload.byteLength,
        'cache-control': 'no-store',
    });
    if (req.method === 'HEAD') res.end();
    else res.end(payload);
}

async function serveWebFile(req, res, pathname) {
    const relativePath = pathname === '/' ? 'snapshot.html' : pathname.replace(/^\/+/, '');
    const filePath = resolve(WEB_ROOT, relativePath);
    const relativeToWeb = relative(WEB_ROOT, filePath);
    if (
        relativeToWeb === '..'
        || relativeToWeb.startsWith(`..${sep}`)
        || resolve(filePath) === resolve(WEB_ROOT)
    ) {
        sendResponse(req, res, 403, 'text/plain; charset=utf-8', 'forbidden');
        return;
    }
    try {
        const info = await stat(filePath);
        if (!info.isFile()) throw new Error('not a file');
        const body = await readFile(filePath);
        sendResponse(
            req,
            res,
            200,
            MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
            body,
        );
    } catch {
        sendResponse(req, res, 404, 'text/plain; charset=utf-8', `not found: ${pathname}`);
    }
}

function createSmokeServer() {
    const fixtures = makeFixtureRoutes();
    return createServer((req, res) => {
        let pathname;
        try {
            pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
        } catch {
            sendResponse(req, res, 400, 'text/plain; charset=utf-8', 'bad request');
            return;
        }
        const fixture = fixtures.get(pathname);
        if (fixture) {
            sendResponse(req, res, 200, fixture.type, fixture.body);
            return;
        }
        serveWebFile(req, res, pathname).catch((error) => {
            sendResponse(req, res, 500, 'text/plain; charset=utf-8', error?.stack ?? error);
        });
    });
}

function findPlaywrightCli() {
    const candidates = [
        process.env.PLAYWRIGHT_CLI_JS,
        join(ROOT, 'node_modules', '@playwright', 'cli', 'playwright-cli.js'),
        process.env.APPDATA
            ? join(process.env.APPDATA, 'npm', 'node_modules', '@playwright', 'cli', 'playwright-cli.js')
            : '',
        process.env.npm_config_prefix
            ? join(process.env.npm_config_prefix, 'node_modules', '@playwright', 'cli', 'playwright-cli.js')
            : '',
        join(dirname(dirname(process.execPath)), 'lib', 'node_modules', '@playwright', 'cli', 'playwright-cli.js'),
    ].filter(Boolean);
    const jsEntry = candidates.find(candidate => existsSync(candidate));
    if (jsEntry) {
        return { command: process.execPath, prefix: [jsEntry], shell: false };
    }
    return {
        command: process.platform === 'win32' ? 'playwright-cli.cmd' : 'playwright-cli',
        prefix: [],
        shell: process.platform === 'win32',
    };
}

function findBrowserChannel() {
    if (process.env.MAXJS_SMOKE_BROWSER) return process.env.MAXJS_SMOKE_BROWSER;
    if (process.platform !== 'win32') return null;

    const localAppData = process.env.LOCALAPPDATA ?? '';
    const chromeCandidates = [
        join('C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join('C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        localAppData ? join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
    ].filter(Boolean);
    if (chromeCandidates.some(candidate => existsSync(candidate))) return 'chrome';

    const edgeCandidates = [
        join('C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join('C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        localAppData ? join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : '',
    ].filter(Boolean);
    if (edgeCandidates.some(candidate => existsSync(candidate))) return 'msedge';
    return null;
}

function runCommand(command, args, {
    cwd,
    timeoutMs = 45_000,
    allowFailure = false,
    shell = false,
} = {}) {
    return new Promise((resolvePromise, rejectPromise) => {
        const child = spawn(command, args, {
            cwd,
            shell,
            windowsHide: true,
            env: {
                ...process.env,
                NO_UPDATE_NOTIFIER: '1',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', chunk => { stdout += chunk; });
        child.stderr?.on('data', chunk => { stderr += chunk; });
        const timer = setTimeout(() => {
            child.kill();
            rejectPromise(new Error(
                `Timed out after ${timeoutMs}ms: ${command} ${args.join(' ')}\n${stdout}\n${stderr}`,
            ));
        }, timeoutMs);
        child.once('error', (error) => {
            clearTimeout(timer);
            rejectPromise(error);
        });
        child.once('exit', (code, signal) => {
            clearTimeout(timer);
            const result = { code, signal, stdout, stderr };
            if (code === 0 || allowFailure) {
                resolvePromise(result);
                return;
            }
            rejectPromise(new Error(
                `Command failed (${code ?? signal}): ${command} ${args.join(' ')}\n${stdout}\n${stderr}`,
            ));
        });
    });
}

const PLAYWRIGHT_ASSERTIONS = String.raw`
async page => {
    await page.waitForFunction(
        () => !!window.maxjsPlayer || !!document.querySelector('#boot-status.error'),
        null,
        { timeout: 20000 },
    );
    await page.evaluate(() => new Promise(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));

    const result = await page.evaluate(() => {
        const failures = [];
        const expect = (condition, message) => {
            if (!condition) failures.push(message);
        };
        const player = window.maxjsPlayer;
        if (!player) {
            failures.push(
                'snapshot boot failed: ' +
                (document.querySelector('#boot-status.error')?.textContent || 'player was not published'),
            );
            return { failures };
        }

        const collectOrigins = (root) => {
            const origins = [];
            root?.traverse?.((object) => {
                if (object?.userData?.fixtureOrigin) origins.push(object.userData.fixtureOrigin);
            });
            return origins;
        };
        const jsOrigins = collectOrigins(player.jsRoot);
        const overlayOrigins = collectOrigins(player.overlayRoot);
        const source = player.nodeMap.get(101);
        const sourceHidden = source?.userData?.maxjsVisible === false
            && (source.visible === false || source.layers?.mask === 0x80000000);

        expect(!!source?.isMesh, 'fixture Max source mesh was not applied');
        expect(sourceHidden, 'hideMaxSyncHandles did not hide Max source handle 101');
        expect(Math.abs((source?.matrix?.elements?.[12] ?? 0) - 12) < 1e-6,
            'versioned additive transform override did not restore to local X=12');

        expect(
            jsOrigins.filter(value => value === 'baked-probe-js').length === 0,
            'matching baked jsRoot layer survived successful sidecar replay',
        );
        expect(
            overlayOrigins.filter(value => value === 'baked-probe-overlay').length === 0,
            'matching baked overlayRoot layer survived successful sidecar replay',
        );
        expect(
            jsOrigins.filter(value => value === 'baked-only-js').length === 1,
            'unmatched baked jsRoot fallback was not restored exactly once',
        );
        expect(
            overlayOrigins.filter(value => value === 'baked-only-overlay').length === 1,
            'unmatched baked overlayRoot fallback was not restored exactly once',
        );
        expect(
            jsOrigins.filter(value => value === 'baked-broken-js').length === 1,
            'failed jsRoot sidecar did not restore its baked fallback exactly once',
        );
        expect(
            overlayOrigins.filter(value => value === 'baked-broken-overlay').length === 1,
            'failed overlayRoot sidecar did not restore its baked fallback exactly once',
        );
        expect(
            jsOrigins.filter(value => value === 'live-js').length === 1,
            'live jsRoot layer did not mount exactly once',
        );
        expect(
            overlayOrigins.filter(value => value === 'live-overlay').length === 1,
            'live overlayRoot layer did not mount exactly once',
        );
        expect(
            !jsOrigins.includes('broken-live-partial')
                && !overlayOrigins.includes('broken-live-partial'),
            'failed sidecar left a partial live object behind',
        );

        const bakedJsWrappers = [];
        const bakedOverlayWrappers = [];
        player.jsRoot?.traverse?.((object) => {
            if (object?.userData?.maxjsBakedRuntimeScene) bakedJsWrappers.push(object);
        });
        player.overlayRoot?.traverse?.((object) => {
            if (object?.userData?.maxjsBakedRuntimeScene) bakedOverlayWrappers.push(object);
        });
        expect(bakedJsWrappers.length === 1, 'baked jsRoot wrapper was not replayed');
        expect(bakedOverlayWrappers.length === 1, 'baked overlayRoot wrapper was not replayed');

        const probe = window.__snapshotRuntimeLayerProbe;
        expect(!!probe, 'runtime probe layer did not execute');
        expect(probe?.animationIds?.includes('probe-clip'), 'ctx.anim was hollow during layer init');
        expect(probe?.audioHandles?.includes(201), 'ctx.audio was hollow during layer init');
        expect(probe?.gltfHandles?.includes(301), 'ctx.runtime.gltf was hollow during layer init');
        expect(probe?.bakedTwinSeenDuringInit === 0,
            'live layer init observed its soon-to-be-disposed baked twin');
        expect(probe?.projectErrors?.length === 0, 'ctx.project threw: ' + probe?.projectErrors?.join(', '));
        expect(probe?.projectSetResult === false, 'snapshot ctx.project.setDirectory should be a no-op false');
        expect(probe?.projectReloadResult === false, 'snapshot ctx.project.reload should be a no-op false');
        expect(probe?.projectState?.mode === 'snapshot', 'ctx.project state is not snapshot mode');
        expect(probe?.projectState?.readOnly === true, 'ctx.project state is not read-only');
        expect(probe?.params?.turbidity === 3.75,
            'runtimeScene numeric parameter value was not restored before the layer factory');
        expect(probe?.params?.numericLabel === '007',
            'runtimeScene string parameter value was not restored before the layer factory');

        const layer = player.layerManager.getLayerSnapshot('probe');
        expect(!!layer, 'probe layer is absent after replay');
        expect(!layer?.error, 'probe layer mounted with an error: ' + layer?.error);
        expect(player.layerManager.getLayerSnapshot('broken') == null,
            'failed sidecar left a ghost layer in the manager');
        expect(source?.castShadow === false,
            'failed sidecar left a Max property override applied to the baked fallback');

        return {
            failures,
            summary: {
                sourceHidden,
                sourceLocalX: source?.matrix?.elements?.[12] ?? null,
                sourceCastShadow: source?.castShadow ?? null,
                jsOrigins,
                overlayOrigins,
                animationIds: probe?.animationIds ?? [],
                audioHandles: probe?.audioHandles ?? [],
                gltfHandles: probe?.gltfHandles ?? [],
                bakedTwinSeenDuringInit: probe?.bakedTwinSeenDuringInit ?? null,
                projectState: probe?.projectState ?? null,
                params: probe?.params ?? null,
            },
        };
    });

    if (result.failures.length > 0) {
        throw new Error(
            'snapshot runtime parity assertions failed:\n- ' +
            result.failures.join('\n- ') +
            '\n' + JSON.stringify(result.summary ?? {}, null, 2),
        );
    }
    return result.summary;
}
`;

async function listen(server) {
    await new Promise((resolvePromise, rejectPromise) => {
        server.once('error', rejectPromise);
        server.listen(0, '127.0.0.1', resolvePromise);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('smoke server did not expose a TCP port');
    return address.port;
}

async function closeServer(server) {
    server.closeAllConnections?.();
    await new Promise(resolvePromise => server.close(() => resolvePromise()));
}

async function main() {
    const server = createSmokeServer();
    const tempDir = await mkdtemp(join(tmpdir(), 'maxjs-snapshot-runtime-'));
    const session = `maxjs-snapshot-runtime-${process.pid}-${Date.now()}`;
    const cli = findPlaywrightCli();
    const browserChannel = findBrowserChannel();
    let port = null;

    try {
        port = await listen(server);
        const url =
            `http://127.0.0.1:${port}/snapshot.html` +
            `?root=${encodeURIComponent(FIXTURE_ROOT.slice(1))}` +
            '&noreload&renderer=webgl';

        await runCommand(
            cli.command,
            [
                ...cli.prefix,
                `-s=${session}`,
                'open',
                ...(browserChannel ? [`--browser=${browserChannel}`] : []),
                url,
            ],
            { cwd: tempDir, shell: cli.shell },
        );
        const assertionRun = await runCommand(
            cli.command,
            [...cli.prefix, '--raw', `-s=${session}`, 'run-code', PLAYWRIGHT_ASSERTIONS],
            { cwd: tempDir, shell: cli.shell },
        );

        const detail = assertionRun.stdout.trim();
        console.log('snapshot runtime parity smoke: PASS');
        if (detail) console.log(detail);
    } finally {
        await runCommand(
            cli.command,
            [...cli.prefix, `-s=${session}`, 'close'],
            { cwd: tempDir, timeoutMs: 15_000, allowFailure: true, shell: cli.shell },
        ).catch(() => {});
        if (port != null) await closeServer(server).catch(() => {});
        else server.close();
        await rm(tempDir, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
});

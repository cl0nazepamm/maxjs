import * as THREE from 'three';
import {
    add,
    blendColor,
    colorToDirection,
    diffuseColor,
    directionToColor,
    metalness,
    mrt,
    normalView,
    output,
    pass,
    roughness,
    sample,
    vec2,
    vec4,
    velocity,
} from 'three/tsl';

import { anamorphic } from 'three/addons/tsl/display/AnamorphicNode.js';
import { afterImage } from 'three/addons/tsl/display/AfterImageNode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { chromaticAberration } from 'three/addons/tsl/display/ChromaticAberrationNode.js';
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js';
import { dotScreen } from 'three/addons/tsl/display/DotScreenNode.js';
import { film } from 'three/addons/tsl/display/FilmNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { outline } from 'three/addons/tsl/display/OutlineNode.js';
import { rgbShift } from 'three/addons/tsl/display/RGBShiftNode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';
import { ssgi } from 'three/addons/tsl/display/SSGINode.js';
import { sobel } from 'three/addons/tsl/display/SobelOperatorNode.js';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { AsciiEffect } from 'three/addons/effects/AsciiEffect.js';

function disposeNode(node) {
    if (node && typeof node.dispose === 'function') {
        node.dispose();
    }
}

function createSection(title, note = '') {
    const section = document.createElement('section');
    section.className = 'fx-section';

    const header = document.createElement('div');
    header.className = 'fx-section-header';
    header.textContent = title;
    section.appendChild(header);

    if (note) {
        const noteEl = document.createElement('div');
        noteEl.className = 'fx-note';
        noteEl.textContent = note;
        section.appendChild(noteEl);
    }

    return section;
}

function createCheckbox(section, label, value, onChange) {
    const row = document.createElement('label');
    row.className = 'fx-row fx-toggle';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = value;
    input.addEventListener('change', () => onChange(input.checked));

    const text = document.createElement('span');
    text.textContent = label;

    row.append(input, text);
    section.appendChild(row);
}

function createRange(section, label, min, max, step, value, onChange) {
    const wrapper = document.createElement('label');
    wrapper.className = 'fx-row fx-range';

    const top = document.createElement('div');
    top.className = 'fx-range-top';

    const name = document.createElement('span');
    name.textContent = label;

    const current = document.createElement('span');
    current.textContent = String(value);

    top.append(name, current);

    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.addEventListener('input', () => {
        const next = Number(input.value);
        current.textContent = input.value;
        onChange(next);
    });

    wrapper.append(top, input);
    section.appendChild(wrapper);
}

function createSelect(section, label, options, value, onChange) {
    const wrapper = document.createElement('label');
    wrapper.className = 'fx-row fx-select';

    const name = document.createElement('span');
    name.textContent = label;

    const select = document.createElement('select');
    for (const option of options) {
        const optionEl = document.createElement('option');
        optionEl.value = option.value;
        optionEl.textContent = option.label;
        if (option.value === value) optionEl.selected = true;
        select.appendChild(optionEl);
    }

    select.addEventListener('change', () => onChange(select.value));

    wrapper.append(name, select);
    section.appendChild(wrapper);
}

export function createPostFXController({
    renderer,
    scene,
    camera,
    viewportEl,
    sidebarEl,
    getSelectedObjects,
}) {
    const postProcessing = new THREE.PostProcessing(renderer);

    const state = {
        ascii: { enabled: false, resolution: 0.16, scale: 1, color: false, invert: false },
        ssgi: { enabled: true, temporal: true, sliceCount: 2, stepCount: 8, radius: 8, thickness: 1.5, aoIntensity: 1.0, giIntensity: 1.75, expFactor: 1.5 },
        ssr: { enabled: false, quality: 0.45, blurQuality: 2, maxDistance: 0.5, opacity: 0.9, thickness: 0.015 },
        gtao: { enabled: false, temporal: false, radius: 0.25, samples: 12, intensity: 1.0, thickness: 1.0 },
        bloom: { enabled: false, strength: 0.4, radius: 0.2, threshold: 0.75 },
        anamorphic: { enabled: false, threshold: 0.82, scale: 3.0, samples: 24 },
        dof: { enabled: false, focusDistance: 8.0, focalLength: 5.0, bokehScale: 2.0 },
        outline: { enabled: true, thickness: 1.25, glow: 0.2 },
        rgbShift: { enabled: false, amount: 0.0015, angle: 0.0 },
        chromatic: { enabled: false, strength: 0.3, scale: 1.05 },
        dot: { enabled: false, angle: 1.57, scale: 0.35 },
        film: { enabled: false, intensity: 0.18 },
        sobel: { enabled: false },
        afterImage: { enabled: false, damp: 0.92 },
        aa: { mode: 'traa' },
    };

    let outlinePass = null;
    let asciiEffect = null;
    let rebuildQueued = false;
    let activeNodes = [];

    function clearNodes() {
        for (const node of activeNodes) {
            disposeNode(node);
        }
        activeNodes = [];
        outlinePass = null;
    }

    function setTexturePrecision(scenePass) {
        const diffuseTexture = scenePass.getTexture('diffuseColor');
        if (diffuseTexture) diffuseTexture.type = THREE.UnsignedByteType;

        const normalTexture = scenePass.getTexture('normal');
        if (normalTexture) normalTexture.type = THREE.UnsignedByteType;

        const metalRoughTexture = scenePass.getTexture('metalrough');
        if (metalRoughTexture) metalRoughTexture.type = THREE.UnsignedByteType;
    }

    function ensureAsciiEffect() {
        if (!state.ascii.enabled) {
            if (asciiEffect) {
                asciiEffect.domElement.remove();
                asciiEffect = null;
            }
            return;
        }

        if (asciiEffect) {
            asciiEffect.domElement.remove();
            asciiEffect = null;
        }

        asciiEffect = new AsciiEffect(renderer, ' .,:;+=xX$&', {
            resolution: state.ascii.resolution,
            scale: state.ascii.scale,
            color: state.ascii.color,
            invert: state.ascii.invert,
            strResolution: 'medium',
        });

        asciiEffect.domElement.className = 'ascii-overlay';
        asciiEffect.domElement.style.display = state.ascii.enabled ? 'block' : 'none';
        viewportEl.appendChild(asciiEffect.domElement);
        asciiEffect.setSize(viewportEl.clientWidth || window.innerWidth, viewportEl.clientHeight || window.innerHeight);
    }

    function rebuildPipeline() {
        rebuildQueued = false;
        clearNodes();

        const scenePass = pass(scene, camera);
        activeNodes.push(scenePass);
        scenePass.setMRT(mrt({
            output,
            diffuseColor,
            normal: directionToColor(normalView),
            velocity,
            metalrough: vec2(metalness, roughness),
        }));

        setTexturePrecision(scenePass);

        const scenePassColor = scenePass.getTextureNode('output');
        const scenePassDiffuse = scenePass.getTextureNode('diffuseColor');
        const scenePassDepth = scenePass.getTextureNode('depth');
        const scenePassNormalColor = scenePass.getTextureNode('normal');
        const scenePassVelocity = scenePass.getTextureNode('velocity');
        const scenePassMetalRough = scenePass.getTextureNode('metalrough');
        const sceneNormal = sample((uvNode) => colorToDirection(scenePassNormalColor.sample(uvNode)));

        let beauty = scenePassColor;
        let useTemporalAA = state.aa.mode === 'traa';

        if (state.gtao.enabled) {
            const gtaoPass = ao(scenePassDepth, sceneNormal, camera);
            gtaoPass.radius.value = state.gtao.radius;
            gtaoPass.samples.value = state.gtao.samples;
            gtaoPass.scale.value = state.gtao.intensity;
            gtaoPass.thickness.value = state.gtao.thickness;
            gtaoPass.useTemporalFiltering = state.gtao.temporal;
            beauty = vec4(beauty.rgb.mul(gtaoPass), beauty.a);
            activeNodes.push(gtaoPass);
            useTemporalAA = useTemporalAA || state.gtao.temporal;
        }

        if (state.ssgi.enabled) {
            const ssgiPass = ssgi(scenePassColor, scenePassDepth, sceneNormal, camera);
            ssgiPass.sliceCount.value = state.ssgi.sliceCount;
            ssgiPass.stepCount.value = state.ssgi.stepCount;
            ssgiPass.radius.value = state.ssgi.radius;
            ssgiPass.thickness.value = state.ssgi.thickness;
            ssgiPass.aoIntensity.value = state.ssgi.aoIntensity;
            ssgiPass.giIntensity.value = state.ssgi.giIntensity;
            ssgiPass.expFactor.value = state.ssgi.expFactor;
            ssgiPass.useTemporalFiltering = state.ssgi.temporal;
            beauty = vec4(add(beauty.rgb.mul(ssgiPass.a), scenePassDiffuse.rgb.mul(ssgiPass.rgb)), beauty.a);
            activeNodes.push(ssgiPass);
            useTemporalAA = useTemporalAA || state.ssgi.temporal;
        }

        if (state.ssr.enabled) {
            const ssrPass = ssr(beauty, scenePassDepth, sceneNormal, scenePassMetalRough.r, scenePassMetalRough.g, camera);
            ssrPass.quality.value = state.ssr.quality;
            ssrPass.blurQuality.value = state.ssr.blurQuality;
            ssrPass.maxDistance.value = state.ssr.maxDistance;
            ssrPass.opacity.value = state.ssr.opacity;
            ssrPass.thickness.value = state.ssr.thickness;
            beauty = blendColor(beauty, ssrPass);
            activeNodes.push(ssrPass);
        }

        if (state.outline.enabled) {
            outlinePass = outline(scene, camera, {
                selectedObjects: getSelectedObjects(),
                edgeThickness: state.outline.thickness,
                edgeGlow: state.outline.glow,
                downSampleRatio: 2,
            });
            beauty = blendColor(beauty, outlinePass);
            activeNodes.push(outlinePass);
        }

        if (state.bloom.enabled) {
            const bloomPass = bloom(beauty, state.bloom.strength, state.bloom.radius, state.bloom.threshold);
            beauty = beauty.add(bloomPass);
            activeNodes.push(bloomPass);
        }

        if (state.anamorphic.enabled) {
            const anamorphicPass = anamorphic(beauty, state.anamorphic.threshold, state.anamorphic.scale, state.anamorphic.samples);
            beauty = beauty.add(anamorphicPass);
            activeNodes.push(anamorphicPass);
        }

        if (state.dof.enabled) {
            const dofPass = dof(beauty, scenePass.getViewZNode(), state.dof.focusDistance, state.dof.focalLength, state.dof.bokehScale);
            beauty = dofPass;
            activeNodes.push(dofPass);
        }

        if (state.rgbShift.enabled) beauty = rgbShift(beauty, state.rgbShift.amount, state.rgbShift.angle);
        if (state.chromatic.enabled) beauty = chromaticAberration(beauty, state.chromatic.strength, null, state.chromatic.scale);
        if (state.dot.enabled) beauty = dotScreen(beauty, state.dot.angle, state.dot.scale);
        if (state.film.enabled) beauty = film(beauty, state.film.intensity);
        if (state.sobel.enabled) beauty = sobel(beauty);

        if (state.afterImage.enabled) {
            const afterImagePass = afterImage(beauty, state.afterImage.damp);
            beauty = afterImagePass;
            activeNodes.push(afterImagePass);
        }

        if (state.aa.mode === 'fxaa') {
            beauty = fxaa(beauty);
        } else if (state.aa.mode === 'smaa') {
            beauty = smaa(beauty);
        } else if (useTemporalAA) {
            const traaPass = traa(beauty, scenePassDepth, scenePassVelocity, camera);
            beauty = traaPass;
            activeNodes.push(traaPass);
        }

        postProcessing.outputNode = beauty;
        postProcessing.needsUpdate = true;
    }

    function queueRebuild() {
        if (rebuildQueued) return;
        rebuildQueued = true;
        requestAnimationFrame(rebuildPipeline);
    }

    function resize() {
        if (asciiEffect) {
            asciiEffect.setSize(viewportEl.clientWidth || window.innerWidth, viewportEl.clientHeight || window.innerHeight);
        }
    }

    function render() {
        if (outlinePass) {
            outlinePass.selectedObjects = getSelectedObjects();
        }

        if (state.ascii.enabled) {
            if (!asciiEffect) ensureAsciiEffect();

            if (asciiEffect) {
                renderer.domElement.style.opacity = '0';
                asciiEffect.domElement.style.display = 'block';
                asciiEffect.render(scene, camera);
                return;
            }
        }

        renderer.domElement.style.opacity = '1';
        if (asciiEffect) asciiEffect.domElement.style.display = 'none';
        postProcessing.render();
    }

    function addSidebar() {
        sidebarEl.innerHTML = '';

        const title = document.createElement('div');
        title.className = 'fx-sidebar-title';
        title.textContent = 'Post FX';
        sidebarEl.appendChild(title);

        const intro = document.createElement('div');
        intro.className = 'fx-note';
        intro.textContent = 'WebGPU post stack with GI, reflections, stylized passes, and an ASCII view mode.';
        sidebarEl.appendChild(intro);

        const global = createSection('Output');
        createCheckbox(global, 'ASCII mode', state.ascii.enabled, (value) => {
            state.ascii.enabled = value;
            ensureAsciiEffect();
        });
        createCheckbox(global, 'ASCII color', state.ascii.color, (value) => {
            state.ascii.color = value;
            ensureAsciiEffect();
        });
        createCheckbox(global, 'ASCII invert', state.ascii.invert, (value) => {
            state.ascii.invert = value;
            ensureAsciiEffect();
        });
        createRange(global, 'ASCII resolution', 0.08, 0.35, 0.01, state.ascii.resolution, (value) => {
            state.ascii.resolution = value;
            ensureAsciiEffect();
        });
        createSelect(global, 'Anti-aliasing', [
            { value: 'none', label: 'None' },
            { value: 'fxaa', label: 'FXAA' },
            { value: 'smaa', label: 'SMAA' },
            { value: 'traa', label: 'TRAA' },
        ], state.aa.mode, (value) => {
            state.aa.mode = value;
            queueRebuild();
        });
        sidebarEl.appendChild(global);

        const lighting = createSection('GI + Reflections', 'SSGI is enabled by default. Outline follows current Max selection.');
        createCheckbox(lighting, 'SSGI', state.ssgi.enabled, (value) => { state.ssgi.enabled = value; queueRebuild(); });
        createRange(lighting, 'SSGI slices', 1, 4, 1, state.ssgi.sliceCount, (value) => { state.ssgi.sliceCount = value; queueRebuild(); });
        createRange(lighting, 'SSGI steps', 1, 16, 1, state.ssgi.stepCount, (value) => { state.ssgi.stepCount = value; queueRebuild(); });
        createRange(lighting, 'SSGI radius', 1, 20, 0.5, state.ssgi.radius, (value) => { state.ssgi.radius = value; queueRebuild(); });
        createRange(lighting, 'SSGI GI', 0, 8, 0.1, state.ssgi.giIntensity, (value) => { state.ssgi.giIntensity = value; queueRebuild(); });
        createRange(lighting, 'SSGI AO', 0, 4, 0.1, state.ssgi.aoIntensity, (value) => { state.ssgi.aoIntensity = value; queueRebuild(); });
        createRange(lighting, 'SSGI thickness', 0.1, 6, 0.1, state.ssgi.thickness, (value) => { state.ssgi.thickness = value; queueRebuild(); });
        createRange(lighting, 'SSGI falloff', 1, 4, 0.1, state.ssgi.expFactor, (value) => { state.ssgi.expFactor = value; queueRebuild(); });
        createCheckbox(lighting, 'SSGI temporal', state.ssgi.temporal, (value) => { state.ssgi.temporal = value; queueRebuild(); });

        createCheckbox(lighting, 'SSR reflections', state.ssr.enabled, (value) => { state.ssr.enabled = value; queueRebuild(); });
        createRange(lighting, 'SSR quality', 0, 1, 0.05, state.ssr.quality, (value) => { state.ssr.quality = value; queueRebuild(); });
        createRange(lighting, 'SSR blur', 1, 3, 1, state.ssr.blurQuality, (value) => { state.ssr.blurQuality = value; queueRebuild(); });
        createRange(lighting, 'SSR distance', 0.05, 1.0, 0.01, state.ssr.maxDistance, (value) => { state.ssr.maxDistance = value; queueRebuild(); });
        createRange(lighting, 'SSR opacity', 0, 1, 0.05, state.ssr.opacity, (value) => { state.ssr.opacity = value; queueRebuild(); });
        createRange(lighting, 'SSR thickness', 0.001, 0.05, 0.001, state.ssr.thickness, (value) => { state.ssr.thickness = value; queueRebuild(); });

        createCheckbox(lighting, 'GTAO', state.gtao.enabled, (value) => { state.gtao.enabled = value; queueRebuild(); });
        createRange(lighting, 'GTAO radius', 0.05, 1.5, 0.01, state.gtao.radius, (value) => { state.gtao.radius = value; queueRebuild(); });
        createRange(lighting, 'GTAO samples', 4, 32, 1, state.gtao.samples, (value) => { state.gtao.samples = value; queueRebuild(); });
        createRange(lighting, 'GTAO intensity', 0, 4, 0.1, state.gtao.intensity, (value) => { state.gtao.intensity = value; queueRebuild(); });
        createRange(lighting, 'GTAO thickness', 0.1, 4, 0.1, state.gtao.thickness, (value) => { state.gtao.thickness = value; queueRebuild(); });
        createCheckbox(lighting, 'GTAO temporal', state.gtao.temporal, (value) => { state.gtao.temporal = value; queueRebuild(); });

        createCheckbox(lighting, 'Outline selection', state.outline.enabled, (value) => { state.outline.enabled = value; queueRebuild(); });
        createRange(lighting, 'Outline thickness', 0.5, 5, 0.1, state.outline.thickness, (value) => { state.outline.thickness = value; queueRebuild(); });
        createRange(lighting, 'Outline glow', 0, 2, 0.05, state.outline.glow, (value) => { state.outline.glow = value; queueRebuild(); });
        sidebarEl.appendChild(lighting);

        const cinematic = createSection('Cinematic');
        createCheckbox(cinematic, 'Bloom', state.bloom.enabled, (value) => { state.bloom.enabled = value; queueRebuild(); });
        createRange(cinematic, 'Bloom strength', 0, 3, 0.05, state.bloom.strength, (value) => { state.bloom.strength = value; queueRebuild(); });
        createRange(cinematic, 'Bloom radius', 0, 1, 0.01, state.bloom.radius, (value) => { state.bloom.radius = value; queueRebuild(); });
        createRange(cinematic, 'Bloom threshold', 0, 1, 0.01, state.bloom.threshold, (value) => { state.bloom.threshold = value; queueRebuild(); });

        createCheckbox(cinematic, 'Anamorphic flare', state.anamorphic.enabled, (value) => { state.anamorphic.enabled = value; queueRebuild(); });
        createRange(cinematic, 'Anamorphic threshold', 0, 1, 0.01, state.anamorphic.threshold, (value) => { state.anamorphic.threshold = value; queueRebuild(); });
        createRange(cinematic, 'Anamorphic scale', 1, 8, 0.1, state.anamorphic.scale, (value) => { state.anamorphic.scale = value; queueRebuild(); });
        createRange(cinematic, 'Anamorphic samples', 8, 48, 1, state.anamorphic.samples, (value) => { state.anamorphic.samples = value; queueRebuild(); });

        createCheckbox(cinematic, 'Depth of field', state.dof.enabled, (value) => { state.dof.enabled = value; queueRebuild(); });
        createRange(cinematic, 'DOF focus', 0.5, 50, 0.1, state.dof.focusDistance, (value) => { state.dof.focusDistance = value; queueRebuild(); });
        createRange(cinematic, 'DOF focal length', 0.5, 20, 0.1, state.dof.focalLength, (value) => { state.dof.focalLength = value; queueRebuild(); });
        createRange(cinematic, 'DOF bokeh', 0, 8, 0.1, state.dof.bokehScale, (value) => { state.dof.bokehScale = value; queueRebuild(); });
        sidebarEl.appendChild(cinematic);

        const stylize = createSection('Stylize', 'ASCII is an exclusive raw-scene view mode. The rest stack on the WebGPU post chain.');
        createCheckbox(stylize, 'RGB shift', state.rgbShift.enabled, (value) => { state.rgbShift.enabled = value; queueRebuild(); });
        createRange(stylize, 'RGB amount', 0, 0.02, 0.0005, state.rgbShift.amount, (value) => { state.rgbShift.amount = value; queueRebuild(); });
        createRange(stylize, 'RGB angle', 0, 6.28, 0.01, state.rgbShift.angle, (value) => { state.rgbShift.angle = value; queueRebuild(); });

        createCheckbox(stylize, 'Chromatic aberration', state.chromatic.enabled, (value) => { state.chromatic.enabled = value; queueRebuild(); });
        createRange(stylize, 'Chromatic strength', 0, 2, 0.05, state.chromatic.strength, (value) => { state.chromatic.strength = value; queueRebuild(); });
        createRange(stylize, 'Chromatic scale', 1, 1.4, 0.01, state.chromatic.scale, (value) => { state.chromatic.scale = value; queueRebuild(); });

        createCheckbox(stylize, 'Dot screen', state.dot.enabled, (value) => { state.dot.enabled = value; queueRebuild(); });
        createRange(stylize, 'Dot angle', 0, 6.28, 0.01, state.dot.angle, (value) => { state.dot.angle = value; queueRebuild(); });
        createRange(stylize, 'Dot scale', 0.05, 1.5, 0.01, state.dot.scale, (value) => { state.dot.scale = value; queueRebuild(); });

        createCheckbox(stylize, 'Film grain', state.film.enabled, (value) => { state.film.enabled = value; queueRebuild(); });
        createRange(stylize, 'Film intensity', 0, 1, 0.01, state.film.intensity, (value) => { state.film.intensity = value; queueRebuild(); });

        createCheckbox(stylize, 'Sobel edges', state.sobel.enabled, (value) => { state.sobel.enabled = value; queueRebuild(); });

        createCheckbox(stylize, 'Afterimage', state.afterImage.enabled, (value) => { state.afterImage.enabled = value; queueRebuild(); });
        createRange(stylize, 'Afterimage damp', 0.5, 0.99, 0.01, state.afterImage.damp, (value) => { state.afterImage.damp = value; queueRebuild(); });
        sidebarEl.appendChild(stylize);
    }

    addSidebar();
    rebuildPipeline();

    return {
        render,
        resize,
        requestRebuild: queueRebuild,
        dispose() {
            clearNodes();
            if (asciiEffect) {
                asciiEffect.domElement.remove();
                asciiEffect = null;
            }
        },
    };
}

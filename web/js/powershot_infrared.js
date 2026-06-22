// PowerSHOT infrared mode - pseudo-NIR night-vision / phosphor imaging.
//
// This is a separate imaging path from the visible-light digital ISP. It works
// in scene-linear 0..1+ values, packs adaptation / bloom / eye-glow sources
// into one quarter-resolution analysis target, then develops the final green
// phosphor image in one full-resolution pass.

import * as THREE from "three/webgpu";
import {
  vec2, vec3, vec4, float, uniform, texture, screenUV,
  mix, max, min, dot, abs, floor, fract, sin, cos, sqrt, log, exp, step,
  smoothstep,
} from "three/tsl";

const LUM709 = vec3(0.2126, 0.7152, 0.0722);

function exp2u(x) {
  return exp(x.mul(Math.LN2));
}

function srgbToLinear(c) {
  const lo = c.mul(1.0 / 12.92);
  const hi = c.add(0.055).div(1.055).max(0.0).pow(2.4);
  return mix(lo, hi, step(0.04045, c));
}

function linearToSrgb(c) {
  const v = c.clamp(0.0, 1.0);
  const lo = v.mul(12.92);
  const hi = v.pow(1.0 / 2.4).mul(1.055).sub(0.055);
  return mix(lo, hi, step(0.0031308, v));
}

function hash12(p) {
  const a = fract(vec3(p.x, p.y, p.x).mul(0.1031));
  const d = dot(a, vec3(a.y, a.z, a.x).add(33.33));
  const b = a.add(d);
  return fract(b.x.add(b.y).mul(b.z));
}

function hash13(p) {
  const a = fract(p.mul(0.1031));
  const d = dot(a, vec3(a.z, a.y, a.x).add(31.32));
  const b = a.add(d);
  return fract(b.x.add(b.y).mul(b.z));
}

function gaussFixed(p, salt) {
  const q = p.add(salt);
  const u1 = hash12(q).max(1e-6);
  const u2 = hash12(q.add(vec2(19.19, 7.41))).max(1e-6);
  return sqrt(log(u1).mul(-2.0)).mul(cos(u2.mul(6.2831853)));
}

function gaussTemporal(p, t, salt) {
  const u1 = hash13(vec3(p.x, p.y, t.add(salt))).max(1e-6);
  const u2 = hash13(vec3(p.x.add(11.0), p.y.add(3.0), t.add(salt).add(1.7))).max(1e-6);
  return sqrt(log(u1).mul(-2.0)).mul(cos(u2.mul(6.2831853)));
}

function pseudoNirValue(srcTex, ctx, uv) {
  const lin = srgbToLinear(texture(srcTex, uv).rgb);
  const broad = dot(lin, ctx.P.spectralMix);
  const redExcess = max(lin.r.sub(lin.g.add(lin.b).mul(0.5)), 0.0);
  const greenExcess = max(lin.g.sub(max(lin.r, lin.b)), 0.0);
  const simulated = broad
    .add(redExcess.mul(ctx.P.redReflectance))
    .add(greenExcess.mul(ctx.P.greenReflectance))
    .sub(lin.b.mul(ctx.P.blueSuppression));
  const monoInput = dot(lin, LUM709);

  return mix(simulated, monoInput, ctx.P.nirInput)
    .max(0.0)
    .mul(exp2u(ctx.P.exposure));
}

function phosphorMap(x, ctx) {
  let color = mix(
    ctx.P.shadowColor,
    ctx.P.midColor,
    smoothstep(0.0, ctx.P.midPoint, x),
  );
  color = mix(
    color,
    ctx.P.highlightColor,
    smoothstep(ctx.P.highlightStart, 1.0, x),
  );
  return color;
}

function infraredOutputAlpha(sourceSample, effectColor) {
  const sourceAlpha = sourceSample.a.clamp(0.0, 1.0);
  const effectDelta = dot(abs(effectColor.sub(sourceSample.rgb)), LUM709);
  const effectAlpha = effectDelta.sub(0.002).mul(6.0).clamp(0.0, 0.65);
  return sourceAlpha.add(effectAlpha.mul(sourceAlpha.oneMinus())).clamp(0.0, 1.0);
}

function stAnalysis(srcTex, ctx, eyeMaskTex) {
  const nir = pseudoNirValue(srcTex, ctx, screenUV);
  const glowMask = smoothstep(
    ctx.P.glowThreshold,
    ctx.P.glowThreshold.add(ctx.P.glowSoftness),
    nir,
  );
  const glowSource = nir.mul(glowMask);
  const mask = eyeMaskTex ? texture(eyeMaskTex, screenUV).r.clamp(0.0, 1.0) : float(0.0);
  return vec4(nir, glowSource, glowSource.mul(mask), 1.0);
}

function stAnalysisBlur(tex, ctx, dx, dy) {
  const sigma = 2.55;
  let sum = vec3(0.0);
  let wsum = 0.0;
  for (let i = -6; i <= 6; i += 1) {
    const w = Math.exp(-(i * i) / (2.0 * sigma * sigma));
    const off = ctx.analysisTexel.mul(vec2(dx, dy)).mul(ctx.P.glowRadius.mul(i));
    sum = sum.add(texture(tex, screenUV.add(off)).rgb.mul(w));
    wsum += w;
  }
  return vec4(sum.div(wsum), 1.0);
}

function stDevelop(srcTex, ctx, analysisTex, eyeMaskTex, stages) {
  const sourceSample = texture(srcTex, screenUV);
  const nir = pseudoNirValue(srcTex, ctx, screenUV);
  const analysis = analysisTex ? texture(analysisTex, screenUV).rgb : vec3(nir, 0.0, 0.0);
  let signal = nir;

  if (stages.adaptation) {
    const local = max(analysis.r, float(1e-4));
    const adaptiveGain = ctx.P.middleGrey
      .div(local)
      .pow(ctx.P.localGain)
      .clamp(ctx.P.minGain, ctx.P.maxGain);
    signal = signal.mul(adaptiveGain);
  }

  signal = signal.sub(ctx.P.blackPoint).max(0.0);
  const amplified = signal.mul(ctx.P.gain);
  signal = amplified.div(amplified.add(1.0)).pow(ctx.P.gamma);

  if (stages.glow) {
    signal = signal.add(analysis.g.mul(ctx.P.glowStrength));
  }

  if (stages.eyes) {
    const localContrast = nir.sub(analysis.r.mul(ctx.P.eyeLocalRatio)).max(0.0);
    const eyeCore = smoothstep(
      ctx.P.eyeThreshold,
      ctx.P.eyeThreshold.add(ctx.P.eyeSoftness),
      localContrast,
    ).mul(ctx.P.eyeStrength);
    signal = signal
      .add(eyeCore.mul(ctx.P.eyeCoreStrength))
      .add(eyeCore.mul(analysis.g).mul(ctx.P.eyeHaloStrength));

    if (eyeMaskTex) {
      const mask = texture(eyeMaskTex, screenUV).r.clamp(0.0, 1.0);
      signal = signal
        .add(analysis.b.mul(ctx.P.maskedEyeHalo).mul(ctx.P.eyeStrength))
        .add(eyeCore.mul(mask).mul(ctx.P.maskedEyeCore));
    }
  }

  if (stages.noise) {
    const px = screenUV.mul(ctx.resolution).div(max(ctx.P.noiseSize, float(0.5)));
    const cell = floor(px);
    const amount = ctx.P.noiseAmount;
    const read = gaussTemporal(cell, ctx.frame, 11.0)
      .mul(ctx.P.readNoise.mul(signal.oneMinus()).mul(amount));
    const shot = gaussTemporal(cell, ctx.frame, 37.0)
      .mul(sqrt(signal.add(1e-4)).mul(ctx.P.shotNoise).mul(amount));
    const column = gaussFixed(vec2(cell.x, 0.0), vec2(5.3, 0.0));
    const row = gaussFixed(vec2(0.0, cell.y), vec2(0.0, 9.7));
    const fixed = column.add(row).mul(0.5).mul(ctx.P.fixedPattern.mul(amount));
    const phosphor = gaussTemporal(cell, ctx.frame, 71.0)
      .mul(ctx.P.phosphorNoise.mul(amount));
    signal = signal.add(read).add(shot).add(fixed).add(phosphor).max(0.0);
  }

  if (stages.display) {
    const p = screenUV.sub(0.5);
    const aspect = ctx.resolution.x.div(ctx.resolution.y);
    const q = vec2(p.x.mul(aspect), p.y);
    const radius = sqrt(dot(q, q));
    const vignette = float(1.0).sub(
      smoothstep(0.25, 0.78, radius).mul(ctx.P.vignette),
    );
    const hotspot = exp(radius.mul(radius).mul(-8.0)).mul(ctx.P.hotspot);
    const scan = sin(screenUV.y.mul(ctx.resolution.y).mul(3.14159265))
      .mul(ctx.P.scanModulation);
    const flutter = hash13(vec3(floor(ctx.frame), 3.1, 8.7))
      .sub(0.5)
      .mul(ctx.P.flicker);
    signal = signal
      .mul(vignette)
      .add(hotspot)
      .mul(float(1.0).add(scan).add(flutter));
  }

  const phosphor = phosphorMap(signal.clamp(0.0, 1.35), ctx);
  const effectColor = linearToSrgb(phosphor).clamp(0.0, 1.0);
  const finalColor = mix(sourceSample.rgb, effectColor, ctx.power).clamp(0.0, 1.0);
  return vec4(finalColor, infraredOutputAlpha(sourceSample, finalColor));
}

export function makeInfraredUniforms() {
  return {
    resolution: uniform(new THREE.Vector2(1, 1)),
    texel: uniform(new THREE.Vector2(1, 1)),
    analysisTexel: uniform(new THREE.Vector2(1, 1)),
    frame: uniform(0),
    power: uniform(1),
    P: {
      exposure: uniform(1.0),
      nirInput: uniform(0.0),
      spectralMix: uniform(new THREE.Vector3(0.50, 0.42, 0.08)),
      redReflectance: uniform(0.22),
      greenReflectance: uniform(0.12),
      blueSuppression: uniform(0.08),

      middleGrey: uniform(0.18),
      localGain: uniform(0.35),
      minGain: uniform(0.65),
      maxGain: uniform(3.5),
      gain: uniform(2.2),
      blackPoint: uniform(0.008),
      gamma: uniform(0.68),

      glowThreshold: uniform(0.58),
      glowSoftness: uniform(0.20),
      glowStrength: uniform(0.55),
      glowRadius: uniform(1.4),

      eyeStrength: uniform(1.0),
      eyeThreshold: uniform(0.32),
      eyeSoftness: uniform(0.12),
      eyeLocalRatio: uniform(1.15),
      eyeCoreStrength: uniform(0.55),
      eyeHaloStrength: uniform(0.60),
      maskedEyeCore: uniform(0.90),
      maskedEyeHalo: uniform(0.85),

      noiseAmount: uniform(1.0),
      readNoise: uniform(0.022),
      shotNoise: uniform(0.035),
      fixedPattern: uniform(0.008),
      phosphorNoise: uniform(0.018),
      noiseSize: uniform(1.0),

      shadowColor: uniform(new THREE.Vector3(0.000, 0.008, 0.002)),
      midColor: uniform(new THREE.Vector3(0.025, 0.560, 0.080)),
      highlightColor: uniform(new THREE.Vector3(0.720, 1.000, 0.780)),
      midPoint: uniform(0.60),
      highlightStart: uniform(0.68),

      vignette: uniform(0.42),
      hotspot: uniform(0.12),
      scanModulation: uniform(0.015),
      flicker: uniform(0.012),

      persistence: uniform(0.0),
      persistenceRejection: uniform(8.0),
    },
  };
}

export const INFRARED_PRESETS = {
  ethereal_green: {
    name: "Ethereal Green NIR",
    sensor_resolution: [1280, 960],
    exposure: 1.25,
    nir_input: 0.0,
    spectral_mix: [0.50, 0.42, 0.08],
    red_reflectance: 0.28,
    green_reflectance: 0.16,
    blue_suppression: 0.10,
    middle_grey: 0.18,
    local_gain: 0.48,
    min_gain: 0.75,
    max_gain: 4.8,
    gain: 2.75,
    black_point: 0.010,
    gamma: 0.62,
    glow_threshold: 0.43,
    glow_softness: 0.28,
    glow_strength: 0.92,
    glow_radius: 1.75,
    eye_strength: 1.15,
    eye_threshold: 0.24,
    eye_softness: 0.15,
    eye_local_ratio: 1.10,
    eye_core_strength: 0.66,
    eye_halo_strength: 0.72,
    masked_eye_core: 0.98,
    masked_eye_halo: 0.95,
    noise_amount: 1.0,
    read_noise: 0.026,
    shot_noise: 0.038,
    fixed_pattern: 0.010,
    phosphor_noise: 0.022,
    noise_size: 1.0,
    shadow_color: [0.000, 0.008, 0.002],
    mid_color: [0.022, 0.520, 0.070],
    highlight_color: [0.760, 1.000, 0.800],
    mid_point: 0.58,
    highlight_start: 0.62,
    vignette: 0.52,
    hotspot: 0.12,
    scan_modulation: 0.018,
    flicker: 0.016,
    persistence: 0.0,
  },
  digital_850nm: {
    name: "850 nm Digital NoIR",
    sensor_resolution: [1920, 1080],
    exposure: 0.75,
    nir_input: 0.0,
    spectral_mix: [0.58, 0.36, 0.06],
    red_reflectance: 0.18,
    green_reflectance: 0.08,
    blue_suppression: 0.08,
    middle_grey: 0.18,
    local_gain: 0.28,
    min_gain: 0.70,
    max_gain: 2.8,
    gain: 2.15,
    black_point: 0.006,
    gamma: 0.72,
    glow_threshold: 0.66,
    glow_softness: 0.18,
    glow_strength: 0.32,
    glow_radius: 1.1,
    eye_strength: 0.72,
    eye_threshold: 0.36,
    eye_softness: 0.10,
    eye_local_ratio: 1.20,
    eye_core_strength: 0.46,
    eye_halo_strength: 0.32,
    masked_eye_core: 0.82,
    masked_eye_halo: 0.55,
    noise_amount: 0.55,
    read_noise: 0.015,
    shot_noise: 0.020,
    fixed_pattern: 0.004,
    phosphor_noise: 0.006,
    noise_size: 0.8,
    shadow_color: [0.000, 0.006, 0.002],
    mid_color: [0.030, 0.470, 0.065],
    highlight_color: [0.820, 1.000, 0.840],
    mid_point: 0.65,
    highlight_start: 0.74,
    vignette: 0.22,
    hotspot: 0.24,
    scan_modulation: 0.006,
    flicker: 0.004,
    persistence: 0.0,
  },
  white_phosphor: {
    name: "White Phosphor",
    sensor_resolution: [1280, 960],
    exposure: 1.0,
    nir_input: 0.0,
    spectral_mix: [0.52, 0.40, 0.08],
    red_reflectance: 0.22,
    green_reflectance: 0.10,
    blue_suppression: 0.08,
    middle_grey: 0.18,
    local_gain: 0.38,
    min_gain: 0.70,
    max_gain: 3.6,
    gain: 2.35,
    black_point: 0.008,
    gamma: 0.66,
    glow_threshold: 0.55,
    glow_softness: 0.24,
    glow_strength: 0.54,
    glow_radius: 1.45,
    eye_strength: 0.90,
    eye_threshold: 0.30,
    eye_softness: 0.12,
    eye_local_ratio: 1.15,
    eye_core_strength: 0.56,
    eye_halo_strength: 0.50,
    masked_eye_core: 0.90,
    masked_eye_halo: 0.80,
    noise_amount: 0.72,
    read_noise: 0.020,
    shot_noise: 0.030,
    fixed_pattern: 0.006,
    phosphor_noise: 0.012,
    noise_size: 1.0,
    shadow_color: [0.003, 0.006, 0.010],
    mid_color: [0.360, 0.470, 0.520],
    highlight_color: [0.940, 0.980, 1.000],
    mid_point: 0.62,
    highlight_start: 0.70,
    vignette: 0.36,
    hotspot: 0.12,
    scan_modulation: 0.010,
    flicker: 0.008,
    persistence: 0.0,
  },
};

export const INFRARED_PRESET_KEYS = Object.keys(INFRARED_PRESETS);

export function applyInfraredPreset(ctx, preset) {
  const P = ctx.P;
  P.exposure.value = preset.exposure;
  P.nirInput.value = preset.nir_input;
  P.spectralMix.value.set(...preset.spectral_mix);
  P.redReflectance.value = preset.red_reflectance;
  P.greenReflectance.value = preset.green_reflectance;
  P.blueSuppression.value = preset.blue_suppression;
  P.middleGrey.value = preset.middle_grey;
  P.localGain.value = preset.local_gain;
  P.minGain.value = preset.min_gain;
  P.maxGain.value = preset.max_gain;
  P.gain.value = preset.gain;
  P.blackPoint.value = preset.black_point;
  P.gamma.value = preset.gamma;
  P.glowThreshold.value = preset.glow_threshold;
  P.glowSoftness.value = preset.glow_softness;
  P.glowStrength.value = preset.glow_strength;
  P.glowRadius.value = preset.glow_radius;
  P.eyeStrength.value = preset.eye_strength;
  P.eyeThreshold.value = preset.eye_threshold;
  P.eyeSoftness.value = preset.eye_softness;
  P.eyeLocalRatio.value = preset.eye_local_ratio;
  P.eyeCoreStrength.value = preset.eye_core_strength;
  P.eyeHaloStrength.value = preset.eye_halo_strength;
  P.maskedEyeCore.value = preset.masked_eye_core;
  P.maskedEyeHalo.value = preset.masked_eye_halo;
  P.noiseAmount.value = preset.noise_amount;
  P.readNoise.value = preset.read_noise;
  P.shotNoise.value = preset.shot_noise;
  P.fixedPattern.value = preset.fixed_pattern;
  P.phosphorNoise.value = preset.phosphor_noise;
  P.noiseSize.value = preset.noise_size;
  P.shadowColor.value.set(...preset.shadow_color);
  P.midColor.value.set(...preset.mid_color);
  P.highlightColor.value.set(...preset.highlight_color);
  P.midPoint.value = preset.mid_point;
  P.highlightStart.value = preset.highlight_start;
  P.vignette.value = preset.vignette;
  P.hotspot.value = preset.hotspot;
  P.scanModulation.value = preset.scan_modulation;
  P.flicker.value = preset.flicker;
  P.persistence.value = preset.persistence ?? 0;
}

export const INFRARED_STAGE_DEFS = [
  { id: "adaptation", label: "Local gain adaptation" },
  { id: "glow", label: "Infrared bloom" },
  { id: "eyes", label: "Retinal flare" },
  { id: "noise", label: "Sensor and phosphor noise" },
  { id: "display", label: "Phosphor display response" },
  { id: "persistence", label: "Phosphor persistence" },
];

export class InfraredPipeline {
  constructor(renderer) {
    this.renderer = renderer;
    this.ctx = makeInfraredUniforms();

    const opts = {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      colorSpace: THREE.NoColorSpace,
    };
    this.rtAnalysisA = new THREE.RenderTarget(1, 1, opts);
    this.rtAnalysisB = new THREE.RenderTarget(1, 1, { ...opts });

    this.quadScene = new THREE.Scene();
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    this.mesh.frustumCulled = false;
    this.quadScene.add(this.mesh);

    this.enabled = new Set(["adaptation", "glow", "eyes", "noise", "display"]);
    this.source = null;
    this.eyeMask = null;
    this.size = { w: 0, h: 0 };
    this.analysisSteps = [];
    this.developMat = null;
    this.dirty = true;
  }

  _mat(colorNode) {
    const m = new THREE.MeshBasicNodeMaterial();
    m.colorNode = colorNode;
    m.depthTest = false;
    m.depthWrite = false;
    m.toneMapped = false;
    return m;
  }

  setSource(tex) {
    if (this.source === tex) return;
    this.source = tex;
    this.clearHistory();
    this.dirty = true;
  }

  setSize(w, h) {
    if (w === this.size.w && h === this.size.h) return;
    const aw = Math.max(1, Math.round(w / 4));
    const ah = Math.max(1, Math.round(h / 4));
    this.rtAnalysisA.setSize(aw, ah);
    this.rtAnalysisB.setSize(aw, ah);
    this.size = { w, h };
    this.ctx.resolution.value.set(w, h);
    this.ctx.texel.value.set(1 / w, 1 / h);
    this.ctx.analysisTexel.value.set(1 / aw, 1 / ah);
    this.clearHistory();
    this.dirty = true;
  }

  setInputMode(mode) {
    this.ctx.P.nirInput.value = mode === "nir" ? 1 : 0;
  }

  setEyeMask(textureObject) {
    if (this.eyeMask === textureObject) return;
    if (textureObject) {
      textureObject.colorSpace = THREE.NoColorSpace;
      textureObject.flipY = false;
      textureObject.generateMipmaps = false;
      textureObject.minFilter = THREE.LinearFilter;
      textureObject.magFilter = THREE.LinearFilter;
    }
    this.eyeMask = textureObject || null;
    this.dirty = true;
  }

  clearEyeMask() {
    this.setEyeMask(null);
  }

  clearHistory() {
    // Reserved for the persistence pass. Static infrared has no history state.
  }

  setEnabled(id, on) {
    const hasStage = this.enabled.has(id);
    if (on === hasStage) return;
    if (on) this.enabled.add(id);
    else this.enabled.delete(id);
    this.dirty = true;
  }

  _rebuild() {
    for (const s of this.analysisSteps) s.material.dispose();
    if (this.developMat) this.developMat.dispose();
    this.analysisSteps = [];
    this.developMat = null;
    this.dirty = false;
    if (!this.source) return;

    const stages = {
      adaptation: this.enabled.has("adaptation"),
      glow: this.enabled.has("glow"),
      eyes: this.enabled.has("eyes"),
      noise: this.enabled.has("noise"),
      display: this.enabled.has("display"),
    };
    const needsAnalysis = stages.adaptation || stages.glow || stages.eyes;

    if (needsAnalysis) {
      this.analysisSteps.push({
        material: this._mat(stAnalysis(this.source, this.ctx, this.eyeMask)),
        target: this.rtAnalysisA,
      });
      this.analysisSteps.push({
        material: this._mat(stAnalysisBlur(this.rtAnalysisA.texture, this.ctx, 1, 0)),
        target: this.rtAnalysisB,
      });
      this.analysisSteps.push({
        material: this._mat(stAnalysisBlur(this.rtAnalysisB.texture, this.ctx, 0, 1)),
        target: this.rtAnalysisA,
      });
    }

    this.developMat = this._mat(
      stDevelop(
        this.source,
        this.ctx,
        needsAnalysis ? this.rtAnalysisA.texture : null,
        this.eyeMask,
        stages,
      ),
    );
    this.developMat.transparent = true;
    this.developMat.blending = THREE.NoBlending;
  }

  renderTexture(inputTexture, frame = 0, { outputTarget = null } = {}) {
    if (!inputTexture) return false;
    this.setSource(inputTexture);
    if (this.dirty) this._rebuild();
    if (!this.source || !this.developMat) return false;
    this.ctx.frame.value = frame;
    const r = this.renderer;
    const previousTarget = r.getRenderTarget?.() ?? null;

    try {
      for (const step of this.analysisSteps) {
        this.mesh.material = step.material;
        r.setRenderTarget(step.target);
        r.render(this.quadScene, this.quadCam);
      }
      this.mesh.material = this.developMat;
      r.setRenderTarget(outputTarget);
      r.render(this.quadScene, this.quadCam);
      return true;
    } finally {
      r.setRenderTarget(previousTarget);
    }
  }

  async render(frame) {
    this.renderTexture(this.source, frame);
  }

  dispose() {
    for (const s of this.analysisSteps) s.material.dispose();
    this.analysisSteps = [];
    if (this.developMat) this.developMat.dispose();
    this.developMat = null;
    this.rtAnalysisA.dispose();
    this.rtAnalysisB.dispose();
    this.mesh.geometry.dispose();
  }
}

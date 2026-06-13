// webapp_host.js — shared DOM host builders for webapp presentation.
// Used by webapp_layer.js (project-spec'd layers) and maxjs_webapp.js
// (WebApp Animator origin nodes synced from Max).
//
// Two presentation modes:
//   - css3d:  iframe wrapped in a CSS3DObject (crisp DOM, clickable, overlay only).
//   - texture: HTMLMesh from three/addons (DOM rasterized to a plane mesh, composites with WebGL).

import * as overlay from './css3d_overlay.js';
import { injectHtmlDocument } from './html_texture.js';

const DEFAULT_WEBAPP_SIZE = { width: 1280, height: 720 };

function readNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function readWebappSize(size) {
    return {
        width:  Math.max(1, readNumber(size?.width,  DEFAULT_WEBAPP_SIZE.width)),
        height: Math.max(1, readNumber(size?.height, DEFAULT_WEBAPP_SIZE.height)),
    };
}

function formatParamValue(value) {
    if (typeof value === 'number') return String(value);
    if (typeof value === 'boolean') return value ? '1' : '0';
    if (Array.isArray(value) && value.every(n => typeof n === 'number')) {
        if (value.length === 3) return `rgb(${value.map(v => Math.round(v * 255)).join(',')})`;
        return value.join(',');
    }
    return String(value ?? '');
}

function sanitizeParamName(name) {
    return String(name ?? '').trim().replace(/[^a-zA-Z0-9_-]/g, '-');
}

// Writes one param to a host element as a CSS variable + dataset attribute.
// For cross-origin iframes this only styles the iframe element itself; the
// content reads params via the maxjs:params postMessage instead.
function writeHostParam(host, name, formatted) {
    const safe = sanitizeParamName(name);
    if (!safe) return;
    try { host.style.setProperty(`--param-${safe}`, formatted); } catch {}
    try { host.dataset[safe.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = formatted; } catch {}
}

// Same-origin iframes also get CSS variables on their documentElement so
// pure-CSS apps work without any script. Cross-origin access throws — caught.
function writeIframeContentParam(iframe, name, formatted) {
    const safe = sanitizeParamName(name);
    if (!safe) return;
    try {
        iframe?.contentDocument?.documentElement?.style?.setProperty(`--param-${safe}`, formatted);
    } catch {}
}

function postParamsToIframe(iframe, params) {
    try {
        iframe?.contentWindow?.postMessage({ type: 'maxjs:params', params }, '*');
    } catch {}
}

function resolveWebappUrl(rawUrl, baseUrl) {
    if (!rawUrl) return '';
    if (/^https?:\/\//i.test(rawUrl) || /^data:/i.test(rawUrl)) return rawUrl;
    if (!baseUrl) return rawUrl;
    try {
        const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
        return new URL(rawUrl.replace(/\\/g, '/'), base).toString();
    } catch {
        return rawUrl;
    }
}

function isLocalAssetUrl(url) {
    return /^https:\/\/[^/]*\.local\//i.test(url || '');
}

// Fetch a locally-served page and adopt it via srcdoc so the iframe document
// becomes same-origin with the viewer: synthetic event dispatch, direct CSS
// variable writes, and injected per-layer stylesheets all work. A <base href>
// keeps relative asset URLs resolving against the source directory.
function layerBridgeScript(layerIndex, layerCount) {
    const index = Math.max(0, Math.floor(readNumber(layerIndex, 0)));
    const count = Math.max(1, Math.floor(readNumber(layerCount, 1)));
    return `
<script data-maxjs-webapp-layer-bridge>
(() => {
  const index = ${JSON.stringify(index)};
  const count = ${JSON.stringify(count)};
  // Every style/dataset write below is guarded (skip when the value is
  // already applied). The MutationObserver watches 'style' attributes, so an
  // unguarded write re-fires the observer on our own mutation and the
  // cleanup becomes a permanent per-frame reflow loop.
  function setImportant(el, prop, value) {
    if (el.style.getPropertyValue(prop) === value &&
        el.style.getPropertyPriority(prop) === 'important') return;
    el.style.setProperty(prop, value, 'important');
  }
  function isOpaqueDarkBackdrop(color) {
    const match = String(color || '').match(/rgba?\\(([^)]+)\\)/i);
    if (!match) return false;
    const parts = match[1].split(',').map((v) => Number(String(v).trim()));
    if (parts.length < 3 || parts.some((v, i) => i < 3 && !Number.isFinite(v))) return false;
    const alpha = parts.length >= 4 && Number.isFinite(parts[3]) ? parts[3] : 1;
    return alpha > 0.95 && parts[0] <= 16 && parts[1] <= 16 && parts[2] <= 16;
  }
  function coversViewport(el) {
    if (!el || el === document.documentElement || el === document.body) return true;
    const rect = el.getBoundingClientRect();
    const vw = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);
    const vh = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
    return rect.width >= vw * 0.85 && rect.height >= vh * 0.85 &&
      rect.left <= vw * 0.15 && rect.top <= vh * 0.15;
  }
  function clearBackdropElement(el) {
    if (!el) return;
    // Longhands only — clearing the 'background' shorthand reserializes the
    // whole style attribute every pass, which defeats the write guards.
    setImportant(el, 'background-color', 'transparent');
    setImportant(el, 'background-image', 'none');
  }
  function setIdentity() {
    try {
      const docEl = document.documentElement;
      if (docEl.style.getPropertyValue('--maxjs-layer-index') !== String(index)) {
        docEl.style.setProperty('--maxjs-layer-index', String(index));
      }
      if (docEl.style.getPropertyValue('--maxjs-layer-count') !== String(count)) {
        docEl.style.setProperty('--maxjs-layer-count', String(count));
      }
      if (docEl.dataset.maxjsLayer !== String(index)) docEl.dataset.maxjsLayer = String(index);
      if (docEl.dataset.maxjsLayers !== String(count)) docEl.dataset.maxjsLayers = String(count);
    } catch {}
  }
  function clearLayerBackdrops() {
    try {
      clearBackdropElement(document.documentElement);
      clearBackdropElement(document.body);
      const root = document.getElementById('root');
      if (root && coversViewport(root)) clearBackdropElement(root);
      document.querySelectorAll('body > *, #root > *').forEach((el) => {
        if (!coversViewport(el)) return;
        const bg = getComputedStyle(el).backgroundColor;
        if (isOpaqueDarkBackdrop(bg)) clearBackdropElement(el);
      });
    } catch {}
  }
  let backdropCleanupQueued = false;
  function queueBackdropCleanup() {
    if (backdropCleanupQueued) return;
    backdropCleanupQueued = true;
    requestAnimationFrame(() => {
      backdropCleanupQueued = false;
      setIdentity();
      clearLayerBackdrops();
    });
  }
  function publish() {
    setIdentity();
    clearLayerBackdrops();
    try { window.postMessage({ type: 'maxjs:layer', index, count }, '*'); } catch {}
  }
  publish();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', publish, { once: true });
  }
  requestAnimationFrame(publish);
  setTimeout(publish, 50);
  setTimeout(publish, 150);
  setTimeout(publish, 500);
  setTimeout(publish, 1000);
  try {
    // Backdrop cleanup only — no maxjs:layer postMessage from mutations.
    // Pages that re-render on that message would otherwise self-sustain:
    // message → render → mutation → message.
    const observer = new MutationObserver(queueBackdropCleanup);
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
  } catch {}
})();
</` + `script>`;
}

async function applySrcdocAdoption(iframe, url, injectCss, layerIdentity = null) {
    try {
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const text = await response.text();
        const baseHref = url.replace(/[^/]*$/, '');
        const injected = '<base href="' + baseHref + '">' +
            '<style data-maxjs-webapp-base>:root{color-scheme:light;}html,body{background:transparent;}</style>' +
            (injectCss ? '<style data-maxjs-webapp-inject>' + injectCss + '</style>' : '') +
            layerBridgeScript(layerIdentity?.index ?? 0, layerIdentity?.count ?? 1);
        iframe.srcdoc = /<head[^>]*>/i.test(text)
            ? text.replace(/<head[^>]*>/i, m => m + injected)
            : '<head>' + injected + '</head>' + text;
        return true;
    } catch (error) {
        console.warn('[max.js webapp] srcdoc adoption failed, falling back to src', url, error);
        iframe.src = url;
        return false;
    }
}

async function createCSS3DHost({ url, width, height, interactive, behind = false, adoptLocal = false, injectCss = '', layerIndex = 0, layerCount = 1 }) {
    const { CSS3DObject } = await (behind ? overlay.acquireBehind() : overlay.acquire());
    const size = readWebappSize({ width, height });
    const iframe = document.createElement('iframe');
    iframe.style.width = `${size.width}px`;
    iframe.style.height = `${size.height}px`;
    iframe.style.border = '0';
    iframe.style.background = 'transparent';
    // Chromium forces an opaque white canvas behind an iframe whose used
    // color-scheme differs from its content (dark viewer × light-default
    // page). Pin the element to light — pages that opt into dark still
    // render their own backgrounds; transparency survives.
    iframe.style.colorScheme = 'light';
    iframe.setAttribute('frameborder', '0');
    iframe.setAttribute('allowtransparency', 'true');
    let sameOrigin = false;
    if (url) {
        if (adoptLocal && isLocalAssetUrl(url)) {
            sameOrigin = true;  // srcdoc lands async; load event still fires after adoption
            applySrcdocAdoption(iframe, url, injectCss, { index: layerIndex, count: layerCount });
        } else {
            iframe.src = url;
        }
    }
    const obj = new CSS3DObject(iframe);
    // After construction — CSS3DObject's constructor forces pointerEvents to
    // 'auto', which would make non-interactive panels swallow viewport input.
    // Behind-canvas panels never receive direct DOM input (the canvas covers
    // them); their input arrives via dom_panel_forwarding.js.
    iframe.style.pointerEvents = (!behind && interactive) ? 'auto' : 'none';
    return { obj, host: iframe, isIframe: true, presentation: 'css3d', behind, sameOrigin };
}

// Experimental "div host" CSS3D mode (opt-in via maxjs-host=div in the URL):
// instead of an iframe, the page's document is shadow-injected onto a plain
// div whose transform-style is preserve-3d. Because a div is not an atomic
// replaced element, inner translateZ participates in the CSS3D scene's 3D
// context — elements float in TRUE scene depth (1px ≈ displaySize/width
// world units, since object scale applies). Drive translateZ from
// --param-* channels for Max-animated depth.
//
// Contract: no overflow/opacity(<1)/filter on the lifted chain — CSS
// grouping properties flatten 3D (including the panel's own Opacity fade,
// which degrades gracefully to flat). Front-overlay mode gets native DOM
// input; behind/depth-occlude mode is display-only for div hosts and the
// punch only covers the base rect — lifted elements past the rect edge are
// covered by the canvas.
async function createCSS3DDivHost({ url, width, height, interactive, behind = false, injectCss = '' }) {
    const { CSS3DObject } = await (behind ? overlay.acquireBehind() : overlay.acquire());
    const size = readWebappSize({ width, height });
    const host = document.createElement('div');
    host.className = 'maxjs-webapp-div-host';
    host.style.width = `${size.width}px`;
    host.style.height = `${size.height}px`;
    host.style.background = 'transparent';
    host.style.transformStyle = 'preserve-3d';
    host.style.overflow = 'visible';
    const obj = new CSS3DObject(host);
    host.style.pointerEvents = (!behind && interactive) ? 'auto' : 'none';
    const depthCss = 'html,body{transform-style:preserve-3d;background:transparent;}' + (injectCss || '');
    if (url) {
        // Viewer flags ride the URL but the virtual host mapping treats query
        // strings as part of the filename — fetch the clean document URL.
        let fetchUrl = url;
        try {
            const u = new URL(url);
            ['maxjs-host', 'maxjs-layer', 'maxjs-layers'].forEach((k) => u.searchParams.delete(k));
            fetchUrl = u.toString().replace(/\?$/, '');
        } catch {}
        injectHtmlDocument(host, fetchUrl, { width: size.width, height: size.height }, depthCss)
            .catch((error) => console.warn('[max.js webapp] div-host injection failed', fetchUrl, error));
    }
    return { obj, host, isIframe: false, sameOrigin: true, presentation: 'css3d', behind, divHost: true };
}

async function createTextureHost({ url, width, height }) {
    const { HTMLMesh } = await import('three/addons/interactive/HTMLMesh.js');
    const size = readWebappSize({ width, height });
    const host = document.createElement('div');
    host.style.position = 'fixed';
    host.style.left = '-99999px';
    host.style.top = '0';
    host.style.width = `${size.width}px`;
    host.style.height = `${size.height}px`;
    host.style.background = 'transparent';
    host.style.pointerEvents = 'none';
    document.body.appendChild(host);

    if (url) {
        try {
            const html = await fetch(url, { cache: 'no-store' }).then(r => r.text());
            const doc = new DOMParser().parseFromString(html, 'text/html');
            for (const styleEl of doc.querySelectorAll('style, link[rel="stylesheet"]')) {
                host.appendChild(styleEl.cloneNode(true));
            }
            host.appendChild(doc.body.cloneNode(true));
        } catch (error) {
            host.textContent = `webapp fetch failed: ${error?.message || error}`;
        }
    }

    const mesh = new HTMLMesh(host);
    return { obj: mesh, host, isIframe: false, presentation: 'texture' };
}

function teardownWebappHost(entry) {
    if (!entry) return;
    try { entry.obj.parent?.remove(entry.obj); } catch {}
    if (typeof entry.obj?.dispose === 'function') {
        try { entry.obj.dispose(); } catch {}
    }
    if (entry.host?.parentNode) {
        try { entry.host.parentNode.removeChild(entry.host); } catch {}
    }
    if (entry.presentation === 'css3d') overlay.release();
}

export {
    DEFAULT_WEBAPP_SIZE,
    createCSS3DDivHost,
    createCSS3DHost,
    createTextureHost,
    formatParamValue,
    isLocalAssetUrl,
    layerBridgeScript,
    postParamsToIframe,
    resolveWebappUrl,
    sanitizeParamName,
    teardownWebappHost,
    writeHostParam,
    writeIframeContentParam,
};

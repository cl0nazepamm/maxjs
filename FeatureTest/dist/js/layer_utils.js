// Shared Layer Manager utility helpers.

const MATRIX_EPSILON = 1e-6;

function matrixElementsAlmostEqual(a, b, epsilon = MATRIX_EPSILON) {
    if (!a || !b) return false;
    const ae = a.elements ?? a;
    const be = b.elements ?? b;
    if (!ae || !be || ae.length !== be.length) return false;
    for (let i = 0; i < ae.length; i++) {
        if (Math.abs(ae[i] - be[i]) > epsilon) return false;
    }
    return true;
}

function freezePlainObject(obj) {
    return Object.freeze(obj);
}
function normalizeFolder(raw) {
    if (typeof raw !== 'string') return '';
    const trimmed = raw.trim().replace(/^\/+|\/+$/g, '').replace(/\\/g, '/');
    if (!trimmed) return '';
    const parts = trimmed.split('/').filter(p => p && p !== '.' && p !== '..');
    return parts.join('/');
}

function normalizePriority(raw) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return 100;
    return n;
}
export {
    freezePlainObject,
    matrixElementsAlmostEqual,
    normalizeFolder,
    normalizePriority,
};

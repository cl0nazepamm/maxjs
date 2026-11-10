// Max's OpenPBR exporter can author a scalar multiplier AND a map reference
// on one input. r186 prioritizes the literal. Express the existing max.js
// multiplication policy as ordinary MaterialX, leaving the upstream loader intact.
export function normalizeMaxMaterialXInputs(doc) {
    const weights = new Set([
        'base_weight', 'base_metalness', 'specular_weight', 'specular_roughness_anisotropy',
        'coat_weight', 'fuzz_weight', 'transmission_weight', 'thin_film_weight', 'emission_luminance',
    ]);
    const names = new Set(Array.from(doc.querySelectorAll('[name]'), node => node.getAttribute('name')));
    let serial = 0;
    for (const surface of doc.querySelectorAll('open_pbr_surface')) {
        const inputs = Array.from(surface.children);
        for (const input of inputs) {
            const key = input.getAttribute('name');
            if (key === 'specular_ior_level' && !inputs.some(node => node.getAttribute('name') === 'specular_ior')) {
                input.setAttribute('name', 'specular_ior');
            }
            if (!weights.has(key) || !input.hasAttribute('value')) continue;
            if (!input.hasAttribute('nodename') && !input.hasAttribute('nodegraph')) continue;
            const weight = Number(input.getAttribute('value'));
            if (!Number.isFinite(weight)) continue;
            if (Math.abs(weight) <= 1e-6) {
                for (const attr of ['nodename', 'nodegraph', 'output']) input.removeAttribute(attr);
                input.setAttribute('value', '0');
                continue;
            }
            if (Math.abs(weight - 1) <= 1e-6) {
                input.removeAttribute('value');
                continue;
            }
            let name;
            do { name = `maxjs_weight_${serial++}`; } while (names.has(name));
            names.add(name);
            const multiply = doc.createElement('multiply');
            multiply.setAttribute('name', name);
            multiply.setAttribute('type', 'float');
            const map = input.cloneNode(true);
            map.setAttribute('name', 'in1');
            map.removeAttribute('value');
            const scalar = doc.createElement('input');
            scalar.setAttribute('name', 'in2');
            scalar.setAttribute('type', 'float');
            scalar.setAttribute('value', String(weight));
            multiply.append(map, scalar);
            surface.parentNode.insertBefore(multiply, surface);
            for (const attr of ['value', 'nodegraph', 'output']) input.removeAttribute(attr);
            input.setAttribute('nodename', name);
        }
    }
}

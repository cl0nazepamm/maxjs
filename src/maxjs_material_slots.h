// maxjs_material_slots.h
// ─────────────────────────────────────────────────────────────────────────────
// SINGLE SOURCE OF TRUTH for the texture-map slots of MaxJSPBR (the per-material
// data carrier, a.k.a. "MaterialData") on the SERIALIZATION (write) side ONLY.
//
// Each descriptor binds:
//   • the exact JSON key the C++ serializer EMITS (jsonKey)             — wire key
//   • the matching transform sibling key (xfKey, may be nullptr)        — wire key
//   • the slot's semantic kind (SlotKind)
//   • pointer-to-member into MaxJSPBR for {path, transform}             — write side
//   • the strength source descriptor (where one exists; informational)
//   • whether the SNAPSHOT material_builder.js currently READS this key
//
// This table drives MaxJSPanel::WriteMaterialTextures so the per-slot write loop
// has ONE ordered list instead of 21 hand-written calls. It produces byte-for-byte
// identical JSON: same keys, same emission order, same value shapes, same
// omit-when-empty behavior. The TexTransform shape, the TSL/HTML early-return
// branches, and MapTexturePath()/MapAssetPath() remap all stay in the writer.
//
// SCOPE GUARDRAIL: this header is WRITE-SIDE ONLY. It contains NO Mtl*/Texmap*/
// ParamBlock probing, NO GetSubTexmap, NO Class_ID dispatch. The extractor side
// (ExtractMaterialTexture, ExtractWrappedNormalBumpMaps, the named-PB readMap
// lambdas, etc. in maxjs_material_sync.h) is intentionally NOT touched and must
// stay hand-written per renderer.
//
// INCLUDE ORDER: pointer-to-member requires the COMPLETE MaxJSPBR type. We pull
// it in here; this header must be included AFTER (or it transitively includes)
// maxjs_material_sync.h. In maxjs_main.cpp, include this immediately after
// `#include "maxjs_material_sync.h"`.
// ─────────────────────────────────────────────────────────────────────────────
#pragma once

#include "maxjs_material_sync.h"   // defines MaxJSPBR (complete type required below)

#include <array>
#include <cstddef>

namespace maxjs {

// Semantic kind of a texture slot. Informational/grouping only — the writer does
// not branch on this today, but the harness and future readers can.
enum class SlotKind {
    Color,           // base/albedo/diffuse, specular tint, sss color, specular color
    Scalar,          // roughness, metalness, opacity, transmission, clearcoat weight, etc.
    Normal,          // tangent/object-space normal
    Bump,            // height/bump
    Displacement,    // displacement/height
    Parallax,        // parallax offset
    Emission,        // emissive
    AmbientOcclusion,
    Lightmap,        // baked lighting
    Matcap,          // lit-sphere
    Gradient,        // toon ramp
};

// How the slot's "strength"/scalar intensity is carried on the wire. This is
// PURELY informational for tooling/validation — WriteMaterialFull emits the
// strength fields itself at fixed positions, NOT through this table. We record
// the source so the harness and humans can see which scalar gates a slot.
enum class StrengthSource {
    None,            // slot has no associated scalar (gradMap, sssMap, matcap, etc.)
    DedicatedField,  // a *Strength member exists & is emitted as its own key (mapS/roughMapS/...)
    SharedScalar,    // reuses a shared material scalar (normScl, bumpS, aoI, dispS/dispB, parallaxS, lmI...)
};

struct MaterialSlot {
    SlotKind          kind;
    const wchar_t*    jsonKey;   // EXACT key emitted by the serializer (e.g. L"map")
    const wchar_t*    xfKey;     // transform sibling key, or nullptr (gradMap) -> no xf emitted
    // Write-side pointer-to-member into the MaterialData carrier.
    std::wstring             MaxJSPBR::* path;       // texture file path member
    MaxJSPBR::TexTransform   MaxJSPBR::* transform;  // UV/sampling transform member
    StrengthSource    strength;       // how the slot's intensity is carried (informational)
    const wchar_t*    strengthKey;    // emitted strength key if DedicatedField, else nullptr (informational)
    bool              readBySnapshotBuilder;  // false => write-only key (see MISMATCH note)
};

// ─────────────────────────────────────────────────────────────────────────────
// THE TABLE. Order MUST match the writeMap() call sequence in
// WriteMaterialTextures (maxjs_panel_sync.inl:3898-3918) exactly, because the
// serializer iterates this array in order and emits commas left-to-right.
//
// strengthKey is for tooling only; the writer never reads it (the strength
// fields are emitted by WriteMaterialFull at their own fixed offsets). xfKey ==
// nullptr reproduces gradMap's "no transform sibling" behavior.
// ─────────────────────────────────────────────────────────────────────────────
inline constexpr std::array<MaterialSlot, 21> kMaterialSlots = {{
    // kind                     jsonKey         xfKey             path member                     transform member                          strength          strengthKey     readByBuilder
    { SlotKind::Color,          L"map",         L"mapXf",         &MaxJSPBR::colorMap,             &MaxJSPBR::colorMapTransform,             StrengthSource::DedicatedField, L"mapS",       true  },
    { SlotKind::Gradient,       L"gradMap",     nullptr,          &MaxJSPBR::gradientMap,          &MaxJSPBR::gradientMapTransform,          StrengthSource::None,           nullptr,       true  }, // toon-only reader
    { SlotKind::Scalar,         L"roughMap",    L"roughMapXf",    &MaxJSPBR::roughnessMap,         &MaxJSPBR::roughnessMapTransform,         StrengthSource::DedicatedField, L"roughMapS",  true  },
    { SlotKind::Scalar,         L"metalMap",    L"metalMapXf",    &MaxJSPBR::metalnessMap,         &MaxJSPBR::metalnessMapTransform,         StrengthSource::DedicatedField, L"metalMapS",  true  },
    { SlotKind::Normal,         L"normMap",     L"normMapXf",     &MaxJSPBR::normalMap,            &MaxJSPBR::normalMapTransform,            StrengthSource::SharedScalar,   nullptr,       true  }, // normScl
    { SlotKind::Bump,           L"bumpMap",     L"bumpMapXf",     &MaxJSPBR::bumpMap,              &MaxJSPBR::bumpMapTransform,              StrengthSource::SharedScalar,   nullptr,       true  }, // bumpS
    { SlotKind::Displacement,   L"dispMap",     L"dispMapXf",     &MaxJSPBR::displacementMap,      &MaxJSPBR::displacementMapTransform,      StrengthSource::SharedScalar,   nullptr,       true  }, // dispS/dispB
    { SlotKind::Parallax,       L"parallaxMap", L"parallaxMapXf", &MaxJSPBR::parallaxMap,          &MaxJSPBR::parallaxMapTransform,          StrengthSource::SharedScalar,   nullptr,       false }, // parallaxS — WRITE-ONLY, no JS reader
    { SlotKind::AmbientOcclusion,L"aoMap",      L"aoMapXf",       &MaxJSPBR::aoMap,                &MaxJSPBR::aoMapTransform,                StrengthSource::SharedScalar,   nullptr,       true  }, // aoI
    { SlotKind::Color,          L"sssMap",      L"sssMapXf",      &MaxJSPBR::sssColorMap,          &MaxJSPBR::sssColorMapTransform,          StrengthSource::None,           nullptr,       false }, // not read by material_builder.js; read by index.html SSS node path
    { SlotKind::Matcap,         L"matcapMap",   L"matcapMapXf",   &MaxJSPBR::matcapMap,            &MaxJSPBR::matcapMapTransform,            StrengthSource::None,           nullptr,       true  },
    { SlotKind::Color,          L"specMap",     L"specMapXf",     &MaxJSPBR::specularMap,          &MaxJSPBR::specularMapTransform,          StrengthSource::None,           nullptr,       true  },
    { SlotKind::Scalar,         L"specIntMap",  L"specIntMapXf",  &MaxJSPBR::specularIntensityMap, &MaxJSPBR::specularIntensityMapTransform, StrengthSource::None,           nullptr,       true  },
    { SlotKind::Color,          L"specColMap",  L"specColMapXf",  &MaxJSPBR::specularColorMap,     &MaxJSPBR::specularColorMapTransform,     StrengthSource::None,           nullptr,       true  },
    { SlotKind::Emission,       L"emMap",       L"emMapXf",       &MaxJSPBR::emissionMap,          &MaxJSPBR::emissionMapTransform,          StrengthSource::DedicatedField, L"emMapS",     true  }, // member is emissionMap (PB 'emissive'/'self_illumination')
    { SlotKind::Lightmap,       L"lmMap",       L"lmMapXf",       &MaxJSPBR::lightmapFile,         &MaxJSPBR::lightmapTransform,             StrengthSource::SharedScalar,   nullptr,       true  }, // lmI/lmCh; member is lightmapFile (not *Map)
    { SlotKind::Scalar,         L"opMap",       L"opMapXf",       &MaxJSPBR::opacityMap,           &MaxJSPBR::opacityMapTransform,           StrengthSource::DedicatedField, L"opMapS",     true  },
    { SlotKind::Scalar,         L"transMap",    L"transMapXf",    &MaxJSPBR::transmissionMap,      &MaxJSPBR::transmissionMapTransform,      StrengthSource::None,           nullptr,       true  },
    { SlotKind::Scalar,         L"ccMap",       L"ccMapXf",       &MaxJSPBR::clearcoatMap,         &MaxJSPBR::clearcoatMapTransform,         StrengthSource::None,           nullptr,       true  },
    { SlotKind::Scalar,         L"ccRoughMap",  L"ccRoughMapXf",  &MaxJSPBR::clearcoatRoughnessMap,&MaxJSPBR::clearcoatRoughnessMapTransform,StrengthSource::None,           nullptr,       true  },
    { SlotKind::Normal,         L"ccNormMap",   L"ccNormMapXf",   &MaxJSPBR::clearcoatNormalMap,   &MaxJSPBR::clearcoatNormalMapTransform,   StrengthSource::None,           nullptr,       true  },
}};

} // namespace maxjs

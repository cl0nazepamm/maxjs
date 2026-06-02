#pragma once

#include <max.h>
#include <stdmat.h>
#include <AssetManagement/AssetUser.h>
#include <IFileResolutionManager.h>
#include <Materials/TexHandle.h>
#include <RenderingAPI/Translator/BaseTranslators/BaseTranslator_Texmap.h>

#include "maxjs_core_utils.h"
#include "maxjs_geometry_sync.h"
#include "threejs_material.h"
#include "threejs_toon.h"
#include "threejs_gltf.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <map>
#include <sstream>
#include <string>
#include <unordered_set>
#include <vector>
// ══════════════════════════════════════════════════════════════
//  Texture Path Finder — walks any texmap tree for Bitmap files
// ══════════════════════════════════════════════════════════════

static bool IsImageFile(const wchar_t* path) {
    if (!path || !path[0]) return false;
    const wchar_t* ext = wcsrchr(path, L'.');
    if (!ext) return false;
    return (_wcsicmp(ext, L".png") == 0 || _wcsicmp(ext, L".jpg") == 0 ||
            _wcsicmp(ext, L".jpeg") == 0 || _wcsicmp(ext, L".tga") == 0 ||
            _wcsicmp(ext, L".tif") == 0 || _wcsicmp(ext, L".tiff") == 0 ||
            _wcsicmp(ext, L".bmp") == 0 || _wcsicmp(ext, L".exr") == 0 ||
            _wcsicmp(ext, L".hdr") == 0 || _wcsicmp(ext, L".dds") == 0 ||
            _wcsicmp(ext, L".psd") == 0 || _wcsicmp(ext, L".tx") == 0);
}

static bool IsAudioFile(const wchar_t* path) {
    if (!path || !path[0]) return false;
    const wchar_t* ext = wcsrchr(path, L'.');
    if (!ext) return false;
    return (_wcsicmp(ext, L".mp3") == 0 || _wcsicmp(ext, L".wav") == 0 ||
            _wcsicmp(ext, L".ogg") == 0 || _wcsicmp(ext, L".m4a") == 0 ||
            _wcsicmp(ext, L".aac") == 0 || _wcsicmp(ext, L".flac") == 0);
}

static std::wstring ResolveTextureFilePath(const std::wstring& rawPath,
                                           MaxSDK::AssetManagement::AssetType assetType = MaxSDK::AssetManagement::kBitmapAsset) {
    if (rawPath.empty() || !IsImageFile(rawPath.c_str())) return {};
    if (FileExists(rawPath)) return rawPath;

    IFileResolutionManager* resolver = IFileResolutionManager::GetInstance();
    if (resolver) {
        MSTR resolved = resolver->GetFullFilePath(rawPath.c_str(), assetType, true);
        if (resolved.Length() > 0) {
            std::wstring resolvedPath(resolved.data());
            if (IsImageFile(resolvedPath.c_str()) && FileExists(resolvedPath)) return resolvedPath;
        }
    }

    return {};
}

static std::wstring ResolveAudioFilePath(const std::wstring& rawPath) {
    if (rawPath.empty() || !IsAudioFile(rawPath.c_str())) return {};
    if (FileExists(rawPath)) return rawPath;

    IFileResolutionManager* resolver = IFileResolutionManager::GetInstance();
    if (resolver) {
        MSTR resolved = resolver->GetFullFilePath(rawPath.c_str(), MaxSDK::AssetManagement::kSoundAsset, true);
        if (resolved.Length() > 0) {
            std::wstring resolvedPath(resolved.data());
            if (IsAudioFile(resolvedPath.c_str()) && FileExists(resolvedPath)) return resolvedPath;
        }
    }

    return {};
}

static std::wstring ResolveTextureAssetPath(const MaxSDK::AssetManagement::AssetUser& asset) {
    IFileResolutionManager* resolver = IFileResolutionManager::GetInstance();
    if (resolver) {
        MSTR resolved;
        if (resolver->GetFullFilePath(asset, resolved, true) && resolved.Length() > 0) {
            std::wstring resolvedPath(resolved.data());
            if (IsImageFile(resolvedPath.c_str()) && FileExists(resolvedPath)) return resolvedPath;
        }
    }

    MSTR fullPath;
    if (asset.GetFullFilePath(fullPath) && fullPath.Length() > 0) {
        std::wstring resolvedPath(fullPath.data());
        if (IsImageFile(resolvedPath.c_str()) && FileExists(resolvedPath)) return resolvedPath;
    }

    const MSTR& filename = asset.GetFileName();
    if (filename.Length() > 0) {
        return ResolveTextureFilePath(filename.data(), asset.GetType());
    }

    return {};
}

// Standard BitmapTex keeps the path on the class + asset system, not always as TYPE_FILENAME in a param block.
static std::wstring GetStandardBitmapTexFilename(Texmap* map) {
    if (!map || map->ClassID() != Class_ID(BMTEX_CLASS_ID, 0)) return {};

    auto* bt = static_cast<BitmapTex*>(map);

    const MaxSDK::AssetManagement::AssetUser& au = bt->GetMap();
    std::wstring assetPath = ResolveTextureAssetPath(au);
    if (!assetPath.empty()) return assetPath;

    const MCHAR* mapName = bt->GetMapName();
    if (mapName && mapName[0]) {
        std::wstring resolved = ResolveTextureFilePath(mapName);
        if (!resolved.empty()) return resolved;
    }

    const MSTR& fn = au.GetFileName();
    if (fn.Length() > 0) {
        std::wstring resolved = ResolveTextureFilePath(fn.data(), au.GetType());
        if (!resolved.empty()) return resolved;
    }
    return {};
}

static std::wstring FindBitmapFileImpl(Texmap* map, std::unordered_set<Texmap*>& visited) {
    if (!map) return {};
    if (!visited.insert(map).second) return {};

    {
        std::wstring fromBm = GetStandardBitmapTexFilename(map);
        if (!fromBm.empty()) return fromBm;
    }

    // Check paramblocks for filename-type params — skip non-image files (.osl etc)
    for (int pb = 0; pb < map->NumParamBlocks(); pb++) {
        IParamBlock2* pblock = map->GetParamBlock(pb);
        if (!pblock) continue;
        for (int i = 0; i < pblock->NumParams(); i++) {
            ParamID pid = pblock->IndextoID(i);
            const ParamDef& pd = pblock->GetParamDef(pid);
            if (pd.type == TYPE_FILENAME || pd.type == TYPE_FILENAME_TAB) {
                const MCHAR* fn = pblock->GetStr(pid);
                if (fn && fn[0]) {
                    std::wstring resolved = ResolveTextureFilePath(fn);
                    if (!resolved.empty()) return resolved;
                }
            }
        }
    }

    // Recurse into sub-texmaps
    for (int i = 0; i < map->NumSubTexmaps(); i++) {
        Texmap* sub = map->GetSubTexmap(i);
        if (sub) {
            std::wstring f = FindBitmapFileImpl(sub, visited);
            if (!f.empty()) return f;
        }
    }
    return {};
}

static std::wstring FindBitmapFile(Texmap* map) {
    std::unordered_set<Texmap*> visited;
    return FindBitmapFileImpl(map, visited);
}

// WriteMaterialFull is a member function of MaxJSPanel

// ── Wire Color helper ──────────────────────────────────────────

static void GetWireColor3f(INode* node, float out[3]) {
    COLORREF wc = node->GetWireColor();
    out[0] = GetRValue(wc)/255.0f; out[1] = GetGValue(wc)/255.0f; out[2] = GetBValue(wc)/255.0f;
}

// ══════════════════════════════════════════════════════════════
//  Material PBR Extraction
//  Priority: ThreeJS Material (direct) > Shell viewport sub > wire color
// ══════════════════════════════════════════════════════════════

struct MaxJSPBR {
    struct TexTransform {
        bool  isUberBitmap = false;
        bool  hasChannelSelect = false;
        int   outputChannelIndex = 1;
        int   uvChannel = 1;
        bool  invert = false;
        float scale = 1.0f;
        float tiling[2] = {1.0f, 1.0f};
        float offset[2] = {0.0f, 0.0f};
        float rotate = 0.0f;
        float center[2] = {0.5f, 0.5f};
        bool  realWorld = false;
        float realWidth = 0.2f;
        float realHeight = 0.2f;
        std::wstring wrapMode = L"periodic";
        std::wstring colorSpace;   // "sRGB", "Linear", "auto", etc.
        float manualGamma = 1.0f;
        bool  isVideo = false;
        bool  videoLoop = true;
        bool  videoMuted = true;
        float videoRate = 1.0f;
        std::wstring tslCode;       // TSL procedural texture code (if non-empty, this is a TSL Texture)
        std::wstring tslParamsJson; // TSL texture dynamic params JSON
        std::wstring htmlFile;      // absolute disk path to the .html source file
        std::wstring htmlParamsJson;
        int   htmlWidth  = 1024;
        int   htmlHeight = 1024;
        bool  htmlOverrideMode = false;
        bool  htmlAutoFit = true;
    };

    float color[3]    = {0.8f, 0.8f, 0.8f};
    float roughness   = 0.5f;
    float metalness   = 0.0f;
    float emission[3] = {0, 0, 0};
    float emIntensity = 0.0f;
    float opacity     = 1.0f;
    float alphaTest   = 0.0f;
    float colorMapStrength = 1.0f;
    float roughnessMapStrength = 1.0f;
    float metalnessMapStrength = 1.0f;
    float normalScale = 1.0f;
    float bumpScale = 1.0f;
    float displacementScale = 0.0f;
    float displacementBias = 0.0f;
    float emissiveMapStrength = 1.0f;
    float opacityMapStrength = 1.0f;
    float aoIntensity = 1.0f;
    float lightmapIntensity = 1.0f;
    int   lightmapChannel = 2;
    bool  doubleSided = true;
    bool  transparent = false;
    bool  depthWrite = true;
    float envIntensity = 1.0f;
    float sssColor[3] = {1.0f, 1.0f, 1.0f};
    float sssDistortion = 0.1f;
    float sssAmbient = 0.0f;
    float sssAttenuation = 0.1f;
    float sssPower = 2.0f;
    float sssScale = 10.0f;
    float physicalSpecularColor[3] = {1.0f, 1.0f, 1.0f};
    float physicalSpecularIntensity = 1.0f;
    float clearcoat = 0.0f;
    float clearcoatRoughness = 0.0f;
    float sheen = 0.0f;
    float sheenRoughness = 1.0f;
    float sheenColor[3] = {0.0f, 0.0f, 0.0f};
    float iridescence = 0.0f;
    float iridescenceIOR = 1.3f;
    float transmission = 0.0f;
    float ior = 1.5f;
    float thickness = 0.0f;
    float dispersion = 0.0f;
    float attenuationColor[3] = {1.0f, 1.0f, 1.0f};
    float attenuationDistance = 0.0f;
    float anisotropy = 0.0f;
    float specular[3] = {0.0666667f, 0.0666667f, 0.0666667f};
    float shininess = 30.0f;
    float reflectivity = 0.5f;
    float refractionRatio = 0.98f;
    bool  flatShading = false;
    bool  wireframe = false;
    bool  fog = true;
    int   backdropMode = 0;
    int   normalMapType = 0;
    int   depthPacking = 0;
    int   combine = 0;
    std::wstring colorMap, gradientMap, roughnessMap, metalnessMap, normalMap;
    std::wstring bumpMap, displacementMap, parallaxMap, sssColorMap, matcapMap, specularMap;
    std::wstring aoMap, emissionMap, lightmapFile, opacityMap;
    std::wstring transmissionMap;
    std::wstring clearcoatMap, clearcoatRoughnessMap, clearcoatNormalMap;
    std::wstring specularIntensityMap, specularColorMap;
    TexTransform colorMapTransform, gradientMapTransform, roughnessMapTransform, metalnessMapTransform, normalMapTransform;
    TexTransform bumpMapTransform, displacementMapTransform, parallaxMapTransform, sssColorMapTransform;
    TexTransform aoMapTransform, emissionMapTransform, lightmapTransform, opacityMapTransform, matcapMapTransform, specularMapTransform;
    TexTransform transmissionMapTransform;
    TexTransform clearcoatMapTransform, clearcoatRoughnessMapTransform, clearcoatNormalMapTransform;
    TexTransform specularIntensityMapTransform, specularColorMapTransform;
    std::wstring mtlName;
    std::wstring tslCode;
    std::wstring tslMaps[16];
    std::wstring tslParamsJson;
    std::wstring materialModel = L"MeshStandardMaterial";
    std::wstring materialXFile;
    std::wstring materialXInline;  // MaterialX XML string (from MtlxIOUtil.ExportMtlxString)
    std::wstring materialXBase;
    std::wstring materialXMaterialName;
    int materialXMaterialIndex = 1;
    bool materialXBridgeConnected = false;
    std::wstring materialXBridgeSourceName;
    std::wstring materialXBridgeError;
    float parallaxScale = 0.0f;
};

static float FindPBFloat(Texmap* map, const MCHAR* name, float def);
static int FindPBInt(Texmap* map, const MCHAR* name, int def);
static std::wstring FindPBString(Texmap* map, const MCHAR* name);
static std::wstring FindPBString(Mtl* mtl, const MCHAR* name);
static int FindPBInt(Mtl* mtl, const MCHAR* name, int def);
static void ExtractMaterialXMtl(Mtl* mtl, TimeValue t, MaxJSPBR& d);

// Shell Material Class_ID = (597, 0)
#define SHELL_MTL_CLASS_ID Class_ID(597, 0)
// glTF Material Class_ID = (943849874, 1174294043)
#define GLTF_MTL_CLASS_ID Class_ID(943849874, 1174294043)
// USD Preview Surface Class_ID = (1794787635, 1200091591)
#define USD_PREVIEW_SURFACE_CLASS_ID Class_ID(1794787635, 1200091591)
// Normal Bump texmap Class_ID = {243e22c6, 63f6a014}
#define NORMAL_BUMP_CLASS_ID Class_ID(0x243e22c6, 0x63f6a014)
// OpenPBR Material Class_ID
#define OPENPBR_MTL_CLASS_ID Class_ID(4048887347u, 939201335)
// VRayMtl Class_ID
#define VRAYMTL_CLASS_ID Class_ID(935280431, 1882483036)
// VRayBitmap Class_ID
#define VRAYBITMAP_CLASS_ID Class_ID(1734939723, 46203261)
// VRayNormalMap Class_ID
#define VRAYNORMALMAP_CLASS_ID Class_ID(1912237649, 1912962095)
// MaterialX Material Class_ID variants observed in Max runtime
#define MATERIALX_MTL_CLASS_ID Class_ID(0x37161b0b, 0x51c741cc)
#define MATERIALX_MTL_ALT_CLASS_ID Class_ID(0x20fb46dc, 0x30fd79bf)

static bool HasParam(IParamBlock2* pb, ParamID id) {
    if (!pb) return false;
    for (int i = 0; i < pb->NumParams(); ++i) {
        if (pb->IndextoID(i) == id) return true;
    }
    return false;
}

static bool IsThreeJSMaterialClass(const Class_ID& cid) {
    return cid == THREEJS_ADV_MTL_CLASS_ID ||
           cid == THREEJS_UTILITY_MTL_CLASS_ID ||
           cid == THREEJS_TSL_CLASS_ID;
}

static bool IsMaterialXMaterialClass(const Class_ID& cid) {
    return cid == MATERIALX_MTL_CLASS_ID || cid == MATERIALX_MTL_ALT_CLASS_ID;
}

static bool IsVRayBitmapTexmap(Texmap* map) {
    if (!map) return false;
    return map->ClassID() == VRAYBITMAP_CLASS_ID;
}

static bool IsVRayNormalMapTexmap(Texmap* map) {
    if (!map) return false;
    return map->ClassID() == VRAYNORMALMAP_CLASS_ID;
}

static std::wstring GetUtilityMaterialModelName(int utilityModel) {
    switch (utilityModel) {
        case threejs_utility_depth: return L"MeshDepthMaterial";
        case threejs_utility_matcap: return L"MeshMatcapMaterial";
        case threejs_utility_normal: return L"MeshNormalMaterial";
        case threejs_utility_phong: return L"MeshPhongMaterial";
        case threejs_utility_backdrop: return L"MeshBackdropNodeMaterial";
        case threejs_utility_lambert:
        default:
            return L"MeshLambertMaterial";
    }
}

static bool IsUtilityMaterialModel(const std::wstring& materialModel) {
    return
           materialModel == L"MeshDepthMaterial" ||
           materialModel == L"MeshLambertMaterial" ||
           materialModel == L"MeshMatcapMaterial" ||
           materialModel == L"MeshNormalMaterial" ||
           materialModel == L"MeshPhongMaterial" ||
           materialModel == L"MeshBackdropNodeMaterial";
}

static StdMat* AsLegacyStandardMaterial(Mtl* mtl) {
    return mtl ? dynamic_cast<StdMat*>(mtl) : nullptr;
}

static bool IsLegacyStandardMaterial(Mtl* mtl) {
    return AsLegacyStandardMaterial(mtl) != nullptr;
}

#define PHYSICAL_MTL_CLASS_ID Class_ID(1030429932, 3735928833)

static bool IsSupportedMaterial(Mtl* mtl) {
    if (!mtl) return false;
    Class_ID cid = mtl->ClassID();
    return IsThreeJSMaterialClass(cid) || cid == THREEJS_TOON_CLASS_ID || cid == GLTF_MTL_CLASS_ID
        || cid == USD_PREVIEW_SURFACE_CLASS_ID || cid == PHYSICAL_MTL_CLASS_ID
        || cid == VRAYMTL_CLASS_ID
        || cid == OPENPBR_MTL_CLASS_ID
        || IsMaterialXMaterialClass(cid)
        || IsLegacyStandardMaterial(mtl);
}

// Find ThreeJS or glTF Material in material tree — uses ClassID only
static Mtl* FindSupportedMaterial(Mtl* mtl) {
    if (!mtl) return nullptr;

    Class_ID cid = mtl->ClassID();

    // Direct match
    if (IsSupportedMaterial(mtl)) return mtl;

    // Shell Material — check both subs
    if (cid == SHELL_MTL_CLASS_ID && mtl->NumSubMtls() >= 2) {
        for (int i = 0; i < mtl->NumSubMtls(); i++) {
            Mtl* sub = mtl->GetSubMtl(i);
            if (IsSupportedMaterial(sub)) return sub;
        }
    }

    // Multi/Sub
    if (mtl->NumSubMtls() > 0 && cid != SHELL_MTL_CLASS_ID) {
        for (int i = 0; i < mtl->NumSubMtls(); i++) {
            Mtl* found = FindSupportedMaterial(mtl->GetSubMtl(i));
            if (found) return found;
        }
    }

    return nullptr;
}

// Keep old name working for transform sync
static Mtl* FindThreeJSMaterial(Mtl* mtl) { return FindSupportedMaterial(mtl); }

static bool ReferenceTreeContainsImpl(ReferenceTarget* root, ReferenceTarget* needle, std::unordered_set<ReferenceTarget*>& visited) {
    if (!root || !needle) return false;
    if (root == needle) return true;
    if (!visited.insert(root).second) return false;

    ReferenceMaker* maker = dynamic_cast<ReferenceMaker*>(root);
    if (!maker) return false;

    const int numRefs = maker->NumRefs();
    for (int i = 0; i < numRefs; ++i) {
        RefTargetHandle ref = maker->GetReference(i);
        ReferenceTarget* child = dynamic_cast<ReferenceTarget*>(ref);
        if (child && ReferenceTreeContainsImpl(child, needle, visited)) {
            return true;
        }
    }
    return false;
}

static bool ReferenceTreeContains(ReferenceTarget* root, ReferenceTarget* needle) {
    std::unordered_set<ReferenceTarget*> visited;
    return ReferenceTreeContainsImpl(root, needle, visited);
}

static bool FindPBPoint3(Texmap* map, const MCHAR* name, Point3& out) {
    if (!map) return false;
    for (int b = 0; b < map->NumParamBlocks(); b++) {
        IParamBlock2* pb = map->GetParamBlock(b);
        if (!pb) continue;
        for (int i = 0; i < pb->NumParams(); i++) {
            ParamID pid = pb->IndextoID(i);
            const ParamDef& pd = pb->GetParamDef(pid);
            if (pd.int_name && _tcsicmp(pd.int_name, name) == 0 && pd.type == TYPE_POINT3) {
                out = pb->GetPoint3(pid);
                return true;
            }
        }
    }
    return false;
}

static Texmap* FindPBMap(Texmap* map, const MCHAR* name) {
    if (!map) return nullptr;
    for (int b = 0; b < map->NumParamBlocks(); b++) {
        IParamBlock2* pb = map->GetParamBlock(b);
        if (!pb) continue;
        for (int i = 0; i < pb->NumParams(); i++) {
            ParamID pid = pb->IndextoID(i);
            const ParamDef& pd = pb->GetParamDef(pid);
            if (pd.int_name && _tcsicmp(pd.int_name, name) == 0 && pd.type == TYPE_TEXMAP)
                return pb->GetTexmap(pid);
        }
    }
    return nullptr;
}

static bool PBNameEquals(const MCHAR* lhs, const MCHAR* rhs) {
    return lhs && rhs && _tcsicmp(lhs, rhs) == 0;
}

static Texmap* FindPBMapByNames(Texmap* map, const MCHAR* const* names, size_t nameCount) {
    if (!map || !names || nameCount == 0) return nullptr;
    for (size_t n = 0; n < nameCount; ++n) {
        if (Texmap* found = FindPBMap(map, names[n]))
            return found;
    }
    return nullptr;
}

static int FindPBIntByNames(Texmap* map, const MCHAR* const* names, size_t nameCount, int def) {
    if (!map || !names || nameCount == 0) return def;
    for (int b = 0; b < map->NumParamBlocks(); b++) {
        IParamBlock2* pb = map->GetParamBlock(b);
        if (!pb) continue;
        for (int i = 0; i < pb->NumParams(); i++) {
            ParamID pid = pb->IndextoID(i);
            const ParamDef& pd = pb->GetParamDef(pid);
            if (!pd.int_name || (pd.type != TYPE_INT && pd.type != TYPE_BOOL)) continue;
            for (size_t n = 0; n < nameCount; ++n) {
                if (PBNameEquals(pd.int_name, names[n]))
                    return pb->GetInt(pid);
            }
        }
    }
    return def;
}

static std::wstring FindPBImagePathByNames(Texmap* map,
                                           const MCHAR* const* names,
                                           size_t nameCount) {
    if (!map || !names || nameCount == 0) return {};
    for (int b = 0; b < map->NumParamBlocks(); b++) {
        IParamBlock2* pb = map->GetParamBlock(b);
        if (!pb) continue;
        for (int i = 0; i < pb->NumParams(); i++) {
            ParamID pid = pb->IndextoID(i);
            const ParamDef& pd = pb->GetParamDef(pid);
            if (!pd.int_name || (pd.type != TYPE_STRING && pd.type != TYPE_FILENAME)) continue;
            bool nameMatches = false;
            for (size_t n = 0; n < nameCount; ++n) {
                if (PBNameEquals(pd.int_name, names[n])) {
                    nameMatches = true;
                    break;
                }
            }
            if (!nameMatches) continue;

            const MCHAR* raw = pb->GetStr(pid);
            if (!raw || !raw[0]) continue;
            return raw;
        }
    }
    return {};
}

static std::wstring FindVRayBitmapFilename(Texmap* map) {
    if (!map) return {};

    static const MCHAR* const kVRayBitmapFilenameParams[] = {
        _T("HDRIMapName"),
        _T("HDRI"),
        _T("filename"),
        _T("fileName"),
        _T("file"),
        _T("bitmap"),
        _T("mapName"),
        _T("BitmapBuffer")
    };

    std::wstring raw = FindPBImagePathByNames(
            map,
            kVRayBitmapFilenameParams,
            sizeof(kVRayBitmapFilenameParams) / sizeof(kVRayBitmapFilenameParams[0]));
    if (!raw.empty()) {
        std::wstring resolved = ResolveTextureFilePath(raw);
        if (!resolved.empty()) return resolved;
        if (IsImageFile(raw.c_str()))
            return raw;
    }

    std::wstring resolved = FindBitmapFile(map);
    if (!resolved.empty())
        return resolved;

    return {};
}

static bool IsAutodeskUberBitmap(Texmap* map) {
    if (!map) return false;

    const std::wstring shaderName = FindPBString(map, _T("OSLShaderName"));
    if (_wcsicmp(shaderName.c_str(), L"UberBitmap2b") == 0)
        return true;

    const std::wstring oslPath = FindPBString(map, _T("OSLpath"));
    const wchar_t* fileName = oslPath.empty() ? nullptr : wcsrchr(oslPath.c_str(), L'\\');
    fileName = fileName ? fileName + 1 : oslPath.c_str();
    return fileName && _wcsicmp(fileName, L"UberBitmap2.osl") == 0;
}

static void ExtractUberBitmapTransform(Texmap* map, MaxJSPBR::TexTransform& xf, int outputChannelIndex) {
    if (!map) return;

    Point3 tiling(1.0f, 1.0f, 1.0f);
    Point3 offset(0.0f, 0.0f, 0.0f);
    Point3 center(0.5f, 0.5f, 0.0f);
    FindPBPoint3(map, _T("tiling"), tiling);
    FindPBPoint3(map, _T("offset"), offset);
    FindPBPoint3(map, _T("RotCenter"), center);

    xf.isUberBitmap = true;
    xf.hasChannelSelect = outputChannelIndex != 1;
    xf.outputChannelIndex = outputChannelIndex;
    xf.scale = FindPBFloat(map, _T("scale"), 1.0f);
    xf.tiling[0] = tiling.x;
    xf.tiling[1] = tiling.y;
    xf.offset[0] = offset.x;
    xf.offset[1] = offset.y;
    xf.rotate = FindPBFloat(map, _T("Rotate"), 0.0f);
    xf.center[0] = center.x;
    xf.center[1] = center.y;
    xf.realWorld = FindPBInt(map, _T("RealWorld"), 0) != 0;
    xf.realWidth = FindPBFloat(map, _T("RealWidth"), 0.2f);
    xf.realHeight = FindPBFloat(map, _T("RealHeight"), 0.2f);
    xf.wrapMode = FindPBString(map, _T("WrapMode"));
    if (xf.wrapMode.empty()) xf.wrapMode = L"periodic";
    xf.colorSpace = FindPBString(map, _T("Filename_ColorSpace"));
    xf.manualGamma = FindPBFloat(map, _T("ManualGamma"), 1.0f);
}

static bool TexTransformHasUvData(const MaxJSPBR::TexTransform& xf) {
    return xf.uvChannel != 1 ||
           std::fabs(xf.scale - 1.0f) > 1.0e-6f ||
           std::fabs(xf.tiling[0] - 1.0f) > 1.0e-6f ||
           std::fabs(xf.tiling[1] - 1.0f) > 1.0e-6f ||
           std::fabs(xf.offset[0]) > 1.0e-6f ||
           std::fabs(xf.offset[1]) > 1.0e-6f ||
           std::fabs(xf.rotate) > 1.0e-6f ||
           std::fabs(xf.center[0] - 0.5f) > 1.0e-6f ||
           std::fabs(xf.center[1] - 0.5f) > 1.0e-6f ||
           xf.realWorld ||
           (!xf.wrapMode.empty() && xf.wrapMode != L"periodic");
}

static void CopyUvTransform(MaxJSPBR::TexTransform& dst, const MaxJSPBR::TexTransform& src) {
    dst.scale = src.scale;
    dst.tiling[0] = src.tiling[0];
    dst.tiling[1] = src.tiling[1];
    dst.offset[0] = src.offset[0];
    dst.offset[1] = src.offset[1];
    dst.rotate = src.rotate;
    dst.center[0] = src.center[0];
    dst.center[1] = src.center[1];
    dst.realWorld = src.realWorld;
    dst.realWidth = src.realWidth;
    dst.realHeight = src.realHeight;
    dst.wrapMode = src.wrapMode;
    dst.uvChannel = src.uvChannel;
}

static StdUVGen* GetStdUVGenForTexmap(Texmap* map) {
    if (!map) return nullptr;

    // Standard BitmapTex exposes its UV generator on BitmapTex::GetUVGen().
    // Some BitmapTex instances do not return it through Texmap::GetTheUVGen().
    if (map->ClassID() == Class_ID(BMTEX_CLASS_ID, 0)) {
        auto* bitmapTex = static_cast<BitmapTex*>(map);
        if (StdUVGen* uv = bitmapTex->GetUVGen())
            return uv;
    }

    UVGen* uvGen = map->GetTheUVGen();
    if (uvGen && uvGen->IsStdUVGen())
        return static_cast<StdUVGen*>(uvGen);

    return nullptr;
}

static bool ExtractStdUVTransform(Texmap* map, MaxJSPBR::TexTransform& xf) {
    StdUVGen* stdUv = GetStdUVGenForTexmap(map);
    if (!stdUv) return false;

    const TimeValue t = GetCOREInterface() ? GetCOREInterface()->GetTime() : 0;
    const bool useRealWorldScale = stdUv->GetUseRealWorldScale() != FALSE;
    const float uScale = stdUv->GetUScl(t);
    const float vScale = stdUv->GetVScl(t);
    if (useRealWorldScale) {
        xf.realWorld = true;
        xf.realWidth = std::fabs(uScale) > 1.0e-6f ? std::fabs(uScale) : 1.0f;
        xf.realHeight = std::fabs(vScale) > 1.0e-6f ? std::fabs(vScale) : 1.0f;
        xf.tiling[0] = 1.0f;
        xf.tiling[1] = 1.0f;
    } else {
        xf.tiling[0] = uScale;
        xf.tiling[1] = vScale;
    }
    xf.offset[0] = stdUv->GetUOffs(t);
    xf.offset[1] = stdUv->GetVOffs(t);
    xf.rotate = stdUv->GetWAng(t) * (180.0f / PI);
    xf.uvChannel = std::max(1, stdUv->GetMapChannel());

    const int tilingFlags = stdUv->GetTextureTiling();
    if ((tilingFlags & (U_MIRROR | V_MIRROR)) != 0) {
        xf.wrapMode = L"mirror";
    } else if ((tilingFlags & (U_WRAP | V_WRAP)) != (U_WRAP | V_WRAP)) {
        xf.wrapMode = L"clamp";
    }
    return true;
}

// ── Procedural Map Baking ──────────────────────────────────
// TODO(maxjs): Revisit generic 3ds Max procedural texmap baking after release.
// The current experimental fallback is intentionally disabled at the call site in
// ExtractMaterialTexture(). Direct file textures, TSL textures, and known bridge
// paths remain supported; arbitrary procedural maps should not silently bake until
// the viewport-DIB/BakeTexmap path is validated against real scenes.
// Cache: Texmap pointer + time → baked PNG path.  Re-bakes only when the combo is new.
static std::unordered_map<unsigned long long, std::wstring> bakedMapCache_;
static constexpr int BAKE_SIZE = 512;

class OfflineTexHandleMaker final : public TexHandleMaker {
public:
    explicit OfflineTexHandleMaker(int size) : size_(size) {}

    TexHandle* CreateHandle(Bitmap* bm, int symflags = 0, int extraFlags = 0) override {
        UNUSED_PARAM(bm);
        UNUSED_PARAM(symflags);
        UNUSED_PARAM(extraFlags);
        return nullptr;
    }

    TexHandle* CreateHandle(BITMAPINFO* bminf, int symflags = 0, int extraFlags = 0) override {
        UNUSED_PARAM(bminf);
        UNUSED_PARAM(symflags);
        UNUSED_PARAM(extraFlags);
        return nullptr;
    }

    BITMAPINFO* BitmapToDIB(Bitmap* bm, int symflags, int extraFlags, BOOL forceW = 0, BOOL forceH = 0) override {
        UNUSED_PARAM(bm);
        UNUSED_PARAM(symflags);
        UNUSED_PARAM(extraFlags);
        UNUSED_PARAM(forceW);
        UNUSED_PARAM(forceH);
        return nullptr;
    }

    TexHandle* MakeHandle(BITMAPINFO* bminf) override {
        if (bminf) {
            LocalFree(bminf);
        }
        return nullptr;
    }

    BOOL UseClosestPowerOf2() override { return TRUE; }
    int Size() override { return size_; }

private:
    int size_;
};

static bool SaveBitmapToPng(Bitmap* bm, const std::wstring& filename, int width, int height) {
    if (!bm) return false;

    BitmapInfo outBi;
    outBi.SetName(filename.c_str());
    outBi.SetWidth(width);
    outBi.SetHeight(height);
    outBi.SetType(BMM_TRUE_32);
    outBi.SetFlags(MAP_HAS_ALPHA);

    BMMRES writeResult = bm->OpenOutput(&outBi);
    if (writeResult != BMMRES_SUCCESS) {
        return false;
    }

    bm->Write(&outBi);
    bm->Close(&outBi);
    return true;
}

static bool SaveViewportDibAsPng(BITMAPINFO* dib, const std::wstring& filename) {
    if (!dib) return false;
    if (dib->bmiHeader.biBitCount != 32 || dib->bmiHeader.biWidth <= 0 || dib->bmiHeader.biHeight == 0) {
        return false;
    }

    const int width = dib->bmiHeader.biWidth;
    const int height = std::abs(dib->bmiHeader.biHeight);
    const bool bottomUp = dib->bmiHeader.biHeight > 0;
    const int stride = ((width * dib->bmiHeader.biBitCount + 31) / 32) * 4;
    const BYTE* pixelData = reinterpret_cast<const BYTE*>(dib) + dib->bmiHeader.biSize;

    BitmapInfo bi;
    bi.SetWidth(width);
    bi.SetHeight(height);
    bi.SetType(BMM_TRUE_32);
    bi.SetFlags(MAP_HAS_ALPHA);

    Bitmap* bm = TheManager->Create(&bi);
    if (!bm) return false;

    std::vector<BMM_Color_fl> row(static_cast<size_t>(width));
    for (int y = 0; y < height; ++y) {
        const int srcY = bottomUp ? (height - 1 - y) : y;
        const BYTE* src = pixelData + static_cast<size_t>(srcY) * static_cast<size_t>(stride);
        for (int x = 0; x < width; ++x) {
            const BYTE* px = src + static_cast<size_t>(x) * 4;
            row[static_cast<size_t>(x)].r = static_cast<float>(px[2]) / 255.0f;
            row[static_cast<size_t>(x)].g = static_cast<float>(px[1]) / 255.0f;
            row[static_cast<size_t>(x)].b = static_cast<float>(px[0]) / 255.0f;
            row[static_cast<size_t>(x)].a = static_cast<float>(px[3]) / 255.0f;
        }
        bm->PutPixels(0, y, width, row.data());
    }

    const bool ok = SaveBitmapToPng(bm, filename, width, height);
    bm->DeleteThis();
    return ok;
}

static bool SaveBakedPixelsAsPng(const std::vector<BMM_Color_fl>& bakedPixels, int width, int height, const std::wstring& filename) {
    BitmapInfo bi;
    bi.SetWidth(width);
    bi.SetHeight(height);
    bi.SetType(BMM_TRUE_32);
    bi.SetFlags(MAP_HAS_ALPHA);

    Bitmap* bm = TheManager->Create(&bi);
    if (!bm) return false;

    for (int y = 0; y < height; ++y) {
        BMM_Color_fl* row = const_cast<BMM_Color_fl*>(bakedPixels.data()) + static_cast<size_t>(y) * static_cast<size_t>(width);
        bm->PutPixels(0, y, width, row);
    }

    const bool ok = SaveBitmapToPng(bm, filename, width, height);
    bm->DeleteThis();
    return ok;
}

static std::wstring BakeProceduralMap(Texmap* map, TimeValue t) {
    if (!map) return {};

    // Cache key: texmap address + time. Animated procedural maps need different bakes per frame.
    const unsigned long long key =
        (static_cast<unsigned long long>(reinterpret_cast<uintptr_t>(map)) << 16) ^
        static_cast<unsigned int>(t);
    auto it = bakedMapCache_.find(key);
    if (it != bakedMapCache_.end()) {
        return it->second;
    }

    wchar_t tempDir[MAX_PATH];
    GetTempPathW(MAX_PATH, tempDir);
    std::wstring dir = std::wstring(tempDir) + L"maxjs_baked\\";
    CreateDirectoryW(dir.c_str(), nullptr);
    std::wstring filename = dir + L"proc_" + std::to_wstring(key) + L".png";

    // Prefer the viewport-display DIB path for unknown procedural maps.
    // This is the same path many Autodesk procedural maps implement for Nitrous/viewport preview.
    OfflineTexHandleMaker thmaker(BAKE_SIZE);
    Interval vpValid = FOREVER;
    BITMAPINFO* dib = map->GetVPDisplayDIB(t, thmaker, vpValid, FALSE, BAKE_SIZE, BAKE_SIZE);
    if (dib) {
        const bool ok = SaveViewportDibAsPng(dib, filename);
        LocalFree(dib);
        if (ok) {
            bakedMapCache_[key] = filename;
            return filename;
        }
    }

    Interval validity = FOREVER;
    IPoint2 bakedRes(0, 0);
    std::vector<BMM_Color_fl> bakedPixels;
    if (!MaxSDK::RenderingAPI::BaseTranslator_Texmap::BakeTexmap(
            *map,
            t,
            validity,
            IPoint2(BAKE_SIZE, BAKE_SIZE),
            bakedRes,
            bakedPixels)) {
        return {};
    }

    if (bakedRes.x <= 0 || bakedRes.y <= 0) return {};
    const size_t pixelCount = static_cast<size_t>(bakedRes.x) * static_cast<size_t>(bakedRes.y);
    if (bakedPixels.size() < pixelCount) return {};

    if (SaveBakedPixelsAsPng(bakedPixels, bakedRes.x, bakedRes.y, filename)) {
        bakedMapCache_[key] = filename;
        return filename;
    }

    return {};
}

static void ClearBakedMapCache() {
    bakedMapCache_.clear();
}

static bool ExtractMaterialTexture(Texmap* map, std::wstring& filePath, MaxJSPBR::TexTransform& xf) {
    if (!map) return false;

    Texmap* resolved = map;
    const int outputChannelIndex = std::max(1, FindPBInt(map, _T("outputChannelIndex"), 1));
    if (Texmap* sourceMap = FindPBMap(map, _T("sourceMap")))
        resolved = sourceMap;

    /*
    TODO(maxjs): Potential Color Correction pass-through.
    The live Color Correction sample is:
      Color Correction -> Map Output Selector -> OSL: Uber Bitmap.
    A simple unwrap keeps the bitmap visible, but the Color Correction class and
    its map slot behavior may change across Max versions, so leave this disabled
    until we support it deliberately instead of silently bypassing correction math.
    */

    // TSL Texture — procedural texmap with TSL code
    if (resolved->ClassID() == THREEJS_TSL_TEX_CLASS_ID) {
        for (int b = 0; b < resolved->NumParamBlocks(); b++) {
            IParamBlock2* pb = resolved->GetParamBlock(b);
            if (!pb) continue;
            if (HasParam(pb, ptsl_tex_code)) {
                const MCHAR* code = pb->GetStr(ptsl_tex_code);
                if (code && code[0]) {
                    filePath = L"tsl://procedural";
                    xf = {};
                    xf.tslCode = code;
                    if (HasParam(pb, ptsl_tex_params_json)) {
                        const MCHAR* pj = pb->GetStr(ptsl_tex_params_json);
                        if (pj && pj[0]) xf.tslParamsJson = pj;
                    }
                    return true;
                }
            }
        }
        return false;
    }

    // HTML Texture — live HTML file rasterized on the web side
    if (resolved->ClassID() == THREEJS_HTML_TEX_CLASS_ID) {
        IParamBlock2* pb = resolved->GetParamBlockByID(threejs_html_tex_params);
        if (!pb) return false;
        const MCHAR* fn = pb->GetStr(phtml_tex_file);
        if (!fn || !fn[0]) return false;
        filePath = L"html://managed";
        xf = {};
        xf.htmlFile = fn;
        if (resolved != map && IsAutodeskUberBitmap(map)) {
            ExtractUberBitmapTransform(map, xf, outputChannelIndex);
        } else {
            const bool gotOuterTransform = ExtractStdUVTransform(map, xf) && TexTransformHasUvData(xf);
            if (!gotOuterTransform && resolved != map)
                ExtractStdUVTransform(resolved, xf);
        }
        xf.htmlWidth  = pb->GetInt(phtml_tex_width,  0);
        xf.htmlHeight = pb->GetInt(phtml_tex_height, 0);
        if (xf.htmlWidth  <= 0) xf.htmlWidth  = 1024;
        if (xf.htmlHeight <= 0) xf.htmlHeight = 1024;
        if (xf.htmlWidth  > 4096) xf.htmlWidth  = 4096;
        if (xf.htmlHeight > 4096) xf.htmlHeight = 4096;
        const MCHAR* pj = pb->GetStr(phtml_tex_params_json);
        if (pj && pj[0]) xf.htmlParamsJson = pj;
        if (HasParam(pb, phtml_tex_override)) {
            xf.htmlOverrideMode = pb->GetInt(phtml_tex_override, 0) != 0;
        }
        if (HasParam(pb, phtml_tex_auto_fit)) {
            xf.htmlAutoFit = pb->GetInt(phtml_tex_auto_fit, 0) != 0;
        }
        return true;
    }

    if (IsAutodeskUberBitmap(resolved)) {
        const std::wstring filename = FindPBString(resolved, _T("filename"));
        if (filename.empty() || !IsImageFile(filename.c_str()))
            return false;

        filePath = filename;
        xf = {};
        ExtractUberBitmapTransform(resolved, xf, outputChannelIndex);
        return true;
    }

    if (resolved->ClassID() == Class_ID(BMTEX_CLASS_ID, 0)) {
        const std::wstring filename = FindBitmapFile(resolved);
        if (filename.empty() || !IsImageFile(filename.c_str()))
            return false;
        filePath = filename;
        xf = {};
        ExtractStdUVTransform(resolved, xf);
        if (resolved != map) {
            if (IsAutodeskUberBitmap(map)) {
                ExtractUberBitmapTransform(map, xf, outputChannelIndex);
            } else {
                MaxJSPBR::TexTransform outerXf;
                if (ExtractStdUVTransform(map, outerXf) && TexTransformHasUvData(outerXf))
                    CopyUvTransform(xf, outerXf);
            }
        }
        xf.hasChannelSelect = outputChannelIndex != 1;
        xf.outputChannelIndex = outputChannelIndex;
        return true;
    }

    // VRayNormalMap — walk through to the inner normal map texture
    if (IsVRayNormalMapTexmap(resolved)) {
        static const MCHAR* const kNormalMapParams[] = {
            _T("normal_map"),
            _T("normalMap"),
            _T("normal_texmap"),
            _T("texmap_normal"),
            _T("normal")
        };
        static const MCHAR* const kBumpMapParams[] = {
            _T("bump_map"),
            _T("bumpMap"),
            _T("bump_texmap"),
            _T("texmap_bump"),
            _T("bump")
        };

        const int wrapperMapChannel = std::max(1, FindPBInt(resolved, _T("map_channel"), 1));
        const bool normalEnabled = FindPBInt(resolved, _T("normal_map_on"), 1) != 0;
        const bool bumpEnabled = FindPBInt(resolved, _T("bump_map_on"), 1) != 0;
        Texmap* innerNormal = FindPBMapByNames(
            resolved,
            kNormalMapParams,
            sizeof(kNormalMapParams) / sizeof(kNormalMapParams[0]));
        if (normalEnabled && innerNormal) {
            if (ExtractMaterialTexture(innerNormal, filePath, xf)) {
                if (xf.uvChannel == 1) xf.uvChannel = wrapperMapChannel;
                return true;
            }
        }
        Texmap* innerBump = FindPBMapByNames(
            resolved,
            kBumpMapParams,
            sizeof(kBumpMapParams) / sizeof(kBumpMapParams[0]));
        if (bumpEnabled && innerBump) {
            if (ExtractMaterialTexture(innerBump, filePath, xf)) {
                if (xf.uvChannel == 1) xf.uvChannel = wrapperMapChannel;
                return true;
            }
        }
        for (int i = 0; i < resolved->NumSubTexmaps(); ++i) {
            if ((i == 0 && !normalEnabled) || (i == 1 && !bumpEnabled)) continue;
            Texmap* sub = resolved->GetSubTexmap(i);
            if (sub && ExtractMaterialTexture(sub, filePath, xf)) {
                if (xf.uvChannel == 1) xf.uvChannel = wrapperMapChannel;
                return true;
            }
        }
        return false;
    }

    // VRayBitmap (VRayHDRI)
    if (IsVRayBitmapTexmap(resolved)) {
        const std::wstring filename = FindVRayBitmapFilename(resolved);
        if (filename.empty() || !IsImageFile(filename.c_str()))
            return false;
        filePath = filename;
        xf = {};
        ExtractStdUVTransform(resolved, xf);
        if (resolved != map) {
            if (IsAutodeskUberBitmap(map)) {
                ExtractUberBitmapTransform(map, xf, outputChannelIndex);
            } else {
                MaxJSPBR::TexTransform outerXf;
                if (ExtractStdUVTransform(map, outerXf) && TexTransformHasUvData(outerXf))
                    CopyUvTransform(xf, outerXf);
            }
        }
        xf.hasChannelSelect = outputChannelIndex != 1;
        xf.outputChannelIndex = outputChannelIndex;
        xf.colorSpace = FindPBString(resolved, _T("color_space"));
        if (xf.colorSpace.empty())
            xf.colorSpace = FindPBString(resolved, _T("rgbColorSpace"));
        xf.manualGamma = FindPBFloat(resolved, _T("gamma"), 1.0f);
        xf.uvChannel = std::max(1, FindPBInt(resolved, _T("mapChannel"), xf.uvChannel));
        return true;
    }

    // three.js Video Texture
    if (resolved->ClassID() == THREEJS_VIDEO_TEX_CLASS_ID) {
        IParamBlock2* vpb = resolved->GetParamBlockByID(threejs_video_params);
        if (!vpb) return false;
        const MCHAR* fn = vpb->GetStr(pvid_filename);
        if (!fn || !fn[0]) return false;
        filePath = fn;
        xf = {};
        const bool gotOuterTransform = ExtractStdUVTransform(map, xf) && TexTransformHasUvData(xf);
        if (!gotOuterTransform && resolved != map)
            ExtractStdUVTransform(resolved, xf);
        xf.isVideo = true;
        xf.videoLoop = vpb->GetInt(pvid_loop, 0) != 0;
        xf.videoMuted = vpb->GetInt(pvid_muted, 0) != 0;
        xf.videoRate = vpb->GetFloat(pvid_rate, 0);
        return true;
    }

    // TODO(maxjs): Re-enable procedural texmap baking after the generic fallback
    // is proven reliable. For release, do not silently convert arbitrary 3ds Max
    // maps into baked PNGs here.
    // {
    //     std::wstring bakedPath = BakeProceduralMap(resolved, GetCOREInterface()->GetTime());
    //     if (!bakedPath.empty()) {
    //         filePath = bakedPath;
    //         xf = {};
    //         ExtractStdUVTransform(resolved, xf);
    //         xf.hasChannelSelect = outputChannelIndex != 1;
    //         xf.outputChannelIndex = outputChannelIndex;
    //         return true;
    //     }
    // }

    return false;
}

static void ExtractWrappedNormalBumpMaps(
    Texmap* map,
    std::wstring& normalPath,
    MaxJSPBR::TexTransform& normalXf,
    std::wstring& bumpPath,
    MaxJSPBR::TexTransform& bumpXf)
{
    if (!map) return;

    if (map->ClassID() == NORMAL_BUMP_CLASS_ID || IsVRayNormalMapTexmap(map)) {
        static const MCHAR* const kNormalMapParams[] = {
            _T("normal_map"),
            _T("normalMap"),
            _T("normal_texmap"),
            _T("texmap_normal"),
            _T("normal")
        };
        static const MCHAR* const kBumpMapParams[] = {
            _T("bump_map"),
            _T("bumpMap"),
            _T("bump_texmap"),
            _T("texmap_bump"),
            _T("bump")
        };
        static const MCHAR* const kNormalEnabledParams[] = {
            _T("map1on"),
            _T("normal_map_on"),
            _T("normalMap_on"),
            _T("texmap_normal_on")
        };
        static const MCHAR* const kBumpEnabledParams[] = {
            _T("map2on"),
            _T("bump_map_on"),
            _T("bumpMap_on"),
            _T("texmap_bump_on")
        };

        Texmap* normalMap = FindPBMapByNames(
            map,
            kNormalMapParams,
            sizeof(kNormalMapParams) / sizeof(kNormalMapParams[0]));
        Texmap* bumpMap = FindPBMapByNames(
            map,
            kBumpMapParams,
            sizeof(kBumpMapParams) / sizeof(kBumpMapParams[0]));
        const bool normalEnabled = FindPBIntByNames(
            map,
            kNormalEnabledParams,
            sizeof(kNormalEnabledParams) / sizeof(kNormalEnabledParams[0]),
            1) != 0;
        const bool bumpEnabled = FindPBIntByNames(
            map,
            kBumpEnabledParams,
            sizeof(kBumpEnabledParams) / sizeof(kBumpEnabledParams[0]),
            1) != 0;

        if (!normalMap && map->NumSubTexmaps() > 0)
            normalMap = map->GetSubTexmap(0);
        if (!bumpMap && map->NumSubTexmaps() > 1)
            bumpMap = map->GetSubTexmap(1);

        const int wrapperMapChannel = std::max(1, FindPBInt(map, _T("map_channel"), 1));
        if (normalEnabled && normalMap && ExtractMaterialTexture(normalMap, normalPath, normalXf)) {
            if (normalXf.uvChannel == 1) normalXf.uvChannel = wrapperMapChannel;
        }
        if (bumpEnabled && bumpMap && ExtractMaterialTexture(bumpMap, bumpPath, bumpXf)) {
            if (bumpXf.uvChannel == 1) bumpXf.uvChannel = wrapperMapChannel;
        }
        return;
    }

    ExtractMaterialTexture(map, bumpPath, bumpXf);
}

static std::wstring GetMtlxExportBaseDir() {
    Interface* ip = GetCOREInterface();
    std::wstring layerPath;
    if (ip) {
        MSTR scenePath = ip->GetCurFilePath();
        if (scenePath.Length() > 0) {
            layerPath = scenePath.data();
            const size_t slash = layerPath.find_last_of(L"\\/");
            if (slash != std::wstring::npos) layerPath = layerPath.substr(0, slash);
        }
    }
    if (layerPath.empty()) {
        wchar_t tmp[MAX_PATH];
        GetTempPathW(MAX_PATH, tmp);
        layerPath = tmp;
    }
    return layerPath;
}

// Export a material's MaterialX node graph as an XML string via MtlxIOUtil.
static std::wstring ExportMtlxString(Mtl* mtl, std::wstring* outBaseDir = nullptr) {
    if (!mtl) return {};

    const auto animHandle = Animatable::GetHandleByAnim(mtl);
    if (animHandle == 0) return {};

    const std::wstring layerPath = GetMtlxExportBaseDir();
    if (outBaseDir) *outBaseDir = layerPath;

    std::wostringstream ss;
    ss << LR"(
        fn _maxjs_exportMtlx materialAnimHandle layerPath = (
            local m = getAnimByHandle materialAnimHandle
            if m == undefined do return ""
            local mArr = #(m)
            local mtlxStr = MtlxIOUtil.ExportMtlxString layerPath mArr
            if mtlxStr == undefined then "" else mtlxStr
        )
        _maxjs_exportMtlx )" << animHandle << L" @\"" << layerPath << L"\"";

    FPValue rvalue;
    rvalue.Init();
    try {
        if (!ExecuteMAXScriptScript(ss.str().c_str(), MAXScript::ScriptSource::Dynamic, false, &rvalue)) {
            return {};
        }
        if (rvalue.type == TYPE_STRING && rvalue.s && wcslen(rvalue.s) > 0) {
            return std::wstring(rvalue.s);
        }
    } catch (...) {}
    return {};
}

static void ExtractThreeJSMtl(Mtl* mtl, TimeValue t, MaxJSPBR& d) {
    IParamBlock2* pb = mtl->GetParamBlockByID(threejs_params);
    if (!pb) return;
    auto getOptionalFloat = [&](ParamID id, float def) {
        return HasParam(pb, id) ? pb->GetFloat(id, t) : def;
    };
    auto getOptionalInt = [&](ParamID id, int def) {
        return HasParam(pb, id) ? pb->GetInt(id, t) : def;
    };

    MSTR name = mtl->GetName();
    d.mtlName = name.data();
    const Class_ID cid = mtl->ClassID();
    if (cid == THREEJS_ADV_MTL_CLASS_ID) {
        const int mode = HasParam(pb, pb_material_mode) ? pb->GetInt(pb_material_mode, t) : threejs_mode_standard;
        if (mode == threejs_mode_physical) d.materialModel = L"MeshPhysicalMaterial";
        else if (mode == threejs_mode_sss) d.materialModel = L"MeshSSSNodeMaterial";
        else d.materialModel = L"MeshStandardMaterial";
    } else if (cid == THREEJS_TSL_CLASS_ID) {
        d.materialModel = L"MeshTSLNodeMaterial";
    } else if (cid == THREEJS_UTILITY_MTL_CLASS_ID) {
        d.materialModel = GetUtilityMaterialModelName(pb->GetInt(pb_utility_model, t));
    } else {
        d.materialModel = L"MeshStandardMaterial";
    }

    Color c = pb->GetColor(pb_color, t);
    d.color[0] = c.r; d.color[1] = c.g; d.color[2] = c.b;
    d.roughness  = pb->GetFloat(pb_roughness, t);
    d.metalness  = pb->GetFloat(pb_metalness, t);
    d.opacity    = pb->GetFloat(pb_opacity, t);
    d.colorMapStrength = pb->GetFloat(pb_color_map_strength, t);
    d.roughnessMapStrength = pb->GetFloat(pb_roughness_map_strength, t);
    d.metalnessMapStrength = pb->GetFloat(pb_metalness_map_strength, t);
    d.normalScale = pb->GetFloat(pb_normal_scale, t);
    d.bumpScale = pb->GetFloat(pb_bump_scale, t);
    d.displacementScale = pb->GetFloat(pb_displacement_scale, t);
    d.displacementBias = pb->GetFloat(pb_displacement_bias, t);
    d.parallaxScale = pb->GetFloat(pb_parallax_scale, t);
    d.doubleSided = pb->GetInt(pb_double_sided, t) != 0;
    d.envIntensity = pb->GetFloat(pb_env_intensity, t);

    Color em = pb->GetColor(pb_emissive_color, t);
    d.emission[0] = em.r; d.emission[1] = em.g; d.emission[2] = em.b;
    d.emIntensity = pb->GetFloat(pb_emissive_intensity, t);
    d.emissiveMapStrength = pb->GetFloat(pb_emissive_map_strength, t);
    d.opacityMapStrength = pb->GetFloat(pb_opacity_map_strength, t);

    d.aoIntensity = pb->GetFloat(pb_ao_intensity, t);
    d.lightmapIntensity = pb->GetFloat(pb_lightmap_intensity, t);
    d.lightmapChannel = pb->GetInt(pb_lightmap_channel, t);

    if (cid == THREEJS_ADV_MTL_CLASS_ID && d.materialModel == L"MeshPhysicalMaterial") {
        Color specColor = pb->GetColor(pb_phys_specular_color, t);
        d.physicalSpecularColor[0] = specColor.r; d.physicalSpecularColor[1] = specColor.g; d.physicalSpecularColor[2] = specColor.b;
        d.physicalSpecularIntensity = pb->GetFloat(pb_phys_specular_intensity, t);
        d.clearcoat = pb->GetFloat(pb_phys_clearcoat, t);
        d.clearcoatRoughness = pb->GetFloat(pb_phys_clearcoat_roughness, t);
        d.sheen = pb->GetFloat(pb_phys_sheen, t);
        d.sheenRoughness = pb->GetFloat(pb_phys_sheen_roughness, t);
        Color sheenColor = pb->GetColor(pb_phys_sheen_color, t);
        d.sheenColor[0] = sheenColor.r; d.sheenColor[1] = sheenColor.g; d.sheenColor[2] = sheenColor.b;
        d.iridescence = pb->GetFloat(pb_phys_iridescence, t);
        d.iridescenceIOR = pb->GetFloat(pb_phys_iridescence_ior, t);
        d.transmission = pb->GetFloat(pb_phys_transmission, t);
        d.ior = pb->GetFloat(pb_phys_ior, t);
        d.thickness = pb->GetFloat(pb_phys_thickness, t);
        d.dispersion = pb->GetFloat(pb_phys_dispersion, t);
        Color attenuationColor = pb->GetColor(pb_phys_attenuation_color, t);
        d.attenuationColor[0] = attenuationColor.r; d.attenuationColor[1] = attenuationColor.g; d.attenuationColor[2] = attenuationColor.b;
        d.attenuationDistance = pb->GetFloat(pb_phys_attenuation_distance, t);
        d.anisotropy = pb->GetFloat(pb_phys_anisotropy, t);
    } else if (cid == THREEJS_ADV_MTL_CLASS_ID && d.materialModel == L"MeshSSSNodeMaterial") {
        Color sss = pb->GetColor(pb_sss_color, t);
        d.sssColor[0] = sss.r; d.sssColor[1] = sss.g; d.sssColor[2] = sss.b;
        d.sssDistortion = pb->GetFloat(pb_sss_distortion, t);
        d.sssAmbient = pb->GetFloat(pb_sss_ambient, t);
        d.sssAttenuation = pb->GetFloat(pb_sss_attenuation, t);
        d.sssPower = pb->GetFloat(pb_sss_power, t);
        d.sssScale = pb->GetFloat(pb_sss_scale, t);
    } else if (cid == THREEJS_TSL_CLASS_ID) {
        const MCHAR* code = pb->GetStr(pb_tsl_code);
        if (code && code[0]) d.tslCode = code;
        // Extract TSL texture map slots
        {
            static const ParamID tslMapIDs[] = {
                pb_tsl_map1, pb_tsl_map2, pb_tsl_map3, pb_tsl_map4,
                pb_tsl_map5, pb_tsl_map6, pb_tsl_map7, pb_tsl_map8,
                pb_tsl_map9, pb_tsl_map10, pb_tsl_map11, pb_tsl_map12,
                pb_tsl_map13, pb_tsl_map14, pb_tsl_map15, pb_tsl_map16
            };
            for (int m = 0; m < static_cast<int>(std::size(tslMapIDs)); ++m) {
                if (HasParam(pb, tslMapIDs[m])) {
                    Texmap* tm = pb->GetTexmap(tslMapIDs[m], t);
                    if (tm) {
                        MaxJSPBR::TexTransform xf;
                        ExtractMaterialTexture(tm, d.tslMaps[m], xf);
                    }
                }
            }
        }
        // Extract dynamic params JSON
        if (HasParam(pb, pb_tsl_params_json)) {
            const MCHAR* pj = pb->GetStr(pb_tsl_params_json);
            if (pj && pj[0]) d.tslParamsJson = pj;
        }
        // Auto-compile MaterialX from source material if connected
        if (HasParam(pb, pb_tsl_source_mtl)) {
            Mtl* srcMtl = pb->GetMtl(pb_tsl_source_mtl);
            if (srcMtl) {
                d.materialXBridgeConnected = true;
                MSTR srcName = srcMtl->GetName();
                if (srcName.Length() > 0) {
                    d.materialXBridgeSourceName = srcName.data();
                }

                if (IsMaterialXMaterialClass(srcMtl->ClassID())) {
                    MaxJSPBR srcBridge;
                    ExtractMaterialXMtl(srcMtl, t, srcBridge);
                    d.materialXFile = srcBridge.materialXFile;
                    d.materialXInline = srcBridge.materialXInline;
                    d.materialXBase = srcBridge.materialXBase;
                    d.materialXMaterialName = srcBridge.materialXMaterialName;
                    d.materialXMaterialIndex = std::max(1, srcBridge.materialXMaterialIndex);
                    if (d.materialXInline.empty() && d.materialXFile.empty()) {
                        d.materialXBridgeError = L"Connected MaterialX source produced no XML or file payload";
                    }
                } else {
                    std::wstring materialXBase;
                    std::wstring xml = ExportMtlxString(srcMtl, &materialXBase);
                    if (!xml.empty()) {
                        d.materialXInline = xml;
                        d.materialXBase = materialXBase;
                        if (srcName.Length() > 0)
                            d.materialXMaterialName = srcName.data();
                        d.materialXMaterialIndex = 1;
                    } else {
                        d.materialXBridgeError = L"MtlxIOUtil.ExportMtlxString returned empty XML";
                    }
                }
            }
        }
    } else if (cid == THREEJS_UTILITY_MTL_CLASS_ID) {
        Color spec = pb->GetColor(pb_specular_color, t);
        d.specular[0] = spec.r; d.specular[1] = spec.g; d.specular[2] = spec.b;
        d.shininess = getOptionalFloat(pb_shininess, 30.0f);
        d.reflectivity = getOptionalFloat(pb_reflectivity, 1.0f);
        d.refractionRatio = getOptionalFloat(pb_refraction_ratio, 0.98f);
        d.flatShading = getOptionalInt(pb_flat_shading, FALSE) != 0;
        d.wireframe = getOptionalInt(pb_wireframe, FALSE) != 0;
        d.fog = getOptionalInt(pb_fog, TRUE) != 0;
        d.backdropMode = getOptionalInt(pb_backdrop_mode, threejs_backdrop_blurred);
        d.normalMapType = getOptionalInt(pb_normal_map_type, threejs_utility_normal_tangent);
        d.depthPacking = getOptionalInt(pb_depth_packing, threejs_utility_depth_packing_basic);
        d.combine = getOptionalInt(pb_combine, threejs_utility_combine_multiply);
    }

    auto readMap = [&](ParamID pid, std::wstring& outPath, MaxJSPBR::TexTransform& outXf) {
        Texmap* map = pb->GetTexmap(pid, t);
        outPath.clear();
        outXf = {};
        ExtractMaterialTexture(map, outPath, outXf);
    };
    readMap(pb_color_map, d.colorMap, d.colorMapTransform);
    readMap(pb_roughness_map, d.roughnessMap, d.roughnessMapTransform);
    readMap(pb_metalness_map, d.metalnessMap, d.metalnessMapTransform);
    readMap(pb_normal_map, d.normalMap, d.normalMapTransform);
    readMap(pb_bump_map, d.bumpMap, d.bumpMapTransform);
    readMap(pb_displacement_map, d.displacementMap, d.displacementMapTransform);
    readMap(pb_parallax_map, d.parallaxMap, d.parallaxMapTransform);
    readMap(pb_emissive_map, d.emissionMap, d.emissionMapTransform);
    readMap(pb_opacity_map, d.opacityMap, d.opacityMapTransform);
    readMap(pb_lightmap, d.lightmapFile, d.lightmapTransform);
    readMap(pb_ao_map, d.aoMap, d.aoMapTransform);
    if (cid == THREEJS_ADV_MTL_CLASS_ID && d.materialModel == L"MeshPhysicalMaterial") {
        readMap(pb_phys_specular_intensity_map, d.specularIntensityMap, d.specularIntensityMapTransform);
        readMap(pb_phys_specular_color_map, d.specularColorMap, d.specularColorMapTransform);
        readMap(pb_phys_clearcoat_map, d.clearcoatMap, d.clearcoatMapTransform);
        readMap(pb_phys_clearcoat_roughness_map, d.clearcoatRoughnessMap, d.clearcoatRoughnessMapTransform);
        readMap(pb_phys_clearcoat_normal_map, d.clearcoatNormalMap, d.clearcoatNormalMapTransform);
        readMap(pb_phys_transmission_map, d.transmissionMap, d.transmissionMapTransform);
    } else if (cid == THREEJS_ADV_MTL_CLASS_ID && d.materialModel == L"MeshSSSNodeMaterial") {
        readMap(pb_sss_color_map, d.sssColorMap, d.sssColorMapTransform);
    } else if (cid == THREEJS_UTILITY_MTL_CLASS_ID) {
        readMap(pb_matcap_map, d.matcapMap, d.matcapMapTransform);
        readMap(pb_specular_map, d.specularMap, d.specularMapTransform);
    }
}

static void ExtractMaterialXMtl(Mtl* mtl, TimeValue /*t*/, MaxJSPBR& d) {
    if (!mtl) return;

    MSTR name = mtl->GetName();
    d.mtlName = name.data();
    d.materialModel = L"MaterialXMaterial";
    d.materialXFile = FindPBString(mtl, _T("MaterialXFile"));
    d.materialXMaterialName = FindPBString(mtl, _T("curMatName"));
    d.materialXMaterialIndex = std::max(1, FindPBInt(mtl, _T("curMatIdx"), 1));

    // If no file path, try live export from node graph
    if (d.materialXFile.empty()) {
        d.materialXInline = ExportMtlxString(mtl, &d.materialXBase);
    }
}

static void ExtractThreeJSToonMtl(Mtl* mtl, TimeValue t, MaxJSPBR& d) {
    IParamBlock2* pb = mtl->GetParamBlockByID(toon_params);
    if (!pb) return;

    MSTR name = mtl->GetName();
    d.mtlName = name.data();
    d.materialModel = L"MeshToonMaterial";

    Color c = pb->GetColor(tp_color, t);
    d.color[0] = c.r; d.color[1] = c.g; d.color[2] = c.b;
    d.opacity = pb->GetFloat(tp_opacity, t);
    d.normalScale = pb->GetFloat(tp_normal_scale, t);
    d.bumpScale = pb->GetFloat(tp_bump_scale, t);
    d.displacementScale = pb->GetFloat(tp_displacement_scale, t);
    d.displacementBias = pb->GetFloat(tp_displacement_bias, t);
    d.doubleSided = pb->GetInt(tp_double_sided, t) != 0;
    d.aoIntensity = pb->GetFloat(tp_ao_intensity, t);
    d.lightmapIntensity = pb->GetFloat(tp_lightmap_intensity, t);
    d.lightmapChannel = pb->GetInt(tp_lightmap_channel, t);

    Color em = pb->GetColor(tp_emissive_color, t);
    d.emission[0] = em.r; d.emission[1] = em.g; d.emission[2] = em.b;
    d.emIntensity = pb->GetFloat(tp_emissive_intensity, t);

    auto readMap = [&](ParamID pid, std::wstring& outPath, MaxJSPBR::TexTransform& outXf) {
        Texmap* map = pb->GetTexmap(pid, t);
        outPath.clear();
        outXf = {};
        ExtractMaterialTexture(map, outPath, outXf);
    };
    readMap(tp_color_map, d.colorMap, d.colorMapTransform);
    readMap(tp_gradient_map, d.gradientMap, d.gradientMapTransform);
    readMap(tp_normal_map, d.normalMap, d.normalMapTransform);
    readMap(tp_bump_map, d.bumpMap, d.bumpMapTransform);
    readMap(tp_emissive_map, d.emissionMap, d.emissionMapTransform);
    readMap(tp_opacity_map, d.opacityMap, d.opacityMapTransform);
    readMap(tp_lightmap, d.lightmapFile, d.lightmapTransform);
    readMap(tp_ao_map, d.aoMap, d.aoMapTransform);
    readMap(tp_displacement_map, d.displacementMap, d.displacementMapTransform);
}

// Extract PBR from glTF Material — generic paramblock reader
static void ExtractGltfMtl(Mtl* mtl, TimeValue t, MaxJSPBR& d) {
    MSTR name = mtl->GetName();
    d.mtlName = name.data();

    auto readColorAlpha = [&](const MCHAR* pname, float out[3], float* alpha = nullptr) {
        for (int b = 0; b < mtl->NumParamBlocks(); b++) {
            IParamBlock2* pb = mtl->GetParamBlock(b);
            if (!pb) continue;
            for (int i = 0; i < pb->NumParams(); i++) {
                ParamID pid = pb->IndextoID(i);
                const ParamDef& pd = pb->GetParamDef(pid);
                if (pd.int_name && _tcsicmp(pd.int_name, pname) == 0) {
                    if (pd.type == TYPE_FRGBA) {
                        AColor c = pb->GetAColor(pid, t);
                        out[0] = c.r; out[1] = c.g; out[2] = c.b;
                        if (alpha) *alpha = std::clamp(c.a, 0.0f, 1.0f);
                    } else if (pd.type == TYPE_RGBA) {
                        Color c = pb->GetColor(pid, t);
                        out[0] = c.r; out[1] = c.g; out[2] = c.b;
                        if (alpha) *alpha = 1.0f;
                    }
                    return;
                }
            }
        }
    };
    auto readColor = [&](const MCHAR* pname, float out[3]) {
        readColorAlpha(pname, out, nullptr);
    };
    auto readFloat = [&](const MCHAR* pname, float def) -> float {
        for (int b = 0; b < mtl->NumParamBlocks(); b++) {
            IParamBlock2* pb = mtl->GetParamBlock(b);
            if (!pb) continue;
            for (int i = 0; i < pb->NumParams(); i++) {
                ParamID pid = pb->IndextoID(i);
                const ParamDef& pd = pb->GetParamDef(pid);
                if (pd.int_name && _tcsicmp(pd.int_name, pname) == 0 && pd.type == TYPE_FLOAT)
                    return pb->GetFloat(pid, t);
            }
        }
        return def;
    };
    auto readInt = [&](const MCHAR* pname, int def) -> int {
        for (int b = 0; b < mtl->NumParamBlocks(); b++) {
            IParamBlock2* pb = mtl->GetParamBlock(b);
            if (!pb) continue;
            for (int i = 0; i < pb->NumParams(); i++) {
                ParamID pid = pb->IndextoID(i);
                const ParamDef& pd = pb->GetParamDef(pid);
                if (pd.int_name && _tcsicmp(pd.int_name, pname) == 0 &&
                    (pd.type == TYPE_INT || pd.type == TYPE_BOOL))
                    return pb->GetInt(pid, t);
            }
        }
        return def;
    };
    auto readBool = [&](const MCHAR* pname, bool def) -> bool {
        return readInt(pname, def ? 1 : 0) != 0;
    };
    auto readMap = [&](const MCHAR* pname, std::wstring& outPath, MaxJSPBR::TexTransform& outXf) -> bool {
        outPath.clear();
        outXf = {};
        for (int b = 0; b < mtl->NumParamBlocks(); b++) {
            IParamBlock2* pb = mtl->GetParamBlock(b);
            if (!pb) continue;
            for (int i = 0; i < pb->NumParams(); i++) {
                ParamID pid = pb->IndextoID(i);
                const ParamDef& pd = pb->GetParamDef(pid);
                if (pd.int_name && _tcsicmp(pd.int_name, pname) == 0 && pd.type == TYPE_TEXMAP) {
                    Texmap* map = pb->GetTexmap(pid, t);
                    ExtractMaterialTexture(map, outPath, outXf);
                    return map != nullptr;
                }
            }
        }
        return false;
    };

    float baseColorAlpha = 1.0f;
    readColorAlpha(_T("baseColor"), d.color, &baseColorAlpha);

    d.roughness   = readFloat(_T("roughness"), 0.5f);
    d.metalness   = readFloat(_T("metalness"), 0.0f);
    d.normalScale = readFloat(_T("normal"), 1.0f);
    d.aoIntensity = readFloat(_T("ambientOcclusion"), 1.0f);
    const int alphaMode = readInt(_T("alphaMode"), 1);
    d.opacity     = (alphaMode >= 2) ? std::clamp(baseColorAlpha, 0.0f, 1.0f) : 1.0f;
    d.alphaTest   = (alphaMode == 2) ? std::clamp(readFloat(_T("alphaCutoff"), 0.5f), 0.0f, 1.0f) : 0.0f;
    d.transparent = (alphaMode == 3);
    d.depthWrite  = (alphaMode != 3);
    d.doubleSided = readInt(_T("DoubleSided"), 0) != 0;

    readColor(_T("emissionColor"), d.emission);
    d.emIntensity = (d.emission[0] + d.emission[1] + d.emission[2] > 0) ? 1.0f : 0.0f;

    const bool hasBaseColorMap = readMap(_T("baseColorMap"), d.colorMap, d.colorMapTransform);
    if (hasBaseColorMap) {
        d.color[0] = 1.0f; d.color[1] = 1.0f; d.color[2] = 1.0f;
    }
    readMap(_T("roughnessMap"), d.roughnessMap, d.roughnessMapTransform);
    readMap(_T("metalnessMap"), d.metalnessMap, d.metalnessMapTransform);
    readMap(_T("normalMap"), d.normalMap, d.normalMapTransform);
    readMap(_T("ambientOcclusionMap"), d.aoMap, d.aoMapTransform);
    readMap(_T("emissionMap"), d.emissionMap, d.emissionMapTransform);
    readMap(_T("alphaMap"), d.opacityMap, d.opacityMapTransform);

    const bool enableClearcoat = readBool(_T("enableClearcoat"), false);
    const bool enableSpecular = readBool(_T("enableSpecular"), false);
    const bool enableTransmission = readBool(_T("enableTransmission"), false);
    const bool enableVolume = readBool(_T("enableVolume"), false);
    const bool enableIor = readBool(_T("enableIndexOfRefraction"), false);
    if (enableClearcoat || enableSpecular || enableTransmission || enableVolume || enableIor) {
        d.materialModel = L"MeshPhysicalMaterial";
    }
    if (enableClearcoat) {
        d.clearcoat = std::clamp(readFloat(_T("clearcoat"), 1.0f), 0.0f, 1.0f);
        d.clearcoatRoughness = std::clamp(readFloat(_T("clearcoatRoughness"), 0.0f), 0.0f, 1.0f);
        readMap(_T("clearcoatMap"), d.clearcoatMap, d.clearcoatMapTransform);
        readMap(_T("clearcoatRoughnessMap"), d.clearcoatRoughnessMap, d.clearcoatRoughnessMapTransform);
        readMap(_T("clearcoatNormalMap"), d.clearcoatNormalMap, d.clearcoatNormalMapTransform);
    }
    if (enableSpecular) {
        d.physicalSpecularIntensity = std::clamp(readFloat(_T("specular"), 1.0f), 0.0f, 1.0f);
        readColor(_T("specularColor"), d.physicalSpecularColor);
        readMap(_T("specularMap"), d.specularIntensityMap, d.specularIntensityMapTransform);
        readMap(_T("specularColorMap"), d.specularColorMap, d.specularColorMapTransform);
    }
    if (enableTransmission) {
        d.transmission = std::clamp(readFloat(_T("transmission"), 1.0f), 0.0f, 1.0f);
        readMap(_T("transmissionMap"), d.transmissionMap, d.transmissionMapTransform);
    }
    if (enableIor) {
        d.ior = std::clamp(readFloat(_T("indexOfRefraction"), 1.5f), 1.0f, 50.0f);
    }
    if (enableVolume) {
        d.thickness = std::max(0.0f, readFloat(_T("volumeThickness"), 0.0f));
        d.attenuationDistance = std::max(0.0f, readFloat(_T("volumeDistance"), 0.0f));
        readColor(_T("volumeColor"), d.attenuationColor);
    }
}

// Extract PBR from USD Preview Surface — generic paramblock reader
static void ExtractUsdPreviewSurfaceMtl(Mtl* mtl, TimeValue t, MaxJSPBR& d) {
    MSTR name = mtl->GetName();
    d.mtlName = name.data();

    auto readColor = [&](const MCHAR* pname, float out[3]) {
        for (int b = 0; b < mtl->NumParamBlocks(); b++) {
            IParamBlock2* pb = mtl->GetParamBlock(b);
            if (!pb) continue;
            for (int i = 0; i < pb->NumParams(); i++) {
                ParamID pid = pb->IndextoID(i);
                const ParamDef& pd = pb->GetParamDef(pid);
                if (pd.int_name && _tcsicmp(pd.int_name, pname) == 0) {
                    if (pd.type == TYPE_RGBA || pd.type == TYPE_FRGBA) {
                        Color c = pb->GetColor(pid, t);
                        out[0] = c.r; out[1] = c.g; out[2] = c.b;
                    }
                    return;
                }
            }
        }
    };
    auto readFloat = [&](const MCHAR* pname, float def) -> float {
        for (int b = 0; b < mtl->NumParamBlocks(); b++) {
            IParamBlock2* pb = mtl->GetParamBlock(b);
            if (!pb) continue;
            for (int i = 0; i < pb->NumParams(); i++) {
                ParamID pid = pb->IndextoID(i);
                const ParamDef& pd = pb->GetParamDef(pid);
                if (pd.int_name && _tcsicmp(pd.int_name, pname) == 0 && pd.type == TYPE_FLOAT)
                    return pb->GetFloat(pid, t);
            }
        }
        return def;
    };
    auto readMap = [&](const MCHAR* pname, std::wstring& outPath, MaxJSPBR::TexTransform& outXf) -> bool {
        outPath.clear();
        outXf = {};
        for (int b = 0; b < mtl->NumParamBlocks(); b++) {
            IParamBlock2* pb = mtl->GetParamBlock(b);
            if (!pb) continue;
            for (int i = 0; i < pb->NumParams(); i++) {
                ParamID pid = pb->IndextoID(i);
                const ParamDef& pd = pb->GetParamDef(pid);
                if (pd.int_name && _tcsicmp(pd.int_name, pname) == 0 && pd.type == TYPE_TEXMAP) {
                    Texmap* map = pb->GetTexmap(pid, t);
                    ExtractMaterialTexture(map, outPath, outXf);
                    return map != nullptr;
                }
            }
        }
        return false;
    };

    readColor(_T("diffuseColor"), d.color);

    d.roughness         = readFloat(_T("roughness"), 0.5f);
    d.metalness         = readFloat(_T("metallic"), 0.0f);
    d.opacity           = readFloat(_T("opacity"), 1.0f);
    d.normalScale       = readFloat(_T("bump_map_amt"), 1.0f);
    d.aoIntensity       = readFloat(_T("occlusion"), 1.0f);
    d.ior               = readFloat(_T("ior"), 1.5f);
    d.clearcoat         = readFloat(_T("clearcoat"), 0.0f);
    d.clearcoatRoughness = readFloat(_T("clearcoatRoughness"), 0.01f);
    d.displacementScale = readFloat(_T("displacement"), 0.0f);

    readColor(_T("emissiveColor"), d.emission);
    d.emIntensity = (d.emission[0] + d.emission[1] + d.emission[2] > 0) ? 1.0f : 0.0f;

    const bool hasDiffuseColorMap = readMap(_T("diffuseColor_map"), d.colorMap, d.colorMapTransform);
    if (hasDiffuseColorMap) {
        d.color[0] = 1.0f; d.color[1] = 1.0f; d.color[2] = 1.0f;
    }
    readMap(_T("roughness_map"),          d.roughnessMap,    d.roughnessMapTransform);
    readMap(_T("metallic_map"),           d.metalnessMap,    d.metalnessMapTransform);
    readMap(_T("normal_map"),             d.normalMap,       d.normalMapTransform);
    readMap(_T("occlusion_map"),          d.aoMap,           d.aoMapTransform);
    readMap(_T("emissiveColor_map"),      d.emissionMap,     d.emissionMapTransform);
    readMap(_T("opacity_map"),            d.opacityMap,      d.opacityMapTransform);
    readMap(_T("displacement_map"),       d.displacementMap, d.displacementMapTransform);

    // USD Preview Surface with clearcoat or IOR ≠ 1.5 → Physical material
    if (d.clearcoat > 0.0f || d.ior != 1.5f)
        d.materialModel = L"MeshPhysicalMaterial";
}

// ── Composite AO detection ──────────────────────────────────
#define COMPOSITE_TEX_CLASS_ID Class_ID(640, 0)
#define COMPOSITE_BLEND_MULTIPLY 5

static bool TrySplitCompositeAO(Texmap* map, TimeValue t,
                                std::wstring& colorPath, MaxJSPBR::TexTransform& colorXf,
                                std::wstring& aoPath, MaxJSPBR::TexTransform& aoXf) {
    if (!map || map->ClassID() != COMPOSITE_TEX_CLASS_ID) return false;
    IParamBlock2* pb = map->GetParamBlockByID(0);
    if (!pb) return false;

    auto getTabCount = [&](const MCHAR* pname) -> int {
        for (int i = 0; i < pb->NumParams(); i++) {
            ParamID pid = pb->IndextoID(i);
            const ParamDef& pd = pb->GetParamDef(pid);
            if (pd.int_name && _tcsicmp(pd.int_name, pname) == 0) return pb->Count(pid);
        }
        return 0;
    };
    auto getTabInt = [&](const MCHAR* pname, int idx) -> int {
        for (int i = 0; i < pb->NumParams(); i++) {
            ParamID pid = pb->IndextoID(i);
            const ParamDef& pd = pb->GetParamDef(pid);
            if (pd.int_name && _tcsicmp(pd.int_name, pname) == 0) return pb->GetInt(pid, t, idx);
        }
        return 0;
    };
    auto getTabTexmap = [&](const MCHAR* pname, int idx) -> Texmap* {
        for (int i = 0; i < pb->NumParams(); i++) {
            ParamID pid = pb->IndextoID(i);
            const ParamDef& pd = pb->GetParamDef(pid);
            if (pd.int_name && _tcsicmp(pd.int_name, pname) == 0) return pb->GetTexmap(pid, t, idx);
        }
        return nullptr;
    };

    if (getTabCount(_T("mapList")) < 2) return false;
    if (!getTabInt(_T("mapEnabled"), 0) || !getTabInt(_T("mapEnabled"), 1)) return false;
    if (getTabInt(_T("blendMode"), 1) != COMPOSITE_BLEND_MULTIPLY) return false;

    Texmap* layer1 = getTabTexmap(_T("mapList"), 0);
    Texmap* layer2 = getTabTexmap(_T("mapList"), 1);
    if (!layer1 || !layer2) return false;

    return ExtractMaterialTexture(layer1, colorPath, colorXf) &&
           ExtractMaterialTexture(layer2, aoPath, aoXf);
}

static void ExtractLegacyStandardMtl(Mtl* mtl, TimeValue t, MaxJSPBR& d) {
    StdMat* stdMtl = AsLegacyStandardMaterial(mtl);
    if (!stdMtl) return;

    MSTR name = mtl->GetName();
    d.mtlName = name.data();
    d.materialModel = L"MeshLambertMaterial";

    const Color diffuse = stdMtl->GetDiffuse(t);
    d.color[0] = diffuse.r;
    d.color[1] = diffuse.g;
    d.color[2] = diffuse.b;
    d.opacity = std::clamp(stdMtl->GetOpacity(t), 0.0f, 1.0f);
    d.roughness = 1.0f;
    d.metalness = 0.0f;
    d.doubleSided = stdMtl->GetTwoSided() != FALSE;
    d.wireframe = stdMtl->GetWire() != FALSE;
    d.reflectivity = 0.0f;

    if (StdMat2* stdMtl2 = dynamic_cast<StdMat2*>(stdMtl)) {
        if (stdMtl2->GetSelfIllumColorOn()) {
            const Color em = stdMtl2->GetSelfIllumColor(t);
            d.emission[0] = em.r;
            d.emission[1] = em.g;
            d.emission[2] = em.b;
            d.emIntensity = (em.r + em.g + em.b) > 1.0e-4f ? 1.0f : 0.0f;
        }
    }
    if (d.emIntensity <= 0.0f) {
        const float selfIllum = std::clamp(stdMtl->GetSelfIllum(t), 0.0f, 1.0f);
        if (selfIllum > 1.0e-4f) {
            d.emission[0] = d.color[0];
            d.emission[1] = d.color[1];
            d.emission[2] = d.color[2];
            d.emIntensity = selfIllum;
        }
    }

    auto getStdMap = [&](int id) -> Texmap* {
        if (!stdMtl->MapEnabled(id)) return nullptr;
        if (id < 0 || id >= mtl->NumSubTexmaps()) return nullptr;
        return mtl->GetSubTexmap(id);
    };
    auto readStdMap = [&](int id, std::wstring& outPath, MaxJSPBR::TexTransform& outXf) {
        outPath.clear();
        outXf = {};
        ExtractMaterialTexture(getStdMap(id), outPath, outXf);
    };

    Texmap* diffuseMap = getStdMap(ID_DI);
    if (!diffuseMap || !TrySplitCompositeAO(diffuseMap, t, d.colorMap, d.colorMapTransform, d.aoMap, d.aoMapTransform))
        readStdMap(ID_DI, d.colorMap, d.colorMapTransform);
    d.colorMapStrength = std::clamp(stdMtl->GetTexmapAmt(ID_DI, t), 0.0f, 1.0f);

    readStdMap(ID_OP, d.opacityMap, d.opacityMapTransform);
    d.opacityMapStrength = std::clamp(stdMtl->GetTexmapAmt(ID_OP, t), 0.0f, 1.0f);
    readStdMap(ID_SI, d.emissionMap, d.emissionMapTransform);
    d.emissiveMapStrength = std::clamp(stdMtl->GetTexmapAmt(ID_SI, t), 0.0f, 1.0f);
    readStdMap(ID_DP, d.displacementMap, d.displacementMapTransform);
    d.displacementScale = std::clamp(stdMtl->GetTexmapAmt(ID_DP, t), 0.0f, 1.0f);

    if (Texmap* bumpSlot = getStdMap(ID_BU)) {
        ExtractWrappedNormalBumpMaps(
            bumpSlot,
            d.normalMap,
            d.normalMapTransform,
            d.bumpMap,
            d.bumpMapTransform
        );
        d.bumpScale = std::clamp(stdMtl->GetTexmapAmt(ID_BU, t), 0.0f, 1.0f);
    }
}

// Extract PBR from 3ds Max Physical Material
static void ExtractPhysicalMtl(Mtl* mtl, TimeValue t, MaxJSPBR& d) {
    MSTR name = mtl->GetName();
    d.mtlName = name.data();
    d.materialModel = L"MeshPhysicalMaterial";

    auto readColor = [&](const MCHAR* pname, float out[3]) {
        for (int b = 0; b < mtl->NumParamBlocks(); b++) {
            IParamBlock2* pb = mtl->GetParamBlock(b);
            if (!pb) continue;
            for (int i = 0; i < pb->NumParams(); i++) {
                ParamID pid = pb->IndextoID(i);
                const ParamDef& pd = pb->GetParamDef(pid);
                if (pd.int_name && _tcsicmp(pd.int_name, pname) == 0 &&
                    (pd.type == TYPE_RGBA || pd.type == TYPE_FRGBA)) {
                    Color c = pb->GetColor(pid, t);
                    out[0] = c.r; out[1] = c.g; out[2] = c.b;
                    return;
                }
            }
        }
    };
    auto readFloat = [&](const MCHAR* pname, float def) -> float {
        for (int b = 0; b < mtl->NumParamBlocks(); b++) {
            IParamBlock2* pb = mtl->GetParamBlock(b);
            if (!pb) continue;
            for (int i = 0; i < pb->NumParams(); i++) {
                ParamID pid = pb->IndextoID(i);
                const ParamDef& pd = pb->GetParamDef(pid);
                if (pd.int_name && _tcsicmp(pd.int_name, pname) == 0 && pd.type == TYPE_FLOAT)
                    return pb->GetFloat(pid, t);
            }
        }
        return def;
    };
    auto readBool = [&](const MCHAR* pname, bool def) -> bool {
        for (int b = 0; b < mtl->NumParamBlocks(); b++) {
            IParamBlock2* pb = mtl->GetParamBlock(b);
            if (!pb) continue;
            for (int i = 0; i < pb->NumParams(); i++) {
                ParamID pid = pb->IndextoID(i);
                const ParamDef& pd = pb->GetParamDef(pid);
                if (pd.int_name && _tcsicmp(pd.int_name, pname) == 0 &&
                    (pd.type == TYPE_BOOL || pd.type == TYPE_INT))
                    return pb->GetInt(pid, t) != 0;
            }
        }
        return def;
    };
    auto readMap = [&](const MCHAR* pname, const MCHAR* onName,
                       std::wstring& outPath, MaxJSPBR::TexTransform& outXf) {
        outPath.clear();
        outXf = {};
        // Check if map is enabled
        if (onName && !readBool(onName, true)) return;
        for (int b = 0; b < mtl->NumParamBlocks(); b++) {
            IParamBlock2* pb = mtl->GetParamBlock(b);
            if (!pb) continue;
            for (int i = 0; i < pb->NumParams(); i++) {
                ParamID pid = pb->IndextoID(i);
                const ParamDef& pd = pb->GetParamDef(pid);
                if (pd.int_name && _tcsicmp(pd.int_name, pname) == 0 && pd.type == TYPE_TEXMAP) {
                    Texmap* map = pb->GetTexmap(pid, t);
                    ExtractMaterialTexture(map, outPath, outXf);
                    return;
                }
            }
        }
    };

    // Core PBR
    readColor(_T("base_color"), d.color);
    d.roughness  = readFloat(_T("roughness"), 0.0f);
    d.metalness  = readFloat(_T("metalness"), 0.0f);
    d.opacity    = 1.0f - readFloat(_T("transparency"), 0.0f);
    d.ior        = readFloat(_T("trans_ior"), 1.52f);
    d.normalScale = readFloat(_T("bump_map_amt"), 0.3f);
    d.displacementScale = readFloat(_T("displacement_map_amt"), 1.0f);

    // Transmission
    d.transmission = readFloat(_T("transparency"), 0.0f);
    if (d.transmission > 0.0f) {
        readColor(_T("trans_color"), d.attenuationColor);
        d.attenuationDistance = readFloat(_T("trans_depth"), 0.0f);
    }

    // Clearcoat
    d.clearcoat = readFloat(_T("coating"), 0.0f);
    d.clearcoatRoughness = readFloat(_T("coat_roughness"), 0.0f);

    // Sheen
    d.sheen = readFloat(_T("sheen"), 0.0f);
    d.sheenRoughness = readFloat(_T("sheen_roughness"), 0.3f);
    readColor(_T("sheen_color"), d.sheenColor);

    // Emission
    float emWeight = readFloat(_T("emission"), 0.0f);
    readColor(_T("emit_color"), d.emission);
    d.emIntensity = emWeight;

    // Anisotropy
    d.anisotropy = readFloat(_T("anisotropy"), 0.0f);

    // Iridescence (thin film)
    d.iridescence = readFloat(_T("thin_film"), 0.0f);
    d.iridescenceIOR = readFloat(_T("thin_film_ior"), 1.3f);

    // Helper to get raw Texmap from PB
    auto getTexmap = [&](const MCHAR* pname, const MCHAR* onName) -> Texmap* {
        if (onName && !readBool(onName, true)) return nullptr;
        for (int b = 0; b < mtl->NumParamBlocks(); b++) {
            IParamBlock2* pb = mtl->GetParamBlock(b);
            if (!pb) continue;
            for (int i = 0; i < pb->NumParams(); i++) {
                ParamID pid = pb->IndextoID(i);
                const ParamDef& pd = pb->GetParamDef(pid);
                if (pd.int_name && _tcsicmp(pd.int_name, pname) == 0 && pd.type == TYPE_TEXMAP)
                    return pb->GetTexmap(pid, t);
            }
        }
        return nullptr;
    };

    // Texture maps — check diffuse for Composite AO pattern
    {
        Texmap* baseColorMap = getTexmap(_T("base_color_map"), _T("base_color_map_on"));
        if (!baseColorMap || !TrySplitCompositeAO(baseColorMap, t, d.colorMap, d.colorMapTransform, d.aoMap, d.aoMapTransform))
            readMap(_T("base_color_map"), _T("base_color_map_on"), d.colorMap, d.colorMapTransform);
    }
    readMap(_T("roughness_map"),     _T("roughness_map_on"),     d.roughnessMap,    d.roughnessMapTransform);
    readMap(_T("metalness_map"),     _T("metalness_map_on"),     d.metalnessMap,    d.metalnessMapTransform);
    readMap(_T("emit_color_map"),    _T("emit_color_map_on"),    d.emissionMap,     d.emissionMapTransform);
    readMap(_T("coat_map"),          _T("coat_map_on"),          d.clearcoatMap,             d.clearcoatMapTransform);
    readMap(_T("coat_rough_map"),    _T("coat_rough_map_on"),    d.clearcoatRoughnessMap,    d.clearcoatRoughnessMapTransform);
    readMap(_T("displacement_map"), _T("displacement_map_on"),  d.displacementMap, d.displacementMapTransform);
    readMap(_T("transparency_map"), _T("transparency_map_on"),  d.opacityMap,      d.opacityMapTransform);
    readMap(_T("cutout_map"),       _T("cutout_map_on"),        d.opacityMap,      d.opacityMapTransform);

    // Normal/Bump map — Physical Material "bump_map" slot can contain either:
    //   1) Normal Bump texmap (wrapper) → subtex 0 is normal map, subtex 1 is additional bump
    //   2) Plain bitmap → height-based bump map
    // Detect which one and route to the correct PBR field.
    Texmap* bumpSlot = getTexmap(_T("bump_map"), _T("bump_map_on"));
    if (bumpSlot) {
        ExtractWrappedNormalBumpMaps(
            bumpSlot,
            d.normalMap,
            d.normalMapTransform,
            d.bumpMap,
            d.bumpMapTransform
        );
        if (!d.bumpMap.empty()) {
            d.bumpScale = d.normalScale;
        }
    }

    // Clearcoat normal/bump — same detection logic
    Texmap* coatBumpSlot = getTexmap(_T("coat_bump_map"), _T("coat_bump_map_on"));
    if (coatBumpSlot) {
        std::wstring clearcoatBumpPath;
        MaxJSPBR::TexTransform clearcoatBumpXf;
        ExtractWrappedNormalBumpMaps(
            coatBumpSlot,
            d.clearcoatNormalMap,
            d.clearcoatNormalMapTransform,
            clearcoatBumpPath,
            clearcoatBumpXf
        );
        if (d.clearcoatNormalMap.empty() && !clearcoatBumpPath.empty()) {
            d.clearcoatNormalMap = clearcoatBumpPath;
            d.clearcoatNormalMapTransform = clearcoatBumpXf;
        }
    }
}

// Extract PBR from OpenPBR Material — same PB layout as Physical Material
static void ExtractOpenPBRMtl(Mtl* mtl, TimeValue t, MaxJSPBR& d) {
    MSTR name = mtl->GetName();
    d.mtlName = name.data();
    d.materialModel = L"MeshPhysicalMaterial";

    // Reuse the same generic PB reader pattern as Physical Material
    auto readFloat = [&](const MCHAR* pname, float def) -> float {
        for (int b = 0; b < mtl->NumParamBlocks(); b++) {
            IParamBlock2* pb = mtl->GetParamBlock(b);
            if (!pb) continue;
            for (int i = 0; i < pb->NumParams(); i++) {
                ParamID pid = pb->IndextoID(i);
                const ParamDef& pd = pb->GetParamDef(pid);
                if (pd.int_name && _tcsicmp(pd.int_name, pname) == 0 && pd.type == TYPE_FLOAT)
                    return pb->GetFloat(pid, t);
            }
        }
        return def;
    };
    auto readColor = [&](const MCHAR* pname, float out[3]) {
        for (int b = 0; b < mtl->NumParamBlocks(); b++) {
            IParamBlock2* pb = mtl->GetParamBlock(b);
            if (!pb) continue;
            for (int i = 0; i < pb->NumParams(); i++) {
                ParamID pid = pb->IndextoID(i);
                const ParamDef& pd = pb->GetParamDef(pid);
                if (pd.int_name && _tcsicmp(pd.int_name, pname) == 0 &&
                    (pd.type == TYPE_RGBA || pd.type == TYPE_FRGBA)) {
                    Color c = pb->GetColor(pid, t);
                    out[0] = c.r; out[1] = c.g; out[2] = c.b;
                    return;
                }
            }
        }
    };
    auto readBool = [&](const MCHAR* pname, bool def) -> bool {
        for (int b = 0; b < mtl->NumParamBlocks(); b++) {
            IParamBlock2* pb = mtl->GetParamBlock(b);
            if (!pb) continue;
            for (int i = 0; i < pb->NumParams(); i++) {
                ParamID pid = pb->IndextoID(i);
                const ParamDef& pd = pb->GetParamDef(pid);
                if (pd.int_name && _tcsicmp(pd.int_name, pname) == 0 &&
                    (pd.type == TYPE_BOOL || pd.type == TYPE_INT))
                    return pb->GetInt(pid, t) != 0;
            }
        }
        return def;
    };
    auto readMap = [&](const MCHAR* mapName, const MCHAR* onName,
                       std::wstring& outPath, MaxJSPBR::TexTransform& outXf) {
        outPath.clear(); outXf = {};
        if (onName && !readBool(onName, true)) return;
        for (int b = 0; b < mtl->NumParamBlocks(); b++) {
            IParamBlock2* pb = mtl->GetParamBlock(b);
            if (!pb) continue;
            for (int i = 0; i < pb->NumParams(); i++) {
                ParamID pid = pb->IndextoID(i);
                const ParamDef& pd = pb->GetParamDef(pid);
                if (pd.int_name && _tcsicmp(pd.int_name, mapName) == 0 && pd.type == TYPE_TEXMAP) {
                    Texmap* map = pb->GetTexmap(pid, t);
                    ExtractMaterialTexture(map, outPath, outXf);
                    return;
                }
            }
        }
    };
    auto reflectivityFromIor = [](float ior) -> float {
        const float clampedIor = std::max(1.0f, ior);
        const float numerator = clampedIor - 1.0f;
        const float denominator = clampedIor + 1.0f;
        if (denominator <= 1.0e-6f) return 0.0f;
        const float f0 = (numerator * numerator) / (denominator * denominator);
        return std::clamp(std::sqrt(std::max(0.0f, f0) / 0.16f), 0.0f, 1.0f);
    };

    // Core PBR
    readColor(_T("base_color"), d.color);
    d.roughness       = readFloat(_T("specular_roughness"), 0.3f);
    d.metalness       = readFloat(_T("base_metalness"), 0.0f);
    d.ior             = readFloat(_T("specular_ior"), 1.5f);
    d.reflectivity    = reflectivityFromIor(d.ior);
    d.normalScale     = readFloat(_T("bump_map_amt"), 1.0f);
    d.displacementScale = readFloat(_T("displacement_map_amt"), 1.0f);
    d.anisotropy      = readFloat(_T("specular_roughness_anisotropy"), 0.0f);

    // Specular
    readColor(_T("specular_color"), d.physicalSpecularColor);
    d.physicalSpecularIntensity = readFloat(_T("specular_weight"), 1.0f);

    // Transmission
    const bool thinWalled = readBool(_T("geometry_thin_walled"), false);
    const float transmissionDepth = readFloat(_T("transmission_depth"), 0.0f);
    d.transmission = readFloat(_T("transmission_weight"), 0.0f);
    if (d.transmission > 0.0f) {
        readColor(_T("transmission_color"), d.attenuationColor);
        d.attenuationDistance = transmissionDepth;
        // OpenPBR relies on actual mesh thickness when thin_walled is off.
        // Three.js needs an explicit thickness scalar for volumetric
        // transmission/refraction, so approximate it from transmission_depth.
        if (!thinWalled) {
            d.thickness = transmissionDepth > 0.0f ? transmissionDepth : 1.0f;
        }
        d.dispersion = readFloat(_T("transmission_dispersion_scale"), 0.0f);
    }

    // Coat
    d.clearcoat = readFloat(_T("coat_weight"), 0.0f);
    d.clearcoatRoughness = readFloat(_T("coat_roughness"), 0.0f);

    // Fuzz → Sheen
    d.sheen = readFloat(_T("fuzz_weight"), 0.0f);
    readColor(_T("fuzz_color"), d.sheenColor);
    d.sheenRoughness = readFloat(_T("fuzz_roughness"), 0.5f);

    // Emission
    float emWeight = readFloat(_T("emission_weight"), 0.0f);
    readColor(_T("emission_color"), d.emission);
    d.emIntensity = emWeight;

    // Thin film → Iridescence
    d.iridescence = readFloat(_T("thin_film_weight"), 0.0f);
    d.iridescenceIOR = readFloat(_T("thin_film_ior"), 1.4f);

    auto getTexmap = [&](const MCHAR* pname, const MCHAR* onName) -> Texmap* {
        if (onName && !readBool(onName, true)) return nullptr;
        for (int b = 0; b < mtl->NumParamBlocks(); b++) {
            IParamBlock2* pb = mtl->GetParamBlock(b);
            if (!pb) continue;
            for (int i = 0; i < pb->NumParams(); i++) {
                ParamID pid = pb->IndextoID(i);
                const ParamDef& pd = pb->GetParamDef(pid);
                if (pd.int_name && _tcsicmp(pd.int_name, pname) == 0 && pd.type == TYPE_TEXMAP)
                    return pb->GetTexmap(pid, t);
            }
        }
        return nullptr;
    };

    // Texture maps — check for Composite AO
    {
        Texmap* baseColorMap = getTexmap(_T("base_color_map"), _T("base_color_map_on"));
        if (!baseColorMap || !TrySplitCompositeAO(baseColorMap, t, d.colorMap, d.colorMapTransform, d.aoMap, d.aoMapTransform))
            readMap(_T("base_color_map"), _T("base_color_map_on"), d.colorMap, d.colorMapTransform);
    }
    readMap(_T("specular_weight_map"),    _T("specular_weight_map_on"),    d.specularIntensityMap, d.specularIntensityMapTransform);
    readMap(_T("specular_color_map"),     _T("specular_color_map_on"),     d.specularColorMap,     d.specularColorMapTransform);
    readMap(_T("specular_roughness_map"), _T("specular_roughness_map_on"), d.roughnessMap,    d.roughnessMapTransform);
    readMap(_T("base_metalness_map"),     _T("base_metalness_map_on"),     d.metalnessMap,    d.metalnessMapTransform);
    readMap(_T("emission_color_map"),     _T("emission_color_map_on"),     d.emissionMap,     d.emissionMapTransform);
    readMap(_T("geometry_opacity_map"),   _T("geometry_opacity_map_on"),   d.opacityMap,      d.opacityMapTransform);
    readMap(_T("transmission_weight_map"), _T("transmission_weight_map_on"), d.transmissionMap, d.transmissionMapTransform);
    readMap(_T("displacement_map"),       _T("displacement_map_on"),       d.displacementMap, d.displacementMapTransform);
    readMap(_T("coat_weight_map"),        _T("coat_weight_map_on"),        d.clearcoatMap,    d.clearcoatMapTransform);
    readMap(_T("coat_roughness_map"),     _T("coat_roughness_map_on"),     d.clearcoatRoughnessMap, d.clearcoatRoughnessMapTransform);
    readMap(_T("geometry_coat_normal_map"), _T("geometry_coat_normal_map_on"), d.clearcoatNormalMap, d.clearcoatNormalMapTransform);

    // geometry_normal_map is a dedicated normal map slot (no Normal Bump wrapper needed)
    readMap(_T("geometry_normal_map"), _T("geometry_normal_map_on"), d.normalMap, d.normalMapTransform);

    // bump_map can be Normal Bump or plain bump — same detection as Physical
    Texmap* bumpSlot = getTexmap(_T("bump_map"), _T("bump_map_on"));
    if (bumpSlot) {
        std::wstring wrappedNormalPath;
        MaxJSPBR::TexTransform wrappedNormalXf;
        std::wstring wrappedBumpPath;
        MaxJSPBR::TexTransform wrappedBumpXf;
        ExtractWrappedNormalBumpMaps(
            bumpSlot,
            wrappedNormalPath,
            wrappedNormalXf,
            wrappedBumpPath,
            wrappedBumpXf
        );

        if (d.normalMap.empty() && !wrappedNormalPath.empty()) {
            d.normalMap = wrappedNormalPath;
            d.normalMapTransform = wrappedNormalXf;
        }
        if (!wrappedBumpPath.empty()) {
            d.bumpMap = wrappedBumpPath;
            d.bumpMapTransform = wrappedBumpXf;
        } else if (d.normalMap.empty() && d.bumpMap.empty()) {
            d.bumpMap = wrappedNormalPath;
            d.bumpMapTransform = wrappedNormalXf;
        }
        if (!d.bumpMap.empty()) {
            d.bumpScale = d.normalScale;
        }
    }

    // Keep OpenPBR on the physical path. Specular IOR/reflectivity is part of
    // the core shading model and must not depend on coat or transmission.
}

// Extract PBR from VRayMtl
static void ExtractVRayMtl(Mtl* mtl, TimeValue t, MaxJSPBR& d) {
    MSTR name = mtl->GetName();
    d.mtlName = name.data();
    d.materialModel = L"MeshPhysicalMaterial";

    // VRayMtl uses PB index 1 ("basic") for most params
    auto readFloat = [&](const MCHAR* pname, float def) -> float {
        for (int b = 0; b < mtl->NumParamBlocks(); b++) {
            IParamBlock2* pb = mtl->GetParamBlock(b);
            if (!pb) continue;
            for (int i = 0; i < pb->NumParams(); i++) {
                ParamID pid = pb->IndextoID(i);
                const ParamDef& pd = pb->GetParamDef(pid);
                if (pd.int_name && _tcsicmp(pd.int_name, pname) == 0 && pd.type == TYPE_FLOAT)
                    return pb->GetFloat(pid, t);
            }
        }
        return def;
    };
    auto readColor = [&](const MCHAR* pname, float out[3]) {
        for (int b = 0; b < mtl->NumParamBlocks(); b++) {
            IParamBlock2* pb = mtl->GetParamBlock(b);
            if (!pb) continue;
            for (int i = 0; i < pb->NumParams(); i++) {
                ParamID pid = pb->IndextoID(i);
                const ParamDef& pd = pb->GetParamDef(pid);
                if (pd.int_name && _tcsicmp(pd.int_name, pname) == 0) {
                    if (pd.type == TYPE_RGBA || pd.type == TYPE_FRGBA || pd.type == TYPE_COLOR) {
                        Color c = pb->GetColor(pid, t);
                        out[0] = c.r; out[1] = c.g; out[2] = c.b;
                    }
                    return;
                }
            }
        }
    };
    auto readBool = [&](const MCHAR* pname, bool def) -> bool {
        for (int b = 0; b < mtl->NumParamBlocks(); b++) {
            IParamBlock2* pb = mtl->GetParamBlock(b);
            if (!pb) continue;
            for (int i = 0; i < pb->NumParams(); i++) {
                ParamID pid = pb->IndextoID(i);
                const ParamDef& pd = pb->GetParamDef(pid);
                if (pd.int_name && _tcsicmp(pd.int_name, pname) == 0 &&
                    (pd.type == TYPE_BOOL || pd.type == TYPE_INT))
                    return pb->GetInt(pid, t) != 0;
            }
        }
        return def;
    };
    auto readMap = [&](const MCHAR* mapName, const MCHAR* onName,
                       std::wstring& outPath, MaxJSPBR::TexTransform& outXf) {
        outPath.clear(); outXf = {};
        if (onName && !readBool(onName, true)) return;
        for (int b = 0; b < mtl->NumParamBlocks(); b++) {
            IParamBlock2* pb = mtl->GetParamBlock(b);
            if (!pb) continue;
            for (int i = 0; i < pb->NumParams(); i++) {
                ParamID pid = pb->IndextoID(i);
                const ParamDef& pd = pb->GetParamDef(pid);
                if (pd.int_name && _tcsicmp(pd.int_name, mapName) == 0 && pd.type == TYPE_TEXMAP) {
                    Texmap* map = pb->GetTexmap(pid, t);
                    ExtractMaterialTexture(map, outPath, outXf);
                    return;
                }
            }
        }
    };
    auto getTexmap = [&](const MCHAR* pname, const MCHAR* onName) -> Texmap* {
        if (onName && !readBool(onName, true)) return nullptr;
        for (int b = 0; b < mtl->NumParamBlocks(); b++) {
            IParamBlock2* pb = mtl->GetParamBlock(b);
            if (!pb) continue;
            for (int i = 0; i < pb->NumParams(); i++) {
                ParamID pid = pb->IndextoID(i);
                const ParamDef& pd = pb->GetParamDef(pid);
                if (pd.int_name && _tcsicmp(pd.int_name, pname) == 0 && pd.type == TYPE_TEXMAP)
                    return pb->GetTexmap(pid, t);
            }
        }
        return nullptr;
    };

    // Core PBR
    readColor(_T("diffuse"), d.color);
    const bool useRoughnessWorkflow = readBool(_T("brdf_useRoughness"), false);
    const float reflectionGlossiness = readFloat(_T("reflection_glossiness"), 1.0f);
    d.roughness = useRoughnessWorkflow ? reflectionGlossiness : (1.0f - reflectionGlossiness);
    d.metalness = readFloat(_T("reflection_metalness"), 0.0f);
    d.ior = readFloat(_T("refraction_ior"), readFloat(_T("reflection_ior"), 1.6f));
    // VRayMtl drives both height bump and VRayNormalMap through the bump slot.
    // Its amount is a percentage in common scenes, so 100 should become a
    // Three.js normalScale/bumpScale of 1.0 instead of the old overdriven value.
    d.normalScale = std::max(0.0f, readFloat(_T("bump_multiplier"), 100.0f) / 100.0f);
    d.doubleSided = readBool(_T("option_doubleSided"), true);

    // Emission
    readColor(_T("selfIllumination"), d.emission);
    d.emIntensity = readFloat(_T("selfIllumination_multiplier"), 1.0f);
    if (d.emission[0] + d.emission[1] + d.emission[2] < 0.001f) d.emIntensity = 0.0f;

    // Refraction → transmission
    float refr[3] = {0, 0, 0};
    readColor(_T("refraction"), refr);
    d.transmission = (refr[0] + refr[1] + refr[2]) / 3.0f;
    if (d.transmission > 0.0f) {
        readColor(_T("refraction_fogColor"), d.attenuationColor);
        d.attenuationDistance = readFloat(_T("refraction_fogDepth"), readFloat(_T("refraction_fogMult"), 1.0f));
        if (readBool(_T("refraction_dispersion_on"), false))
            d.dispersion = readFloat(_T("refraction_dispersion"), 0.0f);
    }

    // Coat
    d.clearcoat = readFloat(_T("coat_amount"), 0.0f);
    d.clearcoatRoughness = 1.0f - readFloat(_T("coat_glossiness"), 1.0f);

    // Sheen
    float sheenCol[3] = {0, 0, 0};
    readColor(_T("sheen_color"), sheenCol);
    d.sheen = (sheenCol[0] + sheenCol[1] + sheenCol[2]) / 3.0f;
    d.sheenColor[0] = sheenCol[0]; d.sheenColor[1] = sheenCol[1]; d.sheenColor[2] = sheenCol[2];
    d.sheenRoughness = 1.0f - readFloat(_T("sheen_glossiness"), 0.8f);

    // Anisotropy
    d.anisotropy = readFloat(_T("anisotropy"), 0.0f);

    // Thin film → iridescence
    if (readBool(_T("thinFilm_on"), false)) {
        d.iridescence = 1.0f;
        d.iridescenceIOR = readFloat(_T("thinFilm_ior"), 1.47f);
    }

    // Texture maps
    // Diffuse — check for Composite AO pattern (Color × AO multiply)
    {
        Texmap* diffuseMap = nullptr;
        if (readBool(_T("texmap_diffuse_on"), true)) {
            for (int b = 0; b < mtl->NumParamBlocks(); b++) {
                IParamBlock2* pb = mtl->GetParamBlock(b);
                if (!pb) continue;
                for (int i = 0; i < pb->NumParams(); i++) {
                    ParamID pid = pb->IndextoID(i);
                    const ParamDef& pd = pb->GetParamDef(pid);
                    if (pd.int_name && _tcsicmp(pd.int_name, _T("texmap_diffuse")) == 0 && pd.type == TYPE_TEXMAP) {
                        diffuseMap = pb->GetTexmap(pid, t);
                        break;
                    }
                }
                if (diffuseMap) break;
            }
        }
        if (!diffuseMap || !TrySplitCompositeAO(diffuseMap, t, d.colorMap, d.colorMapTransform, d.aoMap, d.aoMapTransform))
            readMap(_T("texmap_diffuse"), _T("texmap_diffuse_on"), d.colorMap, d.colorMapTransform);
    }
    if (useRoughnessWorkflow) {
        readMap(_T("texmap_roughness"), _T("texmap_roughness_on"), d.roughnessMap, d.roughnessMapTransform);
    } else {
        readMap(_T("texmap_reflectionGlossiness"), _T("texmap_reflectionGlossiness_on"), d.roughnessMap, d.roughnessMapTransform);
        if (!d.roughnessMap.empty())
            d.roughnessMapTransform.invert = true;
    }
    readMap(_T("texmap_metalness"),        _T("texmap_metalness_on"),        d.metalnessMap,  d.metalnessMapTransform);
    readMap(_T("texmap_refraction"),       _T("texmap_refraction_on"),       d.transmissionMap, d.transmissionMapTransform);
    readMap(_T("texmap_self_illumination"),_T("texmap_self_illumination_on"),d.emissionMap,   d.emissionMapTransform);
    readMap(_T("texmap_opacity"),          _T("texmap_opacity_on"),          d.opacityMap,    d.opacityMapTransform);
    readMap(_T("texmap_displacement"),     _T("texmap_displacement_on"),     d.displacementMap, d.displacementMapTransform);
    readMap(_T("texmap_coat_amount"),      _T("texmap_coat_amount_on"),      d.clearcoatMap,  d.clearcoatMapTransform);
    readMap(_T("texmap_coat_glossiness"),  _T("texmap_coat_glossiness_on"),  d.clearcoatRoughnessMap, d.clearcoatRoughnessMapTransform);
    if (!d.clearcoatRoughnessMap.empty())
        d.clearcoatRoughnessMapTransform.invert = true;

    Texmap* bumpSlot = getTexmap(_T("texmap_bump"), _T("texmap_bump_on"));
    if (bumpSlot) {
        ExtractWrappedNormalBumpMaps(
            bumpSlot,
            d.normalMap,
            d.normalMapTransform,
            d.bumpMap,
            d.bumpMapTransform
        );
        if (!d.bumpMap.empty())
            d.bumpScale = d.normalScale;
    }

    Texmap* coatBumpSlot = getTexmap(_T("texmap_coat_bump"), _T("texmap_coat_bump_on"));
    if (coatBumpSlot) {
        std::wstring clearcoatBumpPath;
        MaxJSPBR::TexTransform clearcoatBumpXf;
        ExtractWrappedNormalBumpMaps(
            coatBumpSlot,
            d.clearcoatNormalMap,
            d.clearcoatNormalMapTransform,
            clearcoatBumpPath,
            clearcoatBumpXf
        );
        if (d.clearcoatNormalMap.empty() && !clearcoatBumpPath.empty()) {
            d.clearcoatNormalMap = clearcoatBumpPath;
            d.clearcoatNormalMapTransform = clearcoatBumpXf;
        }
    }

    // Keep VRay on the physical path. Reflection/specular controls are valid
    // even when coat/transmission/etc. are off, and downgrading here drops them.
}

// Extract PBR from a single material (ThreeJS, glTF, or wire color fallback)
static void ExtractPBRFromMtl(Mtl* mtl, INode* node, TimeValue t, MaxJSPBR& d) {
    if (mtl) {
        Mtl* found = FindSupportedMaterial(mtl);
        if (found) {
            const Class_ID cid = found->ClassID();
            if (IsThreeJSMaterialClass(cid))
                ExtractThreeJSMtl(found, t, d);
            else if (cid == THREEJS_TOON_CLASS_ID)
                ExtractThreeJSToonMtl(found, t, d);
            else if (IsMaterialXMaterialClass(cid))
                ExtractMaterialXMtl(found, t, d);
            else if (cid == USD_PREVIEW_SURFACE_CLASS_ID)
                ExtractUsdPreviewSurfaceMtl(found, t, d);
            else if (cid == PHYSICAL_MTL_CLASS_ID)
                ExtractPhysicalMtl(found, t, d);
            else if (cid == VRAYMTL_CLASS_ID)
                ExtractVRayMtl(found, t, d);
            else if (cid == OPENPBR_MTL_CLASS_ID)
                ExtractOpenPBRMtl(found, t, d);
            else if (IsLegacyStandardMaterial(found))
                ExtractLegacyStandardMtl(found, t, d);
            else
                ExtractGltfMtl(found, t, d);
            return;
        }
    }
    if (node) GetWireColor3f(node, d.color);
}

// Find the Multi/Sub material if any (unwrap Shell if needed)
static Mtl* FindMultiSubMtl(Mtl* mtl) {
    if (!mtl) return nullptr;
    if (mtl->IsMultiMtl()) return mtl;
    if (mtl->ClassID() == SHELL_MTL_CLASS_ID) {
        for (int i = 0; i < mtl->NumSubMtls(); i++) {
            Mtl* sub = mtl->GetSubMtl(i);
            if (sub && sub->IsMultiMtl()) return sub;
        }
    }
    return nullptr;
}

static Mtl* GetSubMtlFromMatID(Mtl* multiMtl, int matID) {
    if (!multiMtl) return nullptr;
    const int subCount = multiMtl->NumSubMtls();
    if (subCount <= 0) return nullptr;

    // Multi/Sub-Object keeps two parallel, compacted per-slot tables in its
    // param block: materialIDList (the ID column) and materialList (the
    // sub-materials). Slots can carry arbitrary, non-sequential IDs — common
    // after detaching part of a multi-material mesh, where the fragment keeps
    // a single face-ID group (e.g. only ID 2) against the original material.
    // Resolve the face's material ID against the ID table and pull the
    // sub-material from the matching slot of materialList, instead of assuming
    // the slot index equals matID - 1. Reading materialList directly avoids
    // depending on whether GetSubMtl() exposes a compacted or ID-sparse view.
    for (int b = 0; b < multiMtl->NumParamBlocks(); b++) {
        IParamBlock2* pb = multiMtl->GetParamBlock(b);
        if (!pb) continue;
        ParamID idListId = -1;
        ParamID mtlListId = -1;
        for (int i = 0; i < pb->NumParams(); i++) {
            const ParamID pid = pb->IndextoID(i);
            const ParamDef& pd = pb->GetParamDef(pid);
            if (!pd.int_name) continue;
            if (pd.type == TYPE_INT_TAB && PBNameEquals(pd.int_name, _T("materialIDList")))
                idListId = pid;
            else if (pd.type == TYPE_MTL_TAB && PBNameEquals(pd.int_name, _T("materialList")))
                mtlListId = pid;
        }
        if (idListId < 0) continue;
        const int idCount = pb->Count(idListId);
        for (int s = 0; s < idCount; s++) {
            if (pb->GetInt(idListId, 0, s) != matID) continue;
            if (mtlListId >= 0 && s < pb->Count(mtlListId))
                return pb->GetMtl(mtlListId, 0, s);
            return (s < subCount) ? multiMtl->GetSubMtl(s) : nullptr;
        }
    }

    // No usable ID table (legacy / non-standard multi material): fall back to
    // the sequential mapping, wrapping out-of-range IDs the way the renderer
    // does for the common contiguous case.
    int idx = (matID > 0 && matID <= subCount)
                  ? (matID - 1)
                  : (((matID % subCount) + subCount) % subCount);
    return multiMtl->GetSubMtl(idx);
}

template <typename TGroupList>
static bool ShouldEmitMultiSubMaterialGroups(Mtl* multiMtl, const TGroupList& groups) {
    return multiMtl && multiMtl->NumSubMtls() > 0 && !groups.empty();
}

static void ExtractPBR(INode* node, TimeValue t, MaxJSPBR& d) {
    Mtl* mtl = node->GetMtl();

    // Priority 1: ThreeJS Material, glTF Material, or USD Preview Surface (direct or inside Shell)
    Mtl* found = FindSupportedMaterial(mtl);
    if (found) {
        const Class_ID cid = found->ClassID();
        if (IsThreeJSMaterialClass(cid))
            ExtractThreeJSMtl(found, t, d);
        else if (cid == THREEJS_TOON_CLASS_ID)
            ExtractThreeJSToonMtl(found, t, d);
        else if (IsMaterialXMaterialClass(cid))
            ExtractMaterialXMtl(found, t, d);
        else if (cid == USD_PREVIEW_SURFACE_CLASS_ID)
            ExtractUsdPreviewSurfaceMtl(found, t, d);
        else if (cid == PHYSICAL_MTL_CLASS_ID)
            ExtractPhysicalMtl(found, t, d);
        else if (cid == VRAYMTL_CLASS_ID)
            ExtractVRayMtl(found, t, d);
        else if (cid == OPENPBR_MTL_CLASS_ID)
            ExtractOpenPBRMtl(found, t, d);
        else if (IsLegacyStandardMaterial(found))
            ExtractLegacyStandardMtl(found, t, d);
        else
            ExtractGltfMtl(found, t, d);
        return;
    }

    // Priority 2: Wire color fallback (old material conversion disabled for speed)
    GetWireColor3f(node, d.color);
}

static void ExtractMaterialScalarPreview(Mtl* foundMtl, INode* node, TimeValue t, float col[3], float& rough, float& metal, float& opac) {
    if (!foundMtl) {
        if (node) GetWireColor3f(node, col);
        return;
    }

    const Class_ID cid = foundMtl->ClassID();
    if (IsThreeJSMaterialClass(cid)) {
        IParamBlock2* pb = foundMtl->GetParamBlockByID(threejs_params);
        if (pb) {
            Color c = pb->GetColor(pb_color, t);
            col[0] = c.r; col[1] = c.g; col[2] = c.b;
            rough = pb->GetFloat(pb_roughness, t);
            metal = pb->GetFloat(pb_metalness, t);
            opac = pb->GetFloat(pb_opacity, t);
            return;
        }
    } else if (cid == THREEJS_TOON_CLASS_ID) {
        IParamBlock2* pb = foundMtl->GetParamBlockByID(toon_params);
        if (pb) {
            Color c = pb->GetColor(tp_color, t);
            col[0] = c.r; col[1] = c.g; col[2] = c.b;
            rough = 0.0f;
            metal = 0.0f;
            opac = pb->GetFloat(tp_opacity, t);
            return;
        }
    } else if (cid == GLTF_MTL_CLASS_ID) {
        MaxJSPBR tmp;
        ExtractGltfMtl(foundMtl, t, tmp);
        col[0] = tmp.color[0]; col[1] = tmp.color[1]; col[2] = tmp.color[2];
        rough = tmp.roughness;
        metal = tmp.metalness;
        opac = tmp.opacity;
        return;
    } else if (cid == USD_PREVIEW_SURFACE_CLASS_ID) {
        MaxJSPBR tmp;
        ExtractUsdPreviewSurfaceMtl(foundMtl, t, tmp);
        col[0] = tmp.color[0]; col[1] = tmp.color[1]; col[2] = tmp.color[2];
        rough = tmp.roughness;
        metal = tmp.metalness;
        opac = tmp.opacity;
        return;
    } else {
        MaxJSPBR tmp;
        ExtractPBRFromMtl(foundMtl, node, t, tmp);
        col[0] = tmp.color[0]; col[1] = tmp.color[1]; col[2] = tmp.color[2];
        rough = tmp.roughness;
        metal = tmp.metalness;
        opac = tmp.opacity;
        return;
    }

    if (node) GetWireColor3f(node, col);
}

static uint64_t HashMaterialScalarPreviewValues(const float col[3], float rough, float metal, float opac) {
    uint64_t h = 1469598103934665603ULL;
    h = HashFNV1a(col, sizeof(float) * 3, h);
    h = HashFNV1a(&rough, sizeof(rough), h);
    h = HashFNV1a(&metal, sizeof(metal), h);
    h = HashFNV1a(&opac, sizeof(opac), h);
    return h;
}

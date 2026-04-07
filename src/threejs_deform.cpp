#include "threejs_deform.h"
#include "threejs_deform_res.h"

#include <max.h>
#include <iparamb2.h>
#include <iparamm2.h>
#include <simpmod.h>
#include <plugapi.h>
#include <maxapi.h>

extern HINSTANCE hInstance;

// ===================================================================
//  ThreeJS Deform — Flag modifier for JS layer vertex control
//  No parameters. Presence in modifier stack = "JS owns vertices".
//  C++ sync skips geometry for flagged nodes; layers deform freely.
// ===================================================================

bool IsThreeJSDeformClassID(const Class_ID& cid) {
    return cid == THREEJS_DEFORM_CLASS_ID;
}

namespace {

class ThreeJSDeform;

// -- Class Descriptor ------------------------------------------------

class ThreeJSDeformClassDesc : public ClassDesc2 {
public:
    int         IsPublic() override { return TRUE; }
    void*       Create(BOOL) override;
    const TCHAR* ClassName() override { return _T("three.js Deform"); }
    const TCHAR* NonLocalizedClassName() override { return _T("three.js Deform"); }
    SClass_ID   SuperClassID() override { return OSM_CLASS_ID; }
    Class_ID    ClassID() override { return THREEJS_DEFORM_CLASS_ID; }
    const TCHAR* Category() override { return _T("MaxJS"); }
    const TCHAR* InternalName() override { return _T("ThreeJSDeform"); }
    HINSTANCE   HInstance() override { return hInstance; }
};

static ThreeJSDeformClassDesc deformDesc;

// -- Param Block (empty — modifier is a pure flag) -------------------

static ParamBlockDesc2 deformPBDesc(
    threejs_deform_params, _T("ThreeJS Deform Params"), IDS_THREEJS_DEFORM_PARAMS,
    &deformDesc,
    P_AUTO_CONSTRUCT + P_AUTO_UI,
    0,  // ref index
    IDD_THREEJS_DEFORM, IDS_THREEJS_DEFORM_PARAMS, 0, 0, nullptr,
    p_end
);

// -- ThreeJS Deform Modifier class -----------------------------------

class ThreeJSDeform : public Modifier {
public:
    IParamBlock2* pblock = nullptr;

    ThreeJSDeform() {
        deformDesc.MakeAutoParamBlocks(this);
    }

    // -- Animatable --
    void DeleteThis() override { delete this; }
    Class_ID ClassID() override { return THREEJS_DEFORM_CLASS_ID; }
    SClass_ID SuperClassID() override { return OSM_CLASS_ID; }
    void GetClassName(MSTR& s, bool) const override { s = _T("three.js Deform"); }
    const TCHAR* GetObjectName(bool) const override { return _T("three.js Deform"); }

    int NumSubs() override { return 1; }
    Animatable* SubAnim(int i) override { return i == 0 ? pblock : nullptr; }
    MSTR SubAnimName(int i, bool) override { return i == 0 ? _T("Parameters") : _T(""); }

    int NumRefs() override { return 1; }
    RefTargetHandle GetReference(int i) override { return i == 0 ? pblock : nullptr; }
    void SetReference(int i, RefTargetHandle rtarg) override {
        if (i == 0) pblock = static_cast<IParamBlock2*>(rtarg);
    }

    int NumParamBlocks() override { return 1; }
    IParamBlock2* GetParamBlock(int i) override { return i == 0 ? pblock : nullptr; }
    IParamBlock2* GetParamBlockByID(BlockID id) override {
        return id == threejs_deform_params ? pblock : nullptr;
    }

    RefTargetHandle Clone(RemapDir& remap) override {
        ThreeJSDeform* d = new ThreeJSDeform();
        d->ReplaceReference(0, remap.CloneRef(pblock));
        BaseClone(this, d, remap);
        return d;
    }

    RefResult NotifyRefChanged(const Interval&, RefTargetHandle, PartID&, RefMessage, BOOL) override {
        return REF_SUCCEED;
    }

    // -- Modifier --
    ChannelMask ChannelsUsed() override { return GEOM_CHANNEL; }
    ChannelMask ChannelsChanged() override { return GEOM_CHANNEL; }
    Class_ID InputType() override { return defObjectClassID; }

    void ModifyObject(TimeValue, ModContext&, ObjectState* os, INode*) override {
        os->obj->UpdateValidity(GEOM_CHAN_NUM, FOREVER);
    }

    CreateMouseCallBack* GetCreateMouseCallBack() override { return nullptr; }

    IOResult Save(ISave* isave) override { return Modifier::Save(isave); }
    IOResult Load(ILoad* iload) override { return Modifier::Load(iload); }
};

void* ThreeJSDeformClassDesc::Create(BOOL) { return new ThreeJSDeform(); }

} // namespace

ClassDesc2* GetThreeJSDeformDesc() { return &deformDesc; }

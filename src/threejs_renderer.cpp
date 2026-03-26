#include "threejs_renderer.h"
#include "threejs_material.h"
#include <iparamb2.h>
#include <plugapi.h>
#include <maxapi.h>
#include <bitmap.h>

extern HINSTANCE hInstance;

// Forward — toggle panel from dllmain.cpp
extern void ToggleMaxJSPanel();

// ══════════════════════════════════════════════════════════════
//  ThreeJS Interactive Render (ActiveShade)
//  Opens the MaxJS panel as the "render" output.
// ══════════════════════════════════════════════════════════════

class ThreeJSInteractiveRender : public IInteractiveRender {
    HWND ownerWnd_ = nullptr;
    INode* sceneRoot_ = nullptr;
    INode* viewNode_ = nullptr;
    Bitmap* bitmap_ = nullptr;
    ViewExp* viewExp_ = nullptr;
    IIRenderMgr* renderMgr_ = nullptr;
    bool rendering_ = false;
    bool useViewNode_ = false;
    Box2 region_;

public:
    void BeginSession() override {
        rendering_ = true;
        ToggleMaxJSPanel();
    }
    void EndSession() override { rendering_ = false; }

    void SetOwnerWnd(HWND h) override { ownerWnd_ = h; }
    HWND GetOwnerWnd() const override { return ownerWnd_; }

    void SetIIRenderMgr(IIRenderMgr* m) override { renderMgr_ = m; }
    IIRenderMgr* GetIIRenderMgr(IIRenderMgr*) const override { return renderMgr_; }

    void SetBitmap(Bitmap* b) override { bitmap_ = b; }
    Bitmap* GetBitmap(Bitmap*) const override { return bitmap_; }

    void SetSceneINode(INode* n) override { sceneRoot_ = n; }
    INode* GetSceneINode() const override { return sceneRoot_; }

    void SetUseViewINode(bool b) override { useViewNode_ = b; }
    bool GetUseViewINode() const override { return useViewNode_; }

    void SetViewINode(INode* n) override { viewNode_ = n; }
    INode* GetViewINode() const override { return viewNode_; }

    void SetViewExp(ViewExp* v) override { viewExp_ = v; }
    ViewExp* GetViewExp() const override { return viewExp_; }

    void SetRegion(const Box2& r) override { region_ = r; }
    const Box2& GetRegion() const override { return region_; }

    void SetDefaultLights(DefaultLight*, int) override {}
    const DefaultLight* GetDefaultLights(int& n) const override { n = 0; return nullptr; }

    void SetProgressCallback(IProgressCallback*) override {}
    const IProgressCallback* GetProgressCallback() const override { return nullptr; }

    void Render(Bitmap*) override {}

    ULONG GetNodeHandle(int, int) override { return 0; }
    bool GetScreenBBox(Box2&, INode*) override { return false; }

    ActionTableId GetActionTableId() override { return 0; }
    ActionCallback* GetActionCallback() override { return nullptr; }

    BOOL IsRendering() override { return rendering_; }
    void AbortRender() override { rendering_ = false; }

};

// ══════════════════════════════════════════════════════════════
//  ThreeJS Renderer
// ══════════════════════════════════════════════════════════════

class ThreeJSRenderer : public Renderer {
    ThreeJSInteractiveRender interactiveRender_;

public:
    ThreeJSRenderer() {}

    // ── Animatable ───────────────────────────────────────────
    void DeleteThis() override { delete this; }
    Class_ID ClassID() override { return THREEJS_RENDERER_CLASS_ID; }
    SClass_ID SuperClassID() override { return RENDERER_CLASS_ID; }
    void GetClassName(MSTR& s, bool) const override { s = _T("ThreeJS"); }

    // ── ReferenceMaker ───────────────────────────────────────
    int NumRefs() override { return 0; }
    RefTargetHandle GetReference(int) override { return nullptr; }
    void SetReference(int, RefTargetHandle) override {}
    RefResult NotifyRefChanged(const Interval&, RefTargetHandle,
                               PartID&, RefMessage, BOOL) override {
        return REF_SUCCEED;
    }

    // ── ReferenceTarget ──────────────────────────────────────
    RefTargetHandle Clone(RemapDir& remap) override {
        ThreeJSRenderer* r = new ThreeJSRenderer();
        BaseClone(this, r, remap);
        return r;
    }

    // ── Renderer core ────────────────────────────────────────
    int Open(INode*, INode*, ViewParams*, RendParams&, HWND,
             DefaultLight* = nullptr, int = 0, RendProgressCallback* = nullptr) override {
        return 1;
    }

    int Render(TimeValue, Bitmap*, FrameRendParams&, HWND,
               RendProgressCallback* = nullptr, ViewParams* = nullptr) override {
        // TODO: capture WebView2 panel to bitmap
        return 1;
    }

    void Close(HWND, RendProgressCallback* = nullptr) override {}

    RendParamDlg* CreateParamDialog(IRendParams*, BOOL = FALSE) override {
        return nullptr;  // No render settings dialog yet
    }

    void ResetParams() override {}

    // ── Required overrides ───────────────────────────────────
    bool CompatibleWithAnyRenderElement() const override { return false; }
    bool CompatibleWithRenderElement(IRenderElement&) const override { return false; }

    IInteractiveRender* GetIInteractiveRender() override {
        return &interactiveRender_;
    }

    void GetVendorInformation(MSTR& info) const override { info = _T("MaxJS"); }
    void GetPlatformInformation(MSTR& info) const override { info = _T("Three.js / WebView2"); }

    bool IsStopSupported() const override { return true; }
    void StopRendering() override {}

    Renderer::PauseSupport IsPauseSupported() const override {
        return Renderer::PauseSupport::None;
    }
    void PauseRendering() override {}
    void ResumeRendering() override {}

    bool HasRequirement(Requirement requirement) override {
        switch (requirement) {
            case Requirement::kRequirement_NoVFB: return true;
            case Requirement::kRequirement_DontSaveRenderOutput: return true;
            default: return false;
        }
    }

    // ── I/O ──────────────────────────────────────────────────
    IOResult Save(ISave* isave) override { return Renderer::Save(isave); }
    IOResult Load(ILoad* iload) override { return Renderer::Load(iload); }
};

// ── Class Descriptor ──────────────────────────────────────────

class ThreeJSRendererClassDesc : public ClassDesc2 {
public:
    int IsPublic() override { return TRUE; }
    void* Create(BOOL) override { return new ThreeJSRenderer(); }
    const TCHAR* ClassName() override { return _T("ThreeJS"); }
    const TCHAR* NonLocalizedClassName() override { return _T("ThreeJS"); }
    SClass_ID SuperClassID() override { return RENDERER_CLASS_ID; }
    Class_ID ClassID() override { return THREEJS_RENDERER_CLASS_ID; }
    const TCHAR* Category() override { return _T("MaxJS"); }
    const TCHAR* InternalName() override { return _T("ThreeJSRenderer"); }
    HINSTANCE HInstance() override { return hInstance; }
};

static ThreeJSRendererClassDesc threeJSRendererDesc;
ClassDesc2* GetThreeJSRendererDesc() { return &threeJSRendererDesc; }

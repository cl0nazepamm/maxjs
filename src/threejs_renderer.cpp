#include "threejs_renderer.h"
#include "threejs_material.h"
#include "threejs_renderer_res.h"
#include <custcont.h>
#include <iparamb2.h>
#include <plugapi.h>
#include <maxapi.h>
#include <bitmap.h>
#include <algorithm>
#include <cmath>
#include <cwctype>
#include <filesystem>
#include <locale>
#include <sstream>

extern HINSTANCE hInstance;

// Forward — panel access from maxjs_main.cpp
extern void EnsureMaxJSPanel();
extern void PrepareMaxJSProductionRenderWindow();
extern void RestoreMaxJSProductionRenderWindow();
extern void StartMaxJSActiveShade(Bitmap* target);
extern void StopMaxJSActiveShade();
extern HWND GetMaxJSWebViewHWND();
extern void ReparentMaxJSPanel(HWND newParent);
extern void RestoreMaxJSPanel();
extern void SetMaxJSPathTracingSettings(int samplesPerFrame, float giClamp, bool freezeSync);
extern bool RenderMaxJSFrameToBitmap(Bitmap* target, int width, int height, TimeValue t,
                                     INode* renderViewNode, const ViewParams* renderViewParams,
                                     RendProgressCallback* prog);
extern bool StartMaxJSRenderSequence(const std::wstring& outputPath,
                                     const std::wstring& mime,
                                     int width,
                                     int height,
                                     int startFrame,
                                     int endFrame,
                                     int step,
                                     INode* renderViewNode,
                                     const ViewParams* renderViewParams);

static constexpr int kPathTracingDefaultSamplesPerFrame = 64;
static constexpr int kPathTracingMinSamplesPerFrame = 1;
static constexpr int kPathTracingMaxSamplesPerFrame = 512;
static constexpr float kPathTracingDefaultGIClamp = 8.0f;
static constexpr float kPathTracingMinGIClamp = 1.0f;
static constexpr float kPathTracingMaxGIClamp = 1000.0f;
static constexpr bool kDefaultUseMaxJSOrchestrator = true;
static constexpr USHORT kThreeJSRendererSettingsChunk = 0x5100;

static int ClampPathTracingSamplesPerFrame(int value) {
    return std::clamp(value, kPathTracingMinSamplesPerFrame, kPathTracingMaxSamplesPerFrame);
}

static float ClampPathTracingGIClamp(float value) {
    if (!std::isfinite(value)) return kPathTracingDefaultGIClamp;
    return std::clamp(value, kPathTracingMinGIClamp, kPathTracingMaxGIClamp);
}

static std::wstring ToLowerCopy(std::wstring value) {
    std::transform(value.begin(), value.end(), value.begin(),
        [](wchar_t ch) { return static_cast<wchar_t>(towlower(ch)); });
    return value;
}

static std::wstring BrowserMimeForRenderPath(const std::wstring& path) {
    const std::wstring ext = ToLowerCopy(std::filesystem::path(path).extension().wstring());
    if (ext == L".jpg" || ext == L".jpeg") return L"image/jpeg";
    if (ext == L".webp") return L"image/webp";
    return L"image/png";
}

static bool BrowserCanWriteExtension(const std::wstring& ext) {
    const std::wstring lower = ToLowerCopy(ext);
    return lower == L".png" || lower == L".jpg" || lower == L".jpeg" || lower == L".webp";
}

static std::wstring NormalizeBrowserRenderPath(std::wstring path) {
    std::filesystem::path fsPath(path);
    std::wstring ext = fsPath.extension().wstring();
    if (ext.empty()) {
        path += L".png";
    } else if (!BrowserCanWriteExtension(ext)) {
        fsPath.replace_extension(L".png");
        path = fsPath.wstring();
    }
    return path;
}

static std::wstring DefaultBrowserRenderPath() {
    wchar_t tempDir[MAX_PATH] = {};
    DWORD len = GetTempPathW(MAX_PATH, tempDir);
    std::wstringstream ss;
    if (len > 0 && len < MAX_PATH) ss << tempDir;
    ss << L"maxjs_render.png";
    return ss.str();
}

static std::wstring ResolveBrowserRenderOutputPath(Bitmap* bitmap) {
    BitmapInfo bi;
    bool haveBi = false;
    if (bitmap) {
        bi = bitmap->GetBitmapInfo();
        haveBi = bi.Name() && bi.Name()[0] != 0;
    }

    if (!haveBi) {
        Interface* ip = GetCOREInterface();
        if (ip) {
            bi = ip->GetRendFileBI();
            haveBi = bi.Name() && bi.Name()[0] != 0;
        }
    }

    if (!haveBi) {
        return DefaultBrowserRenderPath();
    }

    BMMGetFullFilename(&bi);

    std::wstring outputPath = bi.Name() ? bi.Name() : L"";
    if (outputPath.empty()) outputPath = DefaultBrowserRenderPath();
    return NormalizeBrowserRenderPath(outputPath);
}

static int TimeValueToFrame(TimeValue t, int ticksPerFrame) {
    if (ticksPerFrame <= 0) ticksPerFrame = std::max(1, GetTicksPerFrame());
    return static_cast<int>(t / ticksPerFrame);
}

static void ResolveBrowserRenderFrameRange(TimeValue renderTime,
                                           int& startFrame,
                                           int& endFrame,
                                           int& step) {
    Interface* ip = GetCOREInterface();
    const int ticksPerFrame = std::max(1, GetTicksPerFrame());
    startFrame = TimeValueToFrame(renderTime, ticksPerFrame);
    endFrame = startFrame;
    step = 1;
    if (!ip) return;

    switch (ip->GetRendTimeType()) {
        case REND_TIMESEGMENT: {
            const Interval animRange = ip->GetAnimRange();
            startFrame = TimeValueToFrame(animRange.Start(), ticksPerFrame);
            endFrame = TimeValueToFrame(animRange.End(), ticksPerFrame);
            break;
        }
        case REND_TIMERANGE:
            startFrame = TimeValueToFrame(ip->GetRendStart(), ticksPerFrame);
            endFrame = TimeValueToFrame(ip->GetRendEnd(), ticksPerFrame);
            break;
        case REND_TIMESINGLE:
        case REND_TIMEPICKUP:
        default:
            break;
    }

    const int nthFrame = std::max(1, ip->GetRendNThFrame());
    step = (endFrame >= startFrame) ? nthFrame : -nthFrame;
}

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
        // Ensure panel exists
        EnsureMaxJSPanel();
        // Reparent WebView2 into the viewport — true GPU compositing
        if (ownerWnd_)
            ReparentMaxJSPanel(ownerWnd_);
    }
    void EndSession() override {
        rendering_ = false;
        RestoreMaxJSPanel();
    }

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
    int renderWidth_ = 0;
    int renderHeight_ = 0;
    bool stopRequested_ = false;
    bool inMaterialEditor_ = false;
    INode* renderViewNode_ = nullptr;
    ViewParams renderViewParams_ = {};
    bool haveRenderViewParams_ = false;
    bool sequenceStarted_ = false;
    int renderStartFrame_ = 0;
    int renderEndFrame_ = 0;
    int renderFrameStep_ = 1;
    int pathTracingSamplesPerFrame_ = kPathTracingDefaultSamplesPerFrame;
    float pathTracingGIClamp_ = kPathTracingDefaultGIClamp;
    bool pathTracingFreezeSync_ = false;
    bool useMaxJSOrchestrator_ = kDefaultUseMaxJSOrchestrator;

public:
    ThreeJSRenderer() {}

    // ── Animatable ───────────────────────────────────────────
    void DeleteThis() override { delete this; }
    Class_ID ClassID() override { return THREEJS_RENDERER_CLASS_ID; }
    SClass_ID SuperClassID() override { return RENDERER_CLASS_ID; }
    void GetClassName(MSTR& s, bool) const override { s = _T("three.js"); }

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
        r->pathTracingSamplesPerFrame_ = pathTracingSamplesPerFrame_;
        r->pathTracingGIClamp_ = pathTracingGIClamp_;
        r->pathTracingFreezeSync_ = pathTracingFreezeSync_;
        r->useMaxJSOrchestrator_ = useMaxJSOrchestrator_;
        BaseClone(this, r, remap);
        return r;
    }

    int GetPathTracingSamplesPerFrame() const { return pathTracingSamplesPerFrame_; }
    float GetPathTracingGIClamp() const { return pathTracingGIClamp_; }
    bool GetPathTracingFreezeSync() const { return pathTracingFreezeSync_; }
    bool GetUseMaxJSOrchestrator() const { return useMaxJSOrchestrator_; }

    void BroadcastPathTracingSettings() const {
        SetMaxJSPathTracingSettings(pathTracingSamplesPerFrame_, pathTracingGIClamp_, pathTracingFreezeSync_);
    }

    void SetPathTracingSettings(int samplesPerFrame, float giClamp, bool freezeSync, bool broadcast = true) {
        pathTracingSamplesPerFrame_ = ClampPathTracingSamplesPerFrame(samplesPerFrame);
        pathTracingGIClamp_ = ClampPathTracingGIClamp(giClamp);
        pathTracingFreezeSync_ = freezeSync;
        if (broadcast) BroadcastPathTracingSettings();
    }

    void SetUseMaxJSOrchestrator(bool enabled) {
        useMaxJSOrchestrator_ = enabled;
    }

    // ── Renderer core ────────────────────────────────────────
    int Open(INode*, INode* vnode, ViewParams* viewPar, RendParams& rp, HWND,
             DefaultLight* = nullptr, int = 0, RendProgressCallback* = nullptr) override {
        renderWidth_ = rp.width;
        renderHeight_ = rp.height;
        stopRequested_ = false;
        sequenceStarted_ = false;
        inMaterialEditor_ = rp.inMtlEdit != FALSE;
        renderViewNode_ = vnode;
        haveRenderViewParams_ = viewPar != nullptr;
        if (viewPar) renderViewParams_ = *viewPar;
        ResolveBrowserRenderFrameRange(0, renderStartFrame_, renderEndFrame_, renderFrameStep_);
        if (inMaterialEditor_) {
            return 1;
        }

        if (useMaxJSOrchestrator_) {
            // The 3ds Max Render button is only the trigger. The WebView stays
            // alive and writes the actual sequence.
            PrepareMaxJSProductionRenderWindow();
        } else {
            // Legacy Max bitmap path: Max owns the frame loop/VFB/output.
            EnsureMaxJSPanel();
        }
        BroadcastPathTracingSettings();
        return 1;
    }

    int Render(TimeValue t, Bitmap* tobm, FrameRendParams&, HWND,
               RendProgressCallback* prog = nullptr, ViewParams* viewPar = nullptr) override {
        if (stopRequested_) return 0;

        int w = tobm ? tobm->Width() : renderWidth_;
        int h = tobm ? tobm->Height() : renderHeight_;
        if (w <= 0 || h <= 0) return 0;

        if (inMaterialEditor_) {
            if (!tobm) return 1;
            BMM_Color_fl swatchColor{};
            swatchColor.r = 0.035f;
            swatchColor.g = 0.035f;
            swatchColor.b = 0.035f;
            swatchColor.a = 1.0f;
            tobm->Fill(swatchColor);
            return 1;
        }

        if (prog) prog->SetTitle(_T("three.js — rendering frame..."));

        const ViewParams* effectiveViewParams = viewPar ? viewPar : (haveRenderViewParams_ ? &renderViewParams_ : nullptr);
        if (!useMaxJSOrchestrator_) {
            if (!tobm) return 0;
            const bool ok = RenderMaxJSFrameToBitmap(tobm, w, h, t, renderViewNode_, effectiveViewParams, prog);
            return ok ? 1 : 0;
        }

        if (sequenceStarted_) return 1;
        sequenceStarted_ = true;

        ResolveBrowserRenderFrameRange(t, renderStartFrame_, renderEndFrame_, renderFrameStep_);
        const std::wstring outputPath = ResolveBrowserRenderOutputPath(tobm);
        const std::wstring mime = BrowserMimeForRenderPath(outputPath);
        const bool ok = StartMaxJSRenderSequence(
            outputPath,
            mime,
            w,
            h,
            renderStartFrame_,
            renderEndFrame_,
            renderFrameStep_,
            renderViewNode_,
            effectiveViewParams);
        return ok ? 1 : 0;
    }

    void Close(HWND, RendProgressCallback* = nullptr) override {
        if (useMaxJSOrchestrator_) RestoreMaxJSProductionRenderWindow();
        stopRequested_ = false;
        sequenceStarted_ = false;
        inMaterialEditor_ = false;
        renderViewNode_ = nullptr;
        haveRenderViewParams_ = false;
    }

    RendParamDlg* CreateParamDialog(IRendParams*, BOOL = FALSE) override;

    void ResetParams() override {
        SetPathTracingSettings(
            kPathTracingDefaultSamplesPerFrame,
            kPathTracingDefaultGIClamp,
            false
        );
        SetUseMaxJSOrchestrator(kDefaultUseMaxJSOrchestrator);
    }

    // ── Required overrides ───────────────────────────────────
    bool CompatibleWithAnyRenderElement() const override { return false; }
    bool CompatibleWithRenderElement(IRenderElement&) const override { return false; }

    IInteractiveRender* GetIInteractiveRender() override {
        return &interactiveRender_;
    }

    void GetVendorInformation(MSTR& info) const override { info = _T("max.js"); }
    void GetPlatformInformation(MSTR& info) const override { info = _T("Three.js / WebView2"); }

    bool IsStopSupported() const override { return true; }
    void StopRendering() override { stopRequested_ = true; }

    Renderer::PauseSupport IsPauseSupported() const override {
        return Renderer::PauseSupport::None;
    }
    void PauseRendering() override {}
    void ResumeRendering() override {}

    bool HasRequirement(Requirement requirement) override {
        switch (requirement) {
            case Requirement::kRequirement_NoVFB: return useMaxJSOrchestrator_;
            case Requirement::kRequirement_DontSaveRenderOutput: return useMaxJSOrchestrator_;
            default: return false;
        }
    }

    // ── I/O ──────────────────────────────────────────────────
    IOResult Save(ISave* isave) override {
        IOResult result = Renderer::Save(isave);
        if (result != IO_OK) return result;

        std::ostringstream payload;
        payload.imbue(std::locale::classic());
        payload << 2 << ' '
                << pathTracingSamplesPerFrame_ << ' '
                << pathTracingGIClamp_ << ' '
                << (pathTracingFreezeSync_ ? 1 : 0) << ' '
                << (useMaxJSOrchestrator_ ? 1 : 0);

        isave->BeginChunk(kThreeJSRendererSettingsChunk);
        result = isave->WriteCString(payload.str().c_str());
        isave->EndChunk();
        return result;
    }

    IOResult Load(ILoad* iload) override {
        IOResult result = Renderer::Load(iload);
        if (result != IO_OK) return result;

        while (IO_OK == (result = iload->OpenChunk())) {
            if (iload->CurChunkID() == kThreeJSRendererSettingsChunk) {
                char* payload = nullptr;
                const IOResult readResult = iload->ReadCStringChunk(&payload);
                if (readResult != IO_OK) {
                    iload->CloseChunk();
                    return readResult;
                }
                if (payload) {
                    int version = 0;
                    int samplesPerFrame = kPathTracingDefaultSamplesPerFrame;
                    float giClamp = kPathTracingDefaultGIClamp;
                    int freezeSync = 0;
                    int useOrchestrator = kDefaultUseMaxJSOrchestrator ? 1 : 0;
                    std::istringstream input(payload);
                    input.imbue(std::locale::classic());
                    if (input >> version >> samplesPerFrame >> giClamp >> freezeSync) {
                        SetPathTracingSettings(samplesPerFrame, giClamp, freezeSync != 0, false);
                        if (version >= 2 && (input >> useOrchestrator)) {
                            SetUseMaxJSOrchestrator(useOrchestrator != 0);
                        }
                    }
                }
            }
            result = iload->CloseChunk();
            if (result != IO_OK) return result;
        }
        return result == IO_END ? IO_OK : result;
    }
};

class ThreeJSRendererParamDlg : public RendParamDlg {
    ThreeJSRenderer* renderer_ = nullptr;
    IRendParams* rendParams_ = nullptr;
    HWND panel_ = nullptr;
    BOOL prog_ = FALSE;
    ISpinnerControl* samplesSpin_ = nullptr;
    ISpinnerControl* giClampSpin_ = nullptr;
    bool updating_ = false;
    int samplesPerFrame_ = kPathTracingDefaultSamplesPerFrame;
    float giClamp_ = kPathTracingDefaultGIClamp;
    bool freezeSync_ = false;
    bool useMaxJSOrchestrator_ = kDefaultUseMaxJSOrchestrator;

public:
    ThreeJSRendererParamDlg(ThreeJSRenderer* renderer, IRendParams* rendParams, BOOL prog)
        : renderer_(renderer), rendParams_(rendParams), prog_(prog) {
        samplesPerFrame_ = renderer_ ? renderer_->GetPathTracingSamplesPerFrame() : kPathTracingDefaultSamplesPerFrame;
        giClamp_ = renderer_ ? renderer_->GetPathTracingGIClamp() : kPathTracingDefaultGIClamp;
        freezeSync_ = renderer_ ? renderer_->GetPathTracingFreezeSync() : false;
        useMaxJSOrchestrator_ = renderer_ ? renderer_->GetUseMaxJSOrchestrator() : kDefaultUseMaxJSOrchestrator;

        panel_ = rendParams_->AddRollupPage(
            hInstance,
            MAKEINTRESOURCE(IDD_THREEJS_RENDERER_PT),
            DialogProc,
            _T("Pathtracing"),
            reinterpret_cast<LPARAM>(this)
        );
    }

    ~ThreeJSRendererParamDlg() override {
        ReleaseControls();
        if (rendParams_ && panel_) {
            rendParams_->DeleteRollupPage(panel_);
            panel_ = nullptr;
        }
    }

    void AcceptParams() override {
        CommitFromControls();
    }

    void RejectParams() override {}
    void DeleteThis() override { delete this; }

private:
    void Init(HWND hWnd) {
        updating_ = true;
        samplesSpin_ = SetupIntSpinner(
            hWnd,
            IDC_RENDERER_PT_SPF_SPIN,
            IDC_RENDERER_PT_SPF_EDIT,
            kPathTracingMinSamplesPerFrame,
            kPathTracingMaxSamplesPerFrame,
            samplesPerFrame_
        );
        if (samplesSpin_) samplesSpin_->SetScale(1.0f);

        giClampSpin_ = SetupFloatSpinner(
            hWnd,
            IDC_RENDERER_PT_GI_CLAMP_SPIN,
            IDC_RENDERER_PT_GI_CLAMP_EDIT,
            kPathTracingMinGIClamp,
            kPathTracingMaxGIClamp,
            giClamp_,
            1.0f
        );
        if (giClampSpin_) giClampSpin_->SetScale(1.0f);

        CheckDlgButton(hWnd, IDC_RENDERER_PT_FREEZE_SYNC, freezeSync_ ? BST_CHECKED : BST_UNCHECKED);
        CheckDlgButton(hWnd, IDC_RENDERER_USE_ORCHESTRATOR, useMaxJSOrchestrator_ ? BST_CHECKED : BST_UNCHECKED);
        if (prog_) {
            EnableWindow(GetDlgItem(hWnd, IDC_RENDERER_PT_SPF_EDIT), FALSE);
            EnableWindow(GetDlgItem(hWnd, IDC_RENDERER_PT_SPF_SPIN), FALSE);
            EnableWindow(GetDlgItem(hWnd, IDC_RENDERER_PT_GI_CLAMP_EDIT), FALSE);
            EnableWindow(GetDlgItem(hWnd, IDC_RENDERER_PT_GI_CLAMP_SPIN), FALSE);
            EnableWindow(GetDlgItem(hWnd, IDC_RENDERER_PT_FREEZE_SYNC), FALSE);
            EnableWindow(GetDlgItem(hWnd, IDC_RENDERER_USE_ORCHESTRATOR), FALSE);
        }
        updating_ = false;
    }

    void ReleaseControls() {
        if (samplesSpin_) {
            ReleaseISpinner(samplesSpin_);
            samplesSpin_ = nullptr;
        }
        if (giClampSpin_) {
            ReleaseISpinner(giClampSpin_);
            giClampSpin_ = nullptr;
        }
    }

    void ReadControls(HWND hWnd) {
        if (samplesSpin_) {
            samplesPerFrame_ = ClampPathTracingSamplesPerFrame(samplesSpin_->GetIVal());
        }
        if (giClampSpin_) {
            giClamp_ = ClampPathTracingGIClamp(giClampSpin_->GetFVal());
        }
        freezeSync_ = IsDlgButtonChecked(hWnd, IDC_RENDERER_PT_FREEZE_SYNC) == BST_CHECKED;
        useMaxJSOrchestrator_ = IsDlgButtonChecked(hWnd, IDC_RENDERER_USE_ORCHESTRATOR) == BST_CHECKED;
    }

    void CommitFromControls(HWND hWnd = nullptr) {
        if (updating_ || prog_ || !renderer_) return;
        if (!hWnd && panel_) hWnd = panel_;
        if (hWnd) ReadControls(hWnd);
        renderer_->SetPathTracingSettings(samplesPerFrame_, giClamp_, freezeSync_, true);
        renderer_->SetUseMaxJSOrchestrator(useMaxJSOrchestrator_);
    }

    INT_PTR WndProc(HWND hWnd, UINT msg, WPARAM wParam, LPARAM lParam) {
        switch (msg) {
        case WM_INITDIALOG:
            Init(hWnd);
            return TRUE;
        case WM_DESTROY:
            ReleaseControls();
            return TRUE;
        case WM_LBUTTONDOWN:
        case WM_MOUSEMOVE:
        case WM_LBUTTONUP:
            if (rendParams_) rendParams_->RollupMouseMessage(hWnd, msg, wParam, lParam);
            return FALSE;
        case WM_COMMAND:
            if (LOWORD(wParam) == IDC_RENDERER_PT_FREEZE_SYNC ||
                LOWORD(wParam) == IDC_RENDERER_USE_ORCHESTRATOR) {
                CommitFromControls(hWnd);
                return TRUE;
            }
            break;
        case CC_SPINNER_CHANGE:
        case CC_SPINNER_BUTTONUP:
            CommitFromControls(hWnd);
            return TRUE;
        }
        return FALSE;
    }

    static INT_PTR CALLBACK DialogProc(HWND hWnd, UINT msg, WPARAM wParam, LPARAM lParam) {
        ThreeJSRendererParamDlg* dlg =
            reinterpret_cast<ThreeJSRendererParamDlg*>(GetWindowLongPtr(hWnd, GWLP_USERDATA));
        if (msg == WM_INITDIALOG) {
            dlg = reinterpret_cast<ThreeJSRendererParamDlg*>(lParam);
            SetWindowLongPtr(hWnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(dlg));
        }
        return dlg ? dlg->WndProc(hWnd, msg, wParam, lParam) : FALSE;
    }
};

RendParamDlg* ThreeJSRenderer::CreateParamDialog(IRendParams* ir, BOOL prog) {
    return new ThreeJSRendererParamDlg(this, ir, prog);
}

// ── Class Descriptor ──────────────────────────────────────────

class ThreeJSRendererClassDesc : public ClassDesc2 {
public:
    int IsPublic() override { return TRUE; }
    void* Create(BOOL) override { return new ThreeJSRenderer(); }
    const TCHAR* ClassName() override { return _T("three.js"); }
    const TCHAR* NonLocalizedClassName() override { return _T("three.js"); }
    SClass_ID SuperClassID() override { return RENDERER_CLASS_ID; }
    Class_ID ClassID() override { return THREEJS_RENDERER_CLASS_ID; }
    const TCHAR* Category() override { return _T("max.js"); }
    const TCHAR* InternalName() override { return _T("ThreeJSRenderer"); }
    HINSTANCE HInstance() override { return hInstance; }
};

static ThreeJSRendererClassDesc threeJSRendererDesc;
ClassDesc2* GetThreeJSRendererDesc() { return &threeJSRendererDesc; }

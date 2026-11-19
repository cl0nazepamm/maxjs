// The viewer's frame inside a native 3ds Max viewport, under 3ds Max's own gizmos.
//
// A Nitrous view fragment (IFixedViewportPipeline, public SDK) supplies the viewport's shaded
// color. Each evaluation it copies the frame the viewer left in the shared buffer
// (maxjs_viewport_stream.h) into a target of its own and hands that on. Everything after shading
// in the view graph still runs, so gizmos, the wireframe overlay and viewport labels draw over
// the frame.
//
// Slot. By default the fragment goes in after 3ds Max's own shading (InsertPostShadingFragment)
// and replaces its color: 3ds Max has drawn the scene, so its overlays are hidden behind the
// scene's depth as in any viewport. It can instead take the place of the shading
// (SetViewportShadingFragment): 3ds Max then draws no scene at all, which is faster, and its
// overlays show through everything.
//
// Viewport. The stream belongs to the viewport it was started in and shows that viewport's view,
// whichever viewport is active.
//
// Color. The viewer's pixels are display values (tone mapped, sRGB encoded). The target the
// viewport hands a shading fragment is linear, in the rendering space, and Nitrous applies the
// viewport's display transform to it afterwards. The frame is therefore converted with the
// inverse of that transform, so the pixels reach the screen unchanged.
//
// Alpha. A shading fragment's color is blended by its alpha (1 is opaque). A post-shading
// fragment's color goes through Nitrous' ForegroundBlend, where alpha is the share of the
// background left visible (0 is opaque).
//
// Latency. With lockstep on, an evaluation whose camera differs from the frame's asks the viewer
// for a frame of that camera and waits for it, so the frame and the gizmos drawn over it come
// from the same view. Without it the viewport shows the newest frame the viewer has sent.
#include "maxjs_viewport_convert.h"
#include "maxjs_viewport_stream.h"

#include <max.h>
#include <maxapi.h>
#include <bitmap.h>
#include <ifnpub.h>
#include <notify.h>

#include <ColorManagement/IColorPipeline.h>
#include <ColorManagement/IColorPipelineMgr.h>
#include <Graphics/FragmentGraph/ConnectionPoint.h>
#include <Graphics/FragmentGraph/Variable.h>
#include <Graphics/FragmentGraph/ViewFragment.h>
#include <Graphics/GraphicsEnums.h>
#include <Graphics/IDisplayCallback.h>
#include <Graphics/IPrimitiveRenderer.h>
#include <Graphics/IViewportViewSetting.h>
#include <Graphics/IVirtualDevice.h>
#include <Graphics/ImmediateFragment.h>
#include <Graphics/TargetHandle.h>
#include <Graphics/ViewSystem/IRenderView2.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <iomanip>
#include <memory>
#include <ppl.h>
#include <sstream>
#include <string>
#include <vector>

using namespace MaxSDK::Graphics;

namespace {

namespace Stream = MaxJSViewportStream;
using namespace MaxJSViewportConvert;

#define MAXJS_VIEWPORT_FRAGMENT_CLASS_ID Class_ID(0x4d4a5646, 0x3d7a11c9)
#define MAXJS_VIEWPORT_INTERFACE Interface_ID(0x4d4a5649, 0x2f6b90e3)

enum ColorMode {
    kColorViewport = 0,  // inverse of the viewport's display transform
    kColorSrgb = 1,      // sRGB decoding
    kColorRaw = 2,       // values as they are
};

struct Settings {
    float scale = 1.0f;            // render size as a share of the viewport's
    bool lockstep = true;
    int lockstepMs = 40;           // longest wait for a requested frame
    // Draw after 3ds Max's own shading instead of in its place. On, 3ds Max still renders the
    // scene underneath, which is what gives its wireframe overlay, helpers and gizmos a scene
    // depth to be hidden behind. Off is faster and leaves them drawn through everything.
    bool postShadingSlot = true;
    bool clearDepth = true;
    bool useAlpha = false;         // let the viewport background show through the frame's alpha
    bool forceRedraw = false;      // repaint with ForceCompleteRedraw instead of one invalidated view
    int colorMode = kColorViewport;
    int maxFps = 0;
};

const std::uint32_t kRowsPerTask = 32;

// Samples the inverse of the viewport's display transform. Exact for a transfer curve (Gamma
// mode, unmanaged) and for a curve plus a change of primaries (an untonemapped OCIO view); a
// tone-mapping view is fitted by that model and reported as approximate.
bool BuildViewportTable(ColorTable& table) {
    using namespace MaxSDK::ColorManagement;
    IColorPipelineMgr* manager = IColorPipelineMgr::GetInstance();
    if (manager == nullptr) {
        return false;
    }
    std::unique_ptr<IColorPipeline> pipeline = manager->GetDefaultViewingPipeline(DisplayViewTarget::kVIEWPORT, true);
    if (!pipeline) {
        return false;
    }
    auto converter = pipeline->GetColorConverter<BMM_Color_fl, BMM_Color_fl>(IColorPipeline::FLAG_OPTIMIZATION_LOSSLESS);
    if (!converter) {
        return false;
    }

    const int kGrays = 256;
    const int probeCodes[4][3] = {{204, 102, 51}, {51, 153, 230}, {128, 128, 26}, {230, 26, 153}};
    std::vector<BMM_Color_fl> samples(kGrays + 3 + 4);
    auto set = [&](size_t index, float r, float g, float b) {
        samples[index].r = r;
        samples[index].g = g;
        samples[index].b = b;
        samples[index].a = 1.0f;
    };
    for (int v = 0; v < kGrays; ++v) {
        const float value = static_cast<float>(v) / 255.0f;
        set(static_cast<size_t>(v), value, value, value);
    }
    set(kGrays + 0, 1, 0, 0);
    set(kGrays + 1, 0, 1, 0);
    set(kGrays + 2, 0, 0, 1);
    for (int p = 0; p < 4; ++p) {
        set(static_cast<size_t>(kGrays + 3 + p), probeCodes[p][0] / 255.0f, probeCodes[p][1] / 255.0f, probeCodes[p][2] / 255.0f);
    }
    converter->ConvertImage(samples.data(), samples.size(), 1);
    for (const BMM_Color_fl& sample : samples) {
        if (!std::isfinite(sample.r) || !std::isfinite(sample.g) || !std::isfinite(sample.b)) {
            return false;
        }
    }

    auto channel = [](const BMM_Color_fl& color, int c) { return c == 0 ? color.r : (c == 1 ? color.g : color.b); };
    const BMM_Color_fl& black = samples[0];
    const BMM_Color_fl& white = samples[kGrays - 1];
    float range = 0.0f;
    for (int c = 0; c < 3; ++c) {
        range = std::max(range, std::fabs(channel(white, c) - channel(black, c)));
    }
    if (range < 1.0e-6f) {
        return false;
    }

    // Independent channels leave a pure primary's other two channels at black.
    float crosstalk = 0.0f;
    for (int p = 0; p < 3; ++p) {
        for (int c = 0; c < 3; ++c) {
            if (c != p) {
                crosstalk = std::max(crosstalk, std::fabs(channel(samples[kGrays + p], c) - channel(black, c)));
            }
        }
    }
    table.separable = crosstalk <= 2.0e-3f * range;
    if (table.separable) {
        for (int c = 0; c < 3; ++c) {
            for (int v = 0; v < kGrays; ++v) {
                table.linear[c][v] = channel(samples[static_cast<size_t>(v)], c);
            }
        }
        table.source = L"viewport display transform";
    } else {
        // One curve shared by the channels, then a matrix whose columns are the primaries.
        float axis[3] = {};
        float axisLength = 0.0f;
        for (int c = 0; c < 3; ++c) {
            axis[c] = channel(white, c) - channel(black, c);
            axisLength += axis[c] * axis[c];
        }
        for (int v = 0; v < kGrays; ++v) {
            float along = 0.0f;
            for (int c = 0; c < 3; ++c) {
                along += (channel(samples[static_cast<size_t>(v)], c) - channel(black, c)) * axis[c];
            }
            const float curve = along / axisLength;
            table.linear[0][v] = table.linear[1][v] = table.linear[2][v] = curve;
        }
        for (int p = 0; p < 3; ++p) {
            for (int c = 0; c < 3; ++c) {
                table.matrix[c * 3 + p] = channel(samples[kGrays + p], c) - channel(black, c);
            }
        }
        float worst = 0.0f;
        for (int p = 0; p < 4; ++p) {
            const float decoded[3] = {table.linear[0][probeCodes[p][0]], table.linear[1][probeCodes[p][1]],
                                      table.linear[2][probeCodes[p][2]]};
            for (int c = 0; c < 3; ++c) {
                const float model = table.matrix[c * 3 + 0] * decoded[0] + table.matrix[c * 3 + 1] * decoded[1] +
                                    table.matrix[c * 3 + 2] * decoded[2];
                worst = std::max(worst, std::fabs(model - channel(samples[static_cast<size_t>(kGrays + 3 + p)], c)));
            }
        }
        table.source = worst <= 0.02f * range ? L"viewport display transform, with primaries"
                                              : L"viewport display transform, approximate (tone-mapping view)";
    }
    FinishTable(table);
    return true;
}

class MaxJSViewportFragment;

struct State {
    bool on = false;
    bool maintaining = false;
    bool repainting = false;
    bool tableValid = false;
    bool redrawCallbackRegistered = false;
    bool notificationsRegistered = false;
    int viewId = -1;
    bool shadingSlot = true;
    FragmentPtr fragment;
    // The viewport's depth target as of the last evaluation in the shading slot.
    TargetHandle depthTarget;
    TargetHandle scratchTarget;
    ImmediateFragment immediate;
    IDisplayCallbackPtr depthClear;
    Settings settings;
    ColorTable table;
    UINT_PTR repaintTimer = 0;

    bool stopRequested = false;
    bool trustAttachment = false;
    unsigned reattachBurst = 0;
    ULONGLONG lastReattachTick = 0;

    std::uint64_t evaluations = 0;
    std::uint64_t framesShown = 0;
    std::uint64_t uploadsFailed = 0;
    std::uint64_t repaints = 0;
    std::uint64_t reattached = 0;
    double uploadMsTotal = 0.0;
    double uploadMsMax = 0.0;
    std::wstring status;
};

// Heap-allocated and never destroyed: static destruction runs after Nitrous is gone. The Nitrous
// objects are released in Shutdown().
State& S() {
    static State* state = new State();
    return *state;
}

const ColorTable& Table() {
    State& s = S();
    if (!s.tableValid) {
        s.table = ColorTable();
        if (s.settings.colorMode == kColorViewport) {
            if (!BuildViewportTable(s.table)) {
                s.table = ColorTable();
                BuildCurveTable(s.table, true);
                s.table.source = L"sRGB decoding (the viewport display transform could not be read)";
            }
        } else {
            BuildCurveTable(s.table, s.settings.colorMode == kColorSrgb);
        }
        s.tableValid = true;
    }
    return s.table;
}

// Converts the frame into the mapped target, rows in parallel.
bool WriteFrame(TargetHandle& target, const Stream::Frame& frame, bool backgroundShare) {
    const TargetFormat format = target.GetFormat();
    const bool isHalf = format == TargetFormatA16B16G16R16F;
    if (!isHalf && format != TargetFormatA32B32G32R32F) {
        return false;
    }
    const size_t bytesPerPixel = isHalf ? 8 : 16;
    size_t rowPitch = 0;
    size_t slicePitch = 0;
    void* bits = target.Map(WriteAcess, rowPitch, slicePitch);
    if (bits == nullptr) {
        return false;
    }
    const bool fits = rowPitch >= static_cast<size_t>(frame.width) * bytesPerPixel;
    if (fits) {
        const State& s = S();
        RowContext context = {};
        context.table = &Table();
        context.redIndex = frame.format == Stream::kFormatBGRA8 ? 2 : 0;
        context.blueIndex = frame.format == Stream::kFormatBGRA8 ? 0 : 2;
        context.useAlpha = s.settings.useAlpha;
        context.premultiplied = (frame.flags & Stream::kFlagPremultiplied) != 0;
        context.backgroundShare = backgroundShare;
        const bool bottomUp = (frame.flags & Stream::kFlagBottomUp) != 0;
        const std::uint32_t height = frame.height;
        const size_t tasks = (height + kRowsPerTask - 1) / kRowsPerTask;
        concurrency::parallel_for(size_t(0), tasks, [&](size_t task) {
            const std::uint32_t first = static_cast<std::uint32_t>(task) * kRowsPerTask;
            const std::uint32_t last = std::min(height, first + kRowsPerTask);
            for (std::uint32_t y = first; y < last; ++y) {
                const std::uint32_t sourceRow = bottomUp ? height - 1 - y : y;
                const std::uint8_t* source = frame.pixels + static_cast<size_t>(sourceRow) * frame.stride;
                std::uint8_t* row = static_cast<std::uint8_t*>(bits) + static_cast<size_t>(y) * rowPitch;
                if (isHalf) {
                    ConvertRowHalf(source, reinterpret_cast<std::uint16_t*>(row), frame.width, context);
                } else {
                    ConvertRowFloat(source, reinterpret_cast<float*>(row), frame.width, context);
                }
            }
        });
    }
    target.UnMap();
    return fits;
}

double NowMs() {
    static LARGE_INTEGER frequency = {};
    if (frequency.QuadPart == 0) {
        QueryPerformanceFrequency(&frequency);
    }
    LARGE_INTEGER now = {};
    QueryPerformanceCounter(&now);
    return static_cast<double>(now.QuadPart) * 1000.0 / static_cast<double>(frequency.QuadPart);
}

// Two target inputs and outputs, color then depth: the contract of a viewport shading fragment.
// In the post-shading slot only the color pair is wired.
class MaxJSViewportFragment : public ViewFragment {
public:
    explicit MaxJSViewportFragment(bool shadingSlot) : mShadingSlot(shadingSlot) {
        const Class_ID types[2] = {TargetHandle::ClassID(), TargetHandle::ClassID()};
        InitializeInputs(2, types);
        InitializeOutputs(2, types);
    }

    Class_ID GetClassID() const override { return MAXJS_VIEWPORT_FRAGMENT_CLASS_ID; }
    std::uint32_t ShownSeq() const { return mSeq; }
    // Converts the frame in the buffer again, after a color or alpha setting changed.
    void ForgetFrame() { mSeq = 0; }

protected:
    bool DoEvaluate(EvaluationContext*) override {
        State& s = S();
        ++s.evaluations;

        TargetHandle colorIn;
        TargetHandle depthIn;
        const bool haveColor = GetSmartHandleInput(colorIn, 0) && colorIn.IsValid();
        const bool haveDepth = GetSmartHandleInput(depthIn, 1) && depthIn.IsValid();

        if (haveColor && s.on) {
            const TargetFormat format = colorIn.GetFormat();
            const float scale = std::clamp(s.settings.scale, 0.1f, 1.0f);
            Stream::SetRenderSize(std::max(16, static_cast<int>(static_cast<float>(colorIn.GetWidth()) * scale + 0.5f)),
                                  std::max(16, static_cast<int>(static_cast<float>(colorIn.GetHeight()) * scale + 0.5f)));

            Stream::Frame frame;
            if (Stream::Acquire(mSeq, s.settings.lockstep ? s.settings.lockstepMs : 0, frame)) {
                const double started = NowMs();
                if (!mTarget.IsValid() || mTarget.GetWidth() != frame.width || mTarget.GetHeight() != frame.height ||
                    mTarget.GetFormat() != format) {
                    mHasContent = false;
                    if (!mTarget.Initialize(frame.width, frame.height, format)) {
                        mTarget.Release();
                    }
                }
                const bool shown = mTarget.IsValid() && WriteFrame(mTarget, frame, !mShadingSlot);
                // Consumed either way: a frame that cannot be shown must not hold the next one back.
                Stream::Release(frame, true);
                mSeq = frame.seq;
                if (shown) {
                    mHasContent = true;
                    ++s.framesShown;
                    const double elapsed = NowMs() - started;
                    s.uploadMsTotal += elapsed;
                    s.uploadMsMax = std::max(s.uploadMsMax, elapsed);
                } else {
                    ++s.uploadsFailed;
                }
            }
        }

        // Until the first frame arrives the viewport keeps its own (empty) color target.
        if (mHasContent && mTarget.IsValid()) {
            SetSmartHandleOutput(mTarget, 0);
        } else if (haveColor) {
            SetSmartHandleOutput(colorIn, 0);
        }
        s.depthTarget = (haveDepth && mShadingSlot) ? depthIn : TargetHandle();
        if (haveDepth) {
            SetSmartHandleOutput(depthIn, 1);
        }
        return true;
    }

private:
    bool mShadingSlot;
    TargetHandle mTarget;
    bool mHasContent = false;
    std::uint32_t mSeq = 0;
};

MaxJSViewportFragment* OurFragment() {
    return static_cast<MaxJSViewportFragment*>(S().fragment.GetPointer());
}

// Clears the viewport's depth and stencil. A repaint that re-evaluates only this fragment and
// what follows it draws the gizmos again over the depth the last frame left; cleared, they are
// tested against nothing, as on a fresh frame.
class DepthClearCallback : public IDisplayCallback {
protected:
    void DoDisplay(TimeValue, IPrimitiveRenderer& renderer, const DisplayCallbackContext&) override {
        State& s = S();
        if (!s.depthTarget.IsValid()) {
            return;
        }
        IVirtualDevice& device = renderer.GetVirtualDevice();
        TargetHandle none;
        device.SetTarget(none, s.depthTarget);
        device.Clear(static_cast<BufferClearFlag>(ClearDepthBuffer | ClearStencilBuffer), AColor(0.0f, 0.0f, 0.0f, 0.0f),
                     1.0f, 0);
    }
};

void ClearDepth() {
    State& s = S();
    if (!s.depthTarget.IsValid()) {
        return;
    }
    if (!s.immediate.IsValid()) {
        // Immediate drawing needs a color target; the clear itself only touches the depth target.
        if (!s.scratchTarget.Initialize(4, 4, TargetFormatA16B16G16R16F) || !s.immediate.Initialize()) {
            s.scratchTarget.Release();
            return;
        }
        s.immediate.SetUseDepthTarget(false);
        s.depthClear = IDisplayCallbackPtr(new DepthClearCallback());
    }
    if (s.immediate.Begin()) {
        s.immediate.SetTarget(s.scratchTarget);
        s.immediate.DrawCallback(s.depthClear);
        s.immediate.End();
    }
}

IFixedViewportPipeline* PipelineFor(ViewExp& viewExp) {
    if (!viewExp.IsAlive()) {
        return nullptr;
    }
    IRenderView2* renderView = static_cast<ViewExp18&>(viewExp).GetRenderView();
    return renderView != nullptr ? renderView->GetFixedViewportPipeline() : nullptr;
}

VisualStyle StyleOf(ViewExp& viewExp) {
    auto* setting = static_cast<IViewportViewSetting*>(viewExp.GetInterface(IVIEWPORT_SETTINGS_INTERFACE_ID));
    return setting != nullptr ? setting->GetViewportVisualStyle() : VisualStyleRealistic;
}

// The stylized styles run their effect on the shaded color, so the frame goes in after shading.
bool IsStylized(VisualStyle style) {
    return style >= VisualStyleInk && style <= VisualStylePastel;
}

bool WantsShadingSlot(ViewExp& viewExp) {
    return !S().settings.postShadingSlot && !IsStylized(StyleOf(viewExp));
}

const wchar_t* StyleName(VisualStyle style) {
    switch (style) {
        case VisualStyleRealistic: return L"Default Shading";
        case VisualStyleShaded: return L"Shaded";
        case VisualStyleFacets: return L"Facets";
        case VisualStyleConsistentColor: return L"Flat Color";
        case VisualStyleHiddenLine: return L"Hidden Line";
        case VisualStyleWireframe: return L"Wireframe";
        case VisualStyleBoundingBox: return L"Bounding Box";
        case VisualStyleClay: return L"Clay";
        default: return IsStylized(style) ? L"Stylized" : L"other";
    }
}

ViewExp& ViewById(int viewId) {
    return GetCOREInterface14()->GetViewExpByID(viewId);
}

bool IsAttached(IFixedViewportPipeline& pipeline, bool shadingSlot) {
    Fragment* ours = S().fragment.GetPointer();
    if (ours == nullptr) {
        return false;
    }
    if (shadingSlot) {
        bool wireframe = false;
        return pipeline.GetViewportShadingFragment(wireframe).GetPointer() == ours;
    }
    for (size_t i = 0; i < pipeline.GetNumPostShadingFragments(); ++i) {
        if (pipeline.GetPostShadingFragment(i).GetPointer() == ours) {
            return true;
        }
    }
    return false;
}

bool Attach(ViewExp& viewExp) {
    State& s = S();
    IFixedViewportPipeline* pipeline = PipelineFor(viewExp);
    if (pipeline == nullptr) {
        return false;
    }
    const bool shadingSlot = WantsShadingSlot(viewExp);
    FragmentPtr fragment(new MaxJSViewportFragment(shadingSlot));
    const bool attached = shadingSlot ? pipeline->SetViewportShadingFragment(fragment, false)
                                      : pipeline->InsertPostShadingFragment(0, fragment);
    if (!attached) {
        return false;
    }
    s.fragment = fragment;
    s.viewId = viewExp.GetViewID();
    s.shadingSlot = shadingSlot;
    return true;
}

void Detach() {
    State& s = S();
    if (s.fragment && s.viewId >= 0) {
        if (IFixedViewportPipeline* pipeline = PipelineFor(ViewById(s.viewId))) {
            if (s.shadingSlot) {
                if (IsAttached(*pipeline, true)) {
                    pipeline->RestoreDefaultShadingFragment();
                }
            } else {
                pipeline->DeletePostShadingFragment(s.fragment);
            }
        }
    }
    s.fragment = FragmentPtr();
    s.depthTarget = TargetHandle();
    s.viewId = -1;
}

void Repaint() {
    State& s = S();
    Interface* ip = GetCOREInterface();
    if (!s.on || s.repainting || ip == nullptr) {
        return;
    }
    s.repainting = true;
    ++s.repaints;
    if (s.settings.clearDepth) {
        ClearDepth();
    }
    if (s.fragment) {
        s.fragment->SetFlag(FragmentFlagsDirty, true);
    }
    if (s.settings.forceRedraw) {
        ip->ForceCompleteRedraw(FALSE);
    } else {
        if (s.viewId >= 0) {
            ViewExp& viewExp = ViewById(s.viewId);
            if (viewExp.IsAlive()) {
                auto* viewExp10 = reinterpret_cast<ViewExp10*>(viewExp.Execute(ViewExp::kEXECUTE_GET_VIEWEXP_10));
                if (viewExp10 != nullptr) {
                    viewExp10->Invalidate();
                }
            }
        }
        ip->RedrawViews(ip->GetTime(), REDRAW_NORMAL);
    }
    s.repainting = false;
}

void CALLBACK DeferredRepaint(HWND, UINT, UINT_PTR id, DWORD) {
    KillTimer(nullptr, id);
    State& s = S();
    s.repaintTimer = 0;
    if (s.stopRequested) {
        s.stopRequested = false;
        std::wstring error;
        Stream::SetOn(false, error);
        return;
    }
    Repaint();
}

void ScheduleRepaint() {
    State& s = S();
    if (s.repaintTimer == 0) {
        s.repaintTimer = SetTimer(nullptr, 0, 0, DeferredRepaint);
    }
}

// Keeps the fragment in its viewport, in the slot that viewport's visual style calls for. The
// stream stays in the viewport it was started in: making another viewport active does not move
// it. Nitrous rebuilds a view's graph on style and layout changes, and a viewport can be
// destroyed.
void Maintain() {
    State& s = S();
    if (!s.on || s.maintaining || s.viewId < 0) {
        return;
    }
    s.maintaining = true;
    bool changed = false;
    ViewExp& current = ViewById(s.viewId);
    IFixedViewportPipeline* pipeline = PipelineFor(current);
    if (pipeline == nullptr) {
        // The viewport is gone, and its pipeline with it: nothing is left to show the frame in.
        // Stopping redraws the views, so it waits until this redraw is over.
        s.fragment = FragmentPtr();
        s.depthTarget = TargetHandle();
        s.stopRequested = true;
        changed = true;
    } else if (WantsShadingSlot(current) != s.shadingSlot) {
        Detach();
        changed = Attach(current);
    } else if (!s.trustAttachment && !IsAttached(*pipeline, s.shadingSlot)) {
        // Nitrous rebuilt the graph without the fragment. Should the pipeline ever stop
        // reporting it at all, attaching again on every redraw would never end: after a few in a
        // row, take the attachment on trust until the stream is switched on again.
        const ULONGLONG now = GetTickCount64();
        s.reattachBurst = now - s.lastReattachTick < 1000 ? s.reattachBurst + 1 : 1;
        s.lastReattachTick = now;
        if (s.reattachBurst > 3) {
            s.trustAttachment = true;
        } else {
            Detach();
            changed = Attach(current);
            ++s.reattached;
        }
    }
    s.maintaining = false;
    if (changed) {
        ScheduleRepaint();
    }
}

class MaintainCallback : public RedrawViewsCallback {
public:
    void proc(Interface*) override { Maintain(); }
};

MaintainCallback gMaintainCallback;

void UnregisterRedrawCallback();

// Everything that must go before Nitrous does. Notifications stay registered: this also runs
// from inside one.
void ReleaseNitrousObjects() {
    State& s = S();
    if (s.on) {
        s.on = false;
        Detach();
    }
    if (s.repaintTimer != 0) {
        KillTimer(nullptr, s.repaintTimer);
        s.repaintTimer = 0;
    }
    UnregisterRedrawCallback();
    s.fragment = FragmentPtr();
    s.depthTarget = TargetHandle();
    s.scratchTarget = TargetHandle();
    s.immediate = ImmediateFragment();
    s.depthClear = IDisplayCallbackPtr();
}

void OnNotify(void*, NotifyInfo* info) {
    if (info == nullptr) {
        return;
    }
    State& s = S();
    switch (info->intcode) {
        case NOTIFY_SYSTEM_SHUTDOWN:
            ReleaseNitrousObjects();
            break;
        case NOTIFY_COLOR_MANAGEMENT_POST_CHANGE2:
            s.tableValid = false;
            if (s.on) {
                if (MaxJSViewportFragment* fragment = OurFragment()) {
                    fragment->ForgetFrame();
                }
                ScheduleRepaint();
            }
            break;
        default:
            break;
    }
}

void RegisterCallbacks() {
    State& s = S();
    Interface* ip = GetCOREInterface();
    if (!s.redrawCallbackRegistered && ip != nullptr) {
        ip->RegisterRedrawViewsCallback(&gMaintainCallback);
        s.redrawCallbackRegistered = true;
    }
    if (!s.notificationsRegistered) {
        RegisterNotification(OnNotify, nullptr, NOTIFY_SYSTEM_SHUTDOWN);
        RegisterNotification(OnNotify, nullptr, NOTIFY_COLOR_MANAGEMENT_POST_CHANGE2);
        s.notificationsRegistered = true;
    }
}

void UnregisterRedrawCallback() {
    State& s = S();
    Interface* ip = GetCOREInterface();
    if (s.redrawCallbackRegistered && ip != nullptr) {
        ip->UnRegisterRedrawViewsCallback(&gMaintainCallback);
    }
    s.redrawCallbackRegistered = false;
}

// A setting that changes how a frame is converted: convert the one in the buffer again.
void ConversionChanged() {
    State& s = S();
    s.tableValid = false;
    if (s.on) {
        if (MaxJSViewportFragment* fragment = OurFragment()) {
            fragment->ForgetFrame();
        }
        Repaint();
    }
}

std::wstring StatusReport() {
    State& s = S();
    std::wostringstream out;
    out.imbue(std::locale::classic());
    out << L"max.js GPU Viewport: " << (s.on ? L"on" : L"off");
    if (s.on) {
        out << L", view id " << s.viewId;
        if (s.viewId >= 0) {
            ViewExp& viewExp = ViewById(s.viewId);
            if (viewExp.IsAlive()) {
                const VisualStyle style = StyleOf(viewExp);
                out << L" [" << StyleName(style) << L"]";
                if (style == VisualStyleWireframe || style == VisualStyleBoundingBox) {
                    out << L" (3ds Max draws this style itself: switch to a shaded style to see the frame)";
                }
            }
        }
        out << L", " << (s.shadingSlot ? L"shading" : L"post-shading") << L" slot";
        if (Interface* ip = GetCOREInterface()) {
            out << (ip->GetActiveViewExp().GetViewID() == s.viewId ? L", the active viewport" : L", not the active viewport");
        }
    }
    out << L"\n  settings: scale=" << s.settings.scale << L" lockstep=" << (s.settings.lockstep ? L"on" : L"off")
        << L" lockstepMs=" << s.settings.lockstepMs << L" postShadingSlot=" << (s.settings.postShadingSlot ? L"on" : L"off")
        << L" clearDepth=" << (s.settings.clearDepth ? L"on" : L"off") << L" useAlpha=" << (s.settings.useAlpha ? L"on" : L"off")
        << L" forceRedraw=" << (s.settings.forceRedraw ? L"on" : L"off") << L" maxFps=" << s.settings.maxFps;
    out << L"\n  color: " << (s.tableValid ? s.table.source : std::wstring(L"not built yet"));
    out << L"\n  fragment: evaluations=" << s.evaluations << L" framesShown=" << s.framesShown << L" uploadsFailed="
        << s.uploadsFailed << L" repaints=" << s.repaints << L" reattached=" << s.reattached;
    if (s.trustAttachment) {
        out << L" (the pipeline stopped reporting the fragment; no longer re-attaching)";
    }
    if (s.framesShown > 0) {
        out << std::fixed << std::setprecision(2) << L" uploadMs(avg=" << (s.uploadMsTotal / static_cast<double>(s.framesShown))
            << L" max=" << s.uploadMsMax << L")";
    }
    out << L"\n  " << Stream::Status();
    return out.str();
}

// ── MAXScript: MaxJSViewport ──────────────────────────────────────────────────────────────────

class MaxJSViewportInterface : public FPStaticInterface {
public:
    DECLARE_DESCRIPTOR(MaxJSViewportInterface)

    enum FunctionIds {
        kOn,
        kOff,
        kToggle,
        kStatus,
        kGetIsOn,
        kGetIsOnActiveViewport,
        kGetScale,
        kSetScale,
        kGetLockstep,
        kSetLockstep,
        kGetLockstepMs,
        kSetLockstepMs,
        kGetPostShadingSlot,
        kSetPostShadingSlot,
        kGetClearDepth,
        kSetClearDepth,
        kGetUseAlpha,
        kSetUseAlpha,
        kGetColorMode,
        kSetColorMode,
        kGetMaxFps,
        kSetMaxFps,
        kGetForceRedraw,
        kSetForceRedraw,
    };

    enum EnumIds {
        kEnumColorMode,
    };

    BEGIN_FUNCTION_MAP
        FN_0(kOn, TYPE_bool, On)
        FN_0(kOff, TYPE_bool, Off)
        FN_0(kToggle, TYPE_bool, Toggle)
        FN_0(kStatus, TYPE_STRING, Status)
        RO_PROP_FN(kGetIsOn, GetIsOn, TYPE_bool)
        RO_PROP_FN(kGetIsOnActiveViewport, GetIsOnActiveViewport, TYPE_bool)
        PROP_FNS(kGetScale, GetScale, kSetScale, SetScale, TYPE_FLOAT)
        PROP_FNS(kGetLockstep, GetLockstep, kSetLockstep, SetLockstep, TYPE_bool)
        PROP_FNS(kGetLockstepMs, GetLockstepMs, kSetLockstepMs, SetLockstepMs, TYPE_INT)
        PROP_FNS(kGetPostShadingSlot, GetPostShadingSlot, kSetPostShadingSlot, SetPostShadingSlot, TYPE_bool)
        PROP_FNS(kGetClearDepth, GetClearDepth, kSetClearDepth, SetClearDepth, TYPE_bool)
        PROP_FNS(kGetUseAlpha, GetUseAlpha, kSetUseAlpha, SetUseAlpha, TYPE_bool)
        PROP_FNS(kGetColorMode, GetColorMode, kSetColorMode, SetColorMode, TYPE_ENUM)
        PROP_FNS(kGetMaxFps, GetMaxFps, kSetMaxFps, SetMaxFps, TYPE_INT)
        PROP_FNS(kGetForceRedraw, GetForceRedraw, kSetForceRedraw, SetForceRedraw, TYPE_bool)
    END_FUNCTION_MAP

    bool On() { return Switch(true); }
    // Returns whether it was on.
    bool Off() {
        const bool wasOn = S().on;
        Switch(false);
        return wasOn;
    }
    // What a menu entry does: off in the viewport that shows the frame, on anywhere else, which
    // moves a running stream to the active viewport.
    bool Toggle() {
        Switch(!GetIsOnActiveViewport());
        return S().on;
    }
    const MCHAR* Status() {
        S().status = StatusReport();
        return S().status.c_str();
    }
    bool GetIsOn() { return S().on; }
    bool GetIsOnActiveViewport() {
        const State& s = S();
        Interface* ip = GetCOREInterface();
        return s.on && ip != nullptr && ip->GetActiveViewExp().GetViewID() == s.viewId;
    }

    float GetScale() { return S().settings.scale; }
    void SetScale(float value) {
        S().settings.scale = std::clamp(value, 0.1f, 1.0f);
        Repaint();
    }
    bool GetLockstep() { return S().settings.lockstep; }
    void SetLockstep(bool value) { S().settings.lockstep = value; }
    int GetLockstepMs() { return S().settings.lockstepMs; }
    void SetLockstepMs(int value) { S().settings.lockstepMs = std::clamp(value, 1, 500); }
    bool GetPostShadingSlot() { return S().settings.postShadingSlot; }
    void SetPostShadingSlot(bool value) {
        S().settings.postShadingSlot = value;
        Maintain();
        Repaint();
    }
    bool GetClearDepth() { return S().settings.clearDepth; }
    void SetClearDepth(bool value) {
        S().settings.clearDepth = value;
        Repaint();
    }
    bool GetUseAlpha() { return S().settings.useAlpha; }
    void SetUseAlpha(bool value) {
        S().settings.useAlpha = value;
        ConversionChanged();
    }
    int GetColorMode() { return S().settings.colorMode; }
    void SetColorMode(int value) {
        S().settings.colorMode = std::clamp(value, static_cast<int>(kColorViewport), static_cast<int>(kColorRaw));
        ConversionChanged();
    }
    bool GetForceRedraw() { return S().settings.forceRedraw; }
    void SetForceRedraw(bool value) {
        S().settings.forceRedraw = value;
        Repaint();
    }
    int GetMaxFps() { return S().settings.maxFps; }
    void SetMaxFps(int value) {
        S().settings.maxFps = std::clamp(value, 0, 240);
        if (S().on) {
            Stream::SetMaxFps(S().settings.maxFps);
        }
    }

private:
    bool Switch(bool on) {
        std::wstring error;
        const bool ok = Stream::SetOn(on, error);
        if (!ok && !error.empty()) {
            S().status = L"max.js GPU Viewport: " + error;
            if (Interface* ip = GetCOREInterface()) {
                ip->DisplayTempPrompt(S().status.c_str(), 5000);
            }
        }
        return ok;
    }
};

MaxJSViewportInterface gMaxJSViewportInterface(
    MAXJS_VIEWPORT_INTERFACE, _T("MaxJSViewport"), 0, nullptr, FP_CORE,
    MaxJSViewportInterface::kOn, _T("on"), 0, TYPE_bool, 0, 0,
    MaxJSViewportInterface::kOff, _T("off"), 0, TYPE_bool, 0, 0,
    MaxJSViewportInterface::kToggle, _T("toggle"), 0, TYPE_bool, 0, 0,
    MaxJSViewportInterface::kStatus, _T("status"), 0, TYPE_STRING, FP_NO_REDRAW, 0,
    properties,
    MaxJSViewportInterface::kGetIsOn, FP_NO_FUNCTION, _T("isOn"), 0, TYPE_bool,
    MaxJSViewportInterface::kGetIsOnActiveViewport, FP_NO_FUNCTION, _T("isOnActiveViewport"), 0, TYPE_bool,
    MaxJSViewportInterface::kGetScale, MaxJSViewportInterface::kSetScale, _T("scale"), 0, TYPE_FLOAT,
    MaxJSViewportInterface::kGetLockstep, MaxJSViewportInterface::kSetLockstep, _T("lockstep"), 0, TYPE_bool,
    MaxJSViewportInterface::kGetLockstepMs, MaxJSViewportInterface::kSetLockstepMs, _T("lockstepMs"), 0, TYPE_INT,
    MaxJSViewportInterface::kGetPostShadingSlot, MaxJSViewportInterface::kSetPostShadingSlot, _T("postShadingSlot"), 0, TYPE_bool,
    MaxJSViewportInterface::kGetClearDepth, MaxJSViewportInterface::kSetClearDepth, _T("clearDepth"), 0, TYPE_bool,
    MaxJSViewportInterface::kGetUseAlpha, MaxJSViewportInterface::kSetUseAlpha, _T("useAlpha"), 0, TYPE_bool,
    MaxJSViewportInterface::kGetColorMode, MaxJSViewportInterface::kSetColorMode, _T("colorMode"), 0, TYPE_ENUM,
        MaxJSViewportInterface::kEnumColorMode,
    MaxJSViewportInterface::kGetMaxFps, MaxJSViewportInterface::kSetMaxFps, _T("maxFps"), 0, TYPE_INT,
    MaxJSViewportInterface::kGetForceRedraw, MaxJSViewportInterface::kSetForceRedraw, _T("forceRedraw"), 0, TYPE_bool,
    enums,
    MaxJSViewportInterface::kEnumColorMode, 3,
        _T("viewport"), kColorViewport,
        _T("srgb"), kColorSrgb,
        _T("raw"), kColorRaw,
    p_end);

}  // namespace

// ── Entry points for the panel ────────────────────────────────────────────────────────────────

namespace MaxJSViewportStream {

bool IsOn() {
    return S().on;
}

int ViewId() {
    const State& s = S();
    return s.on ? s.viewId : -1;
}

bool SetOn(bool on, std::wstring& error) {
    State& s = S();
    Interface* ip = GetCOREInterface();
    if (ip == nullptr) {
        error = L"3ds Max is not ready";
        return false;
    }
    if (on && s.on) {
        // Already running: switching it on again moves it to the viewport that is active now.
        ViewExp& active = ip->GetActiveViewExp();
        if (PipelineFor(active) != nullptr && active.GetViewID() != s.viewId) {
            Detach();
            if (!Attach(active)) {
                error = L"3ds Max did not accept the viewport fragment";
                SetOn(false, error);
                return false;
            }
            if (MaxJSViewportFragment* fragment = OurFragment()) {
                fragment->ForgetFrame();
            }
            ip->ForceCompleteRedraw(FALSE);
        }
        return true;
    }
    if (on == s.on) {
        return true;
    }
    if (on) {
        ViewExp& viewExp = ip->GetActiveViewExp();
        if (PipelineFor(viewExp) == nullptr) {
            error = L"the active viewport is not a Nitrous 3D view";
            return false;
        }
        GraphicsWindow* gw = viewExp.getGW();
        const float scale = std::clamp(s.settings.scale, 0.1f, 1.0f);
        const int width = gw != nullptr ? static_cast<int>(static_cast<float>(gw->getWinSizeX()) * scale + 0.5f) : 0;
        const int height = gw != nullptr ? static_cast<int>(static_cast<float>(gw->getWinSizeY()) * scale + 0.5f) : 0;
        if (!Start(std::max(16, width), std::max(16, height), error)) {
            return false;
        }
        SetMaxFps(s.settings.maxFps);
        if (!Attach(viewExp)) {
            Stop();
            error = L"3ds Max did not accept the viewport fragment";
            return false;
        }
        s.on = true;
        s.evaluations = s.framesShown = s.uploadsFailed = s.repaints = s.reattached = 0;
        s.trustAttachment = false;
        s.reattachBurst = 0;
        s.uploadMsTotal = s.uploadMsMax = 0.0;
        RegisterCallbacks();
        Repaint();
        return true;
    }

    s.on = false;
    UnregisterRedrawCallback();
    Detach();
    Stop();
    ip->ForceCompleteRedraw(FALSE);
    return true;
}

void OnFrameAvailable() {
    State& s = S();
    MaxJSViewportFragment* fragment = OurFragment();
    if (!s.on || fragment == nullptr) {
        return;
    }
    // A frame the viewport waited for is on screen already.
    if (HasNewFrame(fragment->ShownSeq())) {
        Repaint();
    }
}

void OnPanelClosing() {
    std::wstring error;
    SetOn(false, error);
}

void Shutdown() {
    State& s = S();
    ReleaseNitrousObjects();
    if (s.notificationsRegistered) {
        UnRegisterNotification(OnNotify, nullptr, NOTIFY_SYSTEM_SHUTDOWN);
        UnRegisterNotification(OnNotify, nullptr, NOTIFY_COLOR_MANAGEMENT_POST_CHANGE2);
        s.notificationsRegistered = false;
    }
}

}  // namespace MaxJSViewportStream

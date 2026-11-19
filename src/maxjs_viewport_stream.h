#pragma once

// Viewport stream: the viewer's rendered frame shown inside a native 3ds Max viewport.
//
// The viewer (web/js/editor/viewport_stream.js) copies each rendered frame into one persistent
// WebView2 shared buffer. A Nitrous viewport fragment (maxjs_viewport_fragment.cpp) replaces the
// viewport's own shading with that frame, so 3ds Max draws its gizmos and overlays on top of it.
//
// Shared buffer layout, little-endian. Both sides read and write the header.
//   u32[16] header, then the pixels (rows of `stride` bytes, 4 bytes per pixel).

#include <cstdint>
#include <string>

namespace MaxJSViewportStream {

constexpr uint32_t kMagic = 0x46564A4D;  // 'MJVF'
constexpr uint32_t kVersion = 1;
constexpr uint32_t kHeaderBytes = 64;

enum HeaderWord : uint32_t {
    kWordMagic = 0,
    kWordVersion = 1,
    kWordCapacity = 2,      // pixel bytes available after the header (host)
    kWordFrameSeq = 3,      // sequence of the frame in the buffer, never 0 once a frame exists (viewer)
    kWordWidth = 4,         // viewer
    kWordHeight = 5,        // viewer
    kWordStride = 6,        // bytes per row (viewer)
    kWordFormat = 7,        // PixelFormat (viewer)
    kWordFlags = 8,         // FrameFlags (viewer)
    kWordRequestEcho = 9,   // newest host request this frame was rendered for (viewer)
    kWordAckSeq = 10,       // last frame sequence the host copied (host)
    kWordLock = 11,         // LockState, taken with compare-exchange by either side
    kWordCount = 16,
};

enum PixelFormat : uint32_t {
    kFormatRGBA8 = 0,
    kFormatBGRA8 = 1,
};

enum FrameFlags : uint32_t {
    kFlagBottomUp = 1,       // first row in the buffer is the bottom row of the image
    kFlagPremultiplied = 2,  // color is premultiplied by alpha
};

enum LockState : uint32_t {
    kLockFree = 0,
    kLockViewerWriting = 1,
    kLockHostReading = 2,
};

// A frame the host holds the buffer lock for, from Acquire to Release.
struct Frame {
    const uint8_t* pixels = nullptr;
    uint32_t width = 0;
    uint32_t height = 0;
    uint32_t stride = 0;
    uint32_t format = kFormatRGBA8;
    uint32_t flags = 0;
    uint32_t seq = 0;
};

// ── Implemented by the WebView2 panel (maxjs_main.cpp). Main thread only. ──

// Opens the panel if needed and tells the viewer to stream frames of this size.
bool Start(int width, int height, std::wstring& error);
void Stop();
// The size the viewer should render at. Cheap when unchanged.
void SetRenderSize(int width, int height);
// Frame rate limit for frames the viewer sends on its own; 0 leaves it at the display rate.
void SetMaxFps(int fps);
// True when the buffer holds a frame other than `lastSeq`.
bool HasNewFrame(uint32_t lastSeq);
// Locks the buffer and returns its frame when it differs from `lastSeq`. With `lockstepMs` > 0 and
// a camera that moved since the last frame, first asks the viewer for a frame of the current view
// and waits up to that long for it.
bool Acquire(uint32_t lastSeq, int lockstepMs, Frame& frame);
// Unlocks the buffer. `consumed` acknowledges the frame so the viewer sends the next one.
void Release(const Frame& frame, bool consumed);
std::wstring Status();

// ── Implemented by maxjs_viewport_fragment.cpp. Main thread only. ──

// The viewer published a frame: repaint the viewport that shows it.
void OnFrameAvailable();
// The panel is going away; the viewport returns to 3ds Max's own shading.
void OnPanelClosing();
// Releases every Nitrous object. Called when the plug-in stops.
void Shutdown();
bool IsOn();
bool SetOn(bool on, std::wstring& error);
// The id of the viewport the stream is locked to, or -1 while it is off. The frame is that
// viewport's view, whichever viewport is active.
int ViewId();

}  // namespace MaxJSViewportStream

// ══════════════════════════════════════════════════════════════
//  Panel toggle + MAXScript bridge
// ══════════════════════════════════════════════════════════════

static void KillPanel() {
    if (!g_panel) return;
    g_panel->Destroy();
    delete g_panel;
    g_panel = nullptr;
}

static void RequestGlobalPanelKill() {
    if (g_helperHwnd && IsWindow(g_helperHwnd)) {
        PostMessage(g_helperHwnd, WM_KILL_PANEL, 0, 0);
        return;
    }
    KillPanel();
}

void MaxJSNotifyMaterialEdited(ReferenceTarget* target) {
    if (g_panel) g_panel->NotifyMaterialEditedTarget(target);
}

void TogglePanel() {
    Interface* ip = GetCOREInterface();
    if (g_panel && g_panel->IsViewportHosted() && ip && ip->IsViewportMaxed()) {
        KillPanel();
        return;
    }

    if (!g_panel) {
        g_panel = new MaxJSPanel();
        g_panel->Create(ip ? ip->GetMAXHWnd() : nullptr);
    } else if (g_panel->hwnd_ && IsWindowVisible(g_panel->hwnd_)) {
        ShowWindow(g_panel->hwnd_, SW_HIDE);
    } else if (g_panel->hwnd_) {
        ShowWindow(g_panel->hwnd_, SW_SHOW);
        g_panel->NormalizeFloatingWindow(true);
        g_panel->ReloadWebContent();
    } else {
        g_panel->Create(ip ? ip->GetMAXHWnd() : nullptr);
    }
}

void ToggleMaxJSPanel() { TogglePanel(); }

static void PumpPanelMessages(DWORD durationMs) {
    const DWORD start = GetTickCount();
    do {
        MSG msg;
        while (PeekMessage(&msg, nullptr, 0, 0, PM_REMOVE)) {
            TranslateMessage(&msg);
            DispatchMessage(&msg);
        }
        Sleep(1);
    } while (GetTickCount() - start < durationMs);
}

// Ensure panel exists and is visible (non-toggling)
static void EnsurePanel() {
    Interface* ip = GetCOREInterface();
    if (!g_panel) {
        g_panel = new MaxJSPanel();
        g_panel->Create(ip ? ip->GetMAXHWnd() : nullptr);
    } else if (g_panel->hwnd_ && !IsWindowVisible(g_panel->hwnd_)) {
        ShowWindow(g_panel->hwnd_, SW_SHOW);
        g_panel->NormalizeFloatingWindow(true);
    } else if (!g_panel->hwnd_) {
        g_panel->Create(ip ? ip->GetMAXHWnd() : nullptr);
    }
}
void EnsureMaxJSPanel() { EnsurePanel(); }

void PrepareMaxJSProductionRenderWindow() {
    EnsurePanel();
    if (g_panel) {
        g_panel->PrepareProductionRenderWindow();
        PumpPanelMessages(50);
    }
}

void RestoreMaxJSProductionRenderWindow() {
    if (g_panel) g_panel->RestoreProductionRenderWindow();
}

void ExportMaxJSSnapshot() {
    EnsurePanel();
    if (g_panel) g_panel->RequestSnapshotExport();
}

void SetMaxJSPathTracingSettings(int samplesPerFrame, float giClamp, bool freezeSync) {
    g_pathTracingSamplesPerFrame = std::clamp(samplesPerFrame, 1, 64);
    if (!std::isfinite(giClamp)) giClamp = 20.0f;
    g_pathTracingGIClamp = std::clamp(giClamp, 1.0f, 1000.0f);
    g_pathTracingFreezeSync = freezeSync;
    if (g_panel) {
        g_panel->SetPathTracingSettings(
            g_pathTracingSamplesPerFrame,
            g_pathTracingGIClamp,
            g_pathTracingFreezeSync
        );
    }
}

void StartMaxJSActiveShade(Bitmap* target) {
    if (!g_panel) EnsurePanel();
    if (g_panel) g_panel->StartActiveShade(target);
}
void StopMaxJSActiveShade() {
    if (g_panel) g_panel->StopActiveShade();
}
HWND GetMaxJSWebViewHWND() {
    return g_panel ? g_panel->hwnd_ : nullptr;
}
void ReparentMaxJSPanel(HWND newParent) {
    if (!g_panel) TogglePanel();
    if (g_panel) g_panel->ReparentIntoViewport(newParent);
}
void RestoreMaxJSPanel() {
    if (g_panel) g_panel->RestoreFromViewport();
}
bool RenderMaxJSFrameToBitmap(Bitmap* target, int width, int height, TimeValue t, RendProgressCallback* prog) {
    EnsurePanel();
    if (!g_panel) return false;
    return g_panel->RenderFrameToBitmap(target, width, height, t, nullptr, nullptr, prog);
}
bool RenderMaxJSFrameToBitmap(Bitmap* target, int width, int height, TimeValue t,
                              INode* renderViewNode, const ViewParams* renderViewParams,
                              RendProgressCallback* prog) {
    EnsurePanel();
    if (!g_panel) return false;
    return g_panel->RenderFrameToBitmap(target, width, height, t, renderViewNode, renderViewParams, prog);
}
bool StartMaxJSRenderSequence(const std::wstring& outputPath,
                              const std::wstring& mime,
                              int width,
                              int height,
                              int startFrame,
                              int endFrame,
                              int step,
                              INode* renderViewNode,
                              const ViewParams* renderViewParams) {
    EnsurePanel();
    if (!g_panel) return false;
    return g_panel->StartRenderSequence(outputPath, mime, width, height,
        startFrame, endFrame, step, renderViewNode, renderViewParams);
}

static void RegisterMaxScript() {
    wchar_t script[4096];
    swprintf_s(script, 4096,
        L"global MaxJS_HWND = %lld\r\n"
        L"fn MaxJS_KillPanel = ( windows.sendMessage MaxJS_HWND %d 0 0 )\r\n"
        L"fn MaxJS_ExportSnapshot = ( windows.sendMessage MaxJS_HWND %d 0 0 )\r\n"
        L"macroScript MaxJS_Toggle category:\"max.js\" tooltip:\"Toggle max.js Viewport\" buttonText:\"max.js\" (\r\n"
        L"    windows.sendMessage MaxJS_HWND %d 0 0\r\n"
        L")\r\n"
        L"macroScript MaxJS_Kill category:\"max.js\" tooltip:\"Kill max.js Viewport\" buttonText:\"Kill max.js\" (\r\n"
        L"    windows.sendMessage MaxJS_HWND %d 0 0\r\n"
        L")\r\n"
        L"macroScript MaxJS_Snapshot category:\"max.js\" tooltip:\"Export max.js Snapshot\" buttonText:\"Snapshot\" (\r\n"
        L"    windows.sendMessage MaxJS_HWND %d 0 0\r\n"
        L")\r\n"
        L"if menuMan != undefined and menuMan.findMenu \"max.js\" == undefined do (\r\n"
        L"    local subMenu = menuMan.createMenu \"max.js\"\r\n"
        L"    local toggleItem = menuMan.createActionItem \"MaxJS_Toggle\" \"max.js\"\r\n"
        L"    local killItem = menuMan.createActionItem \"MaxJS_Kill\" \"max.js\"\r\n"
        L"    local snapshotItem = menuMan.createActionItem \"MaxJS_Snapshot\" \"max.js\"\r\n"
        L"    subMenu.addItem toggleItem -1\r\n"
        L"    subMenu.addItem snapshotItem -1\r\n"
        L"    subMenu.addItem killItem -1\r\n"
        L"    local mainMenu = menuMan.getMainMenuBar()\r\n"
        L"    local subMenuItem = menuMan.createSubMenuItem \"max.js\" subMenu\r\n"
        L"    mainMenu.addItem subMenuItem 0\r\n"
        L"    menuMan.updateMenuBar()\r\n"
        L")\r\n",
        (long long)(intptr_t)g_helperHwnd,
        (int)WM_KILL_PANEL,
        (int)WM_EXPORT_SNAPSHOT,
        (int)WM_TOGGLE_PANEL,
        (int)WM_KILL_PANEL,
        (int)WM_EXPORT_SNAPSHOT);
    ExecuteMAXScriptScript(script, MAXScript::ScriptSource::NonEmbedded);
}

static LRESULT CALLBACK HelperWndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    switch (msg) {
    case WM_TOGGLE_PANEL: TogglePanel(); return 0;
    case WM_KILL_PANEL: KillPanel(); return 0;
    case WM_EXPORT_SNAPSHOT: ExportMaxJSSnapshot(); return 0;
    case WM_TIMER:
        if (wParam == SETUP_TIMER_ID) { KillTimer(hwnd, SETUP_TIMER_ID); RegisterMaxScript(); }
        return 0;
    }
    return DefWindowProc(hwnd, msg, wParam, lParam);
}

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
    g_pathTracingSamplesPerFrame = std::clamp(samplesPerFrame, 1, 512);
    if (!std::isfinite(giClamp)) giClamp = 8.0f;
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
    wchar_t script[8192];
    swprintf_s(script, 8192,
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
        L"macroScript MaxJS_RefreshInstances category:\"max.js\" tooltip:\"Send Dirty Signal\" buttonText:\"Send Dirty Signal\" (\r\n"
        L"    windows.sendMessage MaxJS_HWND %d 0 0\r\n"
        L")\r\n"
        // Menu registration targets the 2025+ CUI menu system (legacy menuMan
        // was removed there, so the pre-2026 path is gone on every supported
        // target). Menus are rebuilt from the #cuiRegisterMenus callback on
        // every configuration load; the GUIDs are stable so user
        // customizations attached to the items survive rebuilds. The guarded
        // LoadConfiguration covers the case where this GUP registers after
        // the menu bar was already built (first install, no restart).
        L"callbacks.removeScripts id:#maxjsMenus\r\n"
        L"global maxjs_registerMenus\r\n"
        L"fn maxjs_registerMenus = (\r\n"
        L"    local menuMgr = callbacks.notificationParam()\r\n"
        L"    local mainBar = menuMgr.mainMenuBar\r\n"
        L"    local subMenu = mainBar.CreateSubMenu \"{80E4C769-A2CB-4862-9925-FF51611A3B0F}\" \"max.js\"\r\n"
        L"    subMenu.CreateMacroScriptAction \"{792F423F-6E43-4C16-83E2-841C26556502}\" \"MaxJS_Toggle\" \"max.js\" title:\"max.js\"\r\n"
        L"    subMenu.CreateMacroScriptAction \"{792A1612-3D6F-46C2-AE4B-224362BB1C13}\" \"MaxJS_Snapshot\" \"max.js\" title:\"Snapshot\"\r\n"
        L"    subMenu.CreateMacroScriptAction \"{0DC622F5-7777-493C-B89C-909E0D5CBB49}\" \"MaxJS_RefreshInstances\" \"max.js\" title:\"Send Dirty Signal\"\r\n"
        L"    subMenu.CreateMacroScriptAction \"{4B9D5C3D-1288-411A-9CCD-B156680171BE}\" \"MaxJS_Kill\" \"max.js\" title:\"Kill max.js\"\r\n"
        L")\r\n"
        L"callbacks.addScript #cuiRegisterMenus \"maxjs_registerMenus()\" id:#maxjsMenus\r\n"
        L"try (\r\n"
        L"    local mgr = maxOps.GetICuiMenuMgr()\r\n"
        L"    if mgr.GetMenuById \"{80E4C769-A2CB-4862-9925-FF51611A3B0F}\" == undefined do (\r\n"
        L"        mgr.LoadConfiguration (mgr.GetCurrentConfiguration())\r\n"
        L"    )\r\n"
        L") catch ()\r\n",
        (long long)(intptr_t)g_helperHwnd,
        (int)WM_KILL_PANEL,
        (int)WM_EXPORT_SNAPSHOT,
        (int)WM_TOGGLE_PANEL,
        (int)WM_KILL_PANEL,
        (int)WM_EXPORT_SNAPSHOT,
        (int)WM_REFRESH_INSTANCES);
    ExecuteMAXScriptScript(script, MAXScript::ScriptSource::NonEmbedded);
}

static LRESULT CALLBACK HelperWndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    switch (msg) {
    case WM_TOGGLE_PANEL: TogglePanel(); return 0;
    case WM_KILL_PANEL: KillPanel(); return 0;
    case WM_EXPORT_SNAPSHOT: ExportMaxJSSnapshot(); return 0;
    case WM_REFRESH_INSTANCES: if (g_panel) g_panel->RequestFullSceneRepair(); return 0;
    case WM_TIMER:
        if (wParam == SETUP_TIMER_ID) { KillTimer(hwnd, SETUP_TIMER_ID); RegisterMaxScript(); }
        return 0;
    }
    return DefWindowProc(hwnd, msg, wParam, lParam);
}

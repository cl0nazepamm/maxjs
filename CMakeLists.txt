cmake_minimum_required(VERSION 3.20)

# ╔══════════════════════════════════════════════════════════════╗
# ║  MaxJS — Three.js Viewport for 3ds Max via WebView2          ║
# ╚══════════════════════════════════════════════════════════════╝
set(PLUGIN_NAME "maxjs")
set(PLUGIN_TYPE "gup")

project(${PLUGIN_NAME} VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
string(REPLACE "\\" "/" MAXJS_SOURCE_WEB_DIR "${CMAKE_CURRENT_SOURCE_DIR}/web")

# ── Max SDK ──────────────────────────────────────────────────────
if(NOT DEFINED MAXSDK_PATH)
    set(MAXSDK_PATH "C:/Program Files/Autodesk/3ds Max 2026 SDK/maxsdk"
        CACHE PATH "Path to 3ds Max SDK")
endif()

if(NOT EXISTS "${MAXSDK_PATH}/include/max.h")
    message(FATAL_ERROR "Cannot find max.h at ${MAXSDK_PATH}/include/max.h. Set -DMAXSDK_PATH=...")
endif()

# ── WebView2 SDK (run setup_webview2.bat first) ─────────────────
set(WEBVIEW2_DIR "${CMAKE_CURRENT_SOURCE_DIR}/thirdparty/webview2/build/native")

if(NOT EXISTS "${WEBVIEW2_DIR}/include/WebView2.h")
    message(FATAL_ERROR
        "WebView2 SDK not found at ${WEBVIEW2_DIR}\n"
        "Run setup_webview2.bat to download it.")
endif()

# ── Sources ──────────────────────────────────────────────────────
file(GLOB_RECURSE SOURCES CONFIGURE_DEPENDS "src/*.cpp" "src/*.rc")
add_library(${PLUGIN_NAME} SHARED ${SOURCES})

# ── Output as plugin extension ───────────────────────────────────
set_target_properties(${PLUGIN_NAME} PROPERTIES
    SUFFIX ".${PLUGIN_TYPE}"
    OUTPUT_NAME "${PLUGIN_NAME}"
)

if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/src/${PLUGIN_NAME}.def")
    target_sources(${PLUGIN_NAME} PRIVATE "src/${PLUGIN_NAME}.def")
endif()

# ── Includes ─────────────────────────────────────────────────────
target_include_directories(${PLUGIN_NAME} PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/include"
    "${MAXSDK_PATH}/include"
    "${WEBVIEW2_DIR}/include"
)

# ── Preprocessor ─────────────────────────────────────────────────
target_compile_definitions(${PLUGIN_NAME} PRIVATE
    NOMINMAX
    _UNICODE UNICODE
    WIN32 _WIN32
    _USRDLL
    _CRT_SECURE_NO_WARNINGS
    MAXJS_SOURCE_WEB_DIR="${MAXJS_SOURCE_WEB_DIR}"
)

# ── Link ─────────────────────────────────────────────────────────
target_link_directories(${PLUGIN_NAME} PRIVATE
    "${MAXSDK_PATH}/lib/x64/Release"
    "${WEBVIEW2_DIR}/x64"
)

target_link_libraries(${PLUGIN_NAME} PRIVATE
    # Max SDK
    core.lib
    maxutil.lib
    gup.lib
    Paramblk2.lib
    Geom.lib
    mesh.lib
    bmm.lib
    Maxscrpt.lib
    poly.lib
    MNMath.lib
    comctl32.lib
    comdlg32.lib
    shlwapi.lib
    # WebView2
    WebView2LoaderStatic.lib
)

# ── MSVC settings ────────────────────────────────────────────────
if(MSVC)
    target_compile_options(${PLUGIN_NAME} PRIVATE /W3 /MP /EHa)
    set_property(TARGET ${PLUGIN_NAME} PROPERTY MSVC_RUNTIME_LIBRARY
        "MultiThreaded$<$<CONFIG:Debug>:Debug>DLL")
endif()

# ── Deploy to Max ────────────────────────────────────────────────
set(MAX_PLUGINS_DIR "C:/Program Files/Autodesk/3ds Max 2026/plugins"
    CACHE PATH "3ds Max plugins directory")

install(TARGETS ${PLUGIN_NAME}
    RUNTIME DESTINATION "${MAX_PLUGINS_DIR}"
    LIBRARY DESTINATION "${MAX_PLUGINS_DIR}"
)

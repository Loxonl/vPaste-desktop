// C contract between Rust (process owner) and the native DEV demo window.
//
// macOS implements it in Swift (macos/NativeDemoWindow.swift) and Windows in
// C++ Win32 (windows/NativeDemoWindow.cpp). Rust calls
// `vpaste_native_demo_show` on the main thread and passes this callback table;
// the window calls back into the shared Rust logic through it. Mirrored by
// `Callbacks` in src/native_demo/ffi.rs; keep both in sync.

#ifndef VPASTE_NATIVE_DEMO_BRIDGE_H
#define VPASTE_NATIVE_DEMO_BRIDGE_H

#ifdef __APPLE__
#include "../native-panel/NativePanelBridge.h"
#endif
#include <stdbool.h>
#include <stdint.h>

#if defined(__clang__)
#define VPASTE_NULLABLE _Nullable
#pragma clang assume_nonnull begin
#else
#define VPASTE_NULLABLE
#endif

#ifdef __cplusplus
extern "C" {
#endif

typedef struct VPasteRustCallbacks {
    /// Returns an owned UTF-8 string; release it with `free_string`.
    char *VPASTE_NULLABLE (*describe_text)(const char *text);
    double (*opacity_for_slider)(double value);
    char *VPASTE_NULLABLE (*opacity_label)(double opacity);
    char *VPASTE_NULLABLE (*interaction_label)(uint32_t count);
    void (*free_string)(char *VPASTE_NULLABLE value);
    void (*set_key_window)(bool key);
    double min_opacity_percent;
} VPasteRustCallbacks;

/// Shows the window, creating it on first use. Main thread only. The table is
/// copied during the call.
void vpaste_native_demo_show(const VPasteRustCallbacks *callbacks);

#ifdef __cplusplus
}
#endif

#if defined(__clang__)
#pragma clang assume_nonnull end
#endif

#endif

#ifndef VPASTE_NATIVE_PANEL_BRIDGE_H
#define VPASTE_NATIVE_PANEL_BRIDGE_H
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
// All buffers are borrowed for the duration of the call. Both sides copy before
// returning; no allocator, Swift object or NUL-terminated clipboard text crosses.
typedef struct VPastePanelCallbacks {
    uint32_t abi_version;
    void (*request)(const uint8_t *bytes, size_t length);
    void (*set_key)(bool key);
} VPastePanelCallbacks;
// Rust calls these on the AppKit main thread. Swift copies the callback table.
void vpaste_native_panel_show(const VPastePanelCallbacks *callbacks, const uint8_t *config, size_t length);
void vpaste_native_panel_receive(const uint8_t *response, size_t length);
void vpaste_native_panel_close(bool animated);
bool vpaste_native_panel_activate(bool toggle);
#endif

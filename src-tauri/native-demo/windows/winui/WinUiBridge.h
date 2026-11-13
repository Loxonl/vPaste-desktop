#pragma once
#include <cstddef>
#include <cstdint>

namespace vpaste::winui {
// Must match winui_panel/bridge.rs. The loader checks this before initialization.
inline constexpr std::uint32_t BridgeVersion = 1;
inline constexpr std::size_t MaxRequestBytes = 16 * 1024;
inline constexpr std::size_t MaxResponseBytes = 4 * 1024 * 1024;
}

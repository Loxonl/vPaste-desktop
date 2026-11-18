#pragma once
#ifdef _DEBUG
#include <windows.h>
#include <psapi.h>
#include <cstdio>

namespace vpaste::winui {
inline bool TraceCardMedia() {
    // Local, opt-in profiling of synthetic data; never print paths or hashes.
    static const bool enabled = GetEnvironmentVariableW(L"VPASTE_WINUI_MEDIA_PROBE", nullptr, 0) != 0;
    return enabled;
}
// Component-harness counters, never a substitute for a full app/process-tree
// comparison. No working-set trimming or forced collection is performed.
inline void RecordNativeResources(char const *phase) {
    PROCESS_MEMORY_COUNTERS_EX memory{};
    memory.cb = sizeof(memory);
    winrt::check_bool(GetProcessMemoryInfo(GetCurrentProcess(),
        reinterpret_cast<PROCESS_MEMORY_COUNTERS *>(&memory), sizeof(memory)));
    DWORD handles = 0;
    winrt::check_bool(GetProcessHandleCount(GetCurrentProcess(), &handles));
    std::printf("WinUI resources: {\"phase\":\"%s\",\"privateCommitBytes\":%llu,\"workingSetBytes\":%llu,\"handles\":%lu,\"userObjects\":%lu,\"gdiObjects\":%lu}\n",
        phase, static_cast<unsigned long long>(memory.PrivateUsage),
        static_cast<unsigned long long>(memory.WorkingSetSize), handles,
        GetGuiResources(GetCurrentProcess(), GR_USEROBJECTS), GetGuiResources(GetCurrentProcess(), GR_GDIOBJECTS));
}
}
#endif

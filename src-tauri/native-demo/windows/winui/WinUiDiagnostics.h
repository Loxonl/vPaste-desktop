#pragma once

#include <windows.h>

#include <algorithm>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>

namespace vpaste::winui {

// 单份 WinUI 脱敏诊断日志的默认大小上限（1 MiB），超限时轮转为 .prev.log。
inline constexpr std::uint64_t kDefaultMaxDiagnosticsLogBytes = 1024ull * 1024ull;
// 动态错误文本的最大保留字节数，防止异常消息过长或夹杂无关控制字符。
inline constexpr std::size_t kMaxDiagnosticMessageBytes = 256;

// 清洗并截断诊断消息：去除换行与 ASCII 控制字符，保证单行可解析且不劈断 UTF-8 多字节序列。
inline std::string SanitizeDiagnosticText(
    std::string_view input,
    std::size_t maxBytes = kMaxDiagnosticMessageBytes) {
    std::string clean;
    clean.reserve(std::min(input.size(), maxBytes));
    bool lastWasSpace = false;
    for (std::size_t index = 0; index < input.size(); ++index) {
        const unsigned char byte = static_cast<unsigned char>(input[index]);
        if (byte == '\r' || byte == '\n' || byte == '\t' || byte < 0x20 || byte == 0x7F) {
            if (!clean.empty() && !lastWasSpace) {
                if (clean.size() + 1 > maxBytes) break;
                clean.push_back(' ');
                lastWasSpace = true;
            }
            continue;
        }
        // 计算当前 UTF-8 字符的字节长度，确保截断时停在完整码点边界。
        std::size_t charLen = 1;
        if ((byte & 0x80) == 0) {
            charLen = 1;
        } else if ((byte & 0xE0) == 0xC0) {
            charLen = 2;
        } else if ((byte & 0xF0) == 0xE0) {
            charLen = 3;
        } else if ((byte & 0xF8) == 0xF0) {
            charLen = 4;
        }
        if (index + charLen > input.size()) break;
        if (clean.size() + charLen > maxBytes) break;
        clean.append(input.substr(index, charLen));
        index += charLen - 1;
        lastWasSpace = (byte == ' ');
    }
    while (!clean.empty() && clean.back() == ' ') {
        clean.pop_back();
    }
    return clean;
}

// 推导轮转备份文件路径，例如 winui-diagnostics.log -> winui-diagnostics.prev.log。
inline std::wstring PreviousDiagnosticsLogPath(std::wstring const &path) {
    const auto slash = path.find_last_of(L"\\/");
    const auto dot = path.find_last_of(L'.');
    if (dot != std::wstring::npos && (slash == std::wstring::npos || dot > slash)) {
        return path.substr(0, dot) + L".prev" + path.substr(dot);
    }
    return path + L".prev";
}

// 轻量脱敏诊断日志写入器：追加写入、超限轮转并立即 FlushFileBuffers，确保 FailFast 前数据落盘。
class DiagnosticsLogger {
public:
    void SetPath(std::wstring path, std::uint64_t maxBytes = kDefaultMaxDiagnosticsLogBytes) noexcept {
        try {
            std::lock_guard lock(mutex_);
            path_ = std::move(path);
            maxBytes_ = maxBytes > 0 ? maxBytes : kDefaultMaxDiagnosticsLogBytes;
        } catch (...) {}
    }

    std::wstring Path() const noexcept {
        try {
            std::lock_guard lock(mutex_);
            return path_;
        } catch (...) {
            return {};
        }
    }

    bool WriteLine(std::string_view eventName, std::string_view details) noexcept {
        try {
            std::wstring path;
            std::uint64_t maxBytes = kDefaultMaxDiagnosticsLogBytes;
            {
                std::lock_guard lock(mutex_);
                if (path_.empty()) return false;
                path = path_;
                maxBytes = maxBytes_;
            }

            SYSTEMTIME utc{};
            GetSystemTime(&utc);
            char prefix[128]{};
            const int prefixLen = std::snprintf(
                prefix, sizeof(prefix),
                "[%04u-%02u-%02uT%02u:%02u:%02u.%03uZ] pid=%lu tid=%lu event=%.*s",
                static_cast<unsigned>(utc.wYear),
                static_cast<unsigned>(utc.wMonth),
                static_cast<unsigned>(utc.wDay),
                static_cast<unsigned>(utc.wHour),
                static_cast<unsigned>(utc.wMinute),
                static_cast<unsigned>(utc.wSecond),
                static_cast<unsigned>(utc.wMilliseconds),
                static_cast<unsigned long>(GetCurrentProcessId()),
                static_cast<unsigned long>(GetCurrentThreadId()),
                static_cast<int>(eventName.size()),
                eventName.data());
            if (prefixLen <= 0) return false;

            std::string line(prefix, static_cast<std::size_t>(prefixLen));
            if (!details.empty()) {
                line.push_back(' ');
                line.append(details);
            }
            line.push_back('\n');

            std::lock_guard lock(mutex_);
            if (path_.empty()) return false;
            EnsureParentDirectory(path_);
            RotateIfNeededLocked(path_, line.size(), maxBytes_);

            HANDLE file = CreateFileW(
                path_.c_str(),
                FILE_APPEND_DATA | SYNCHRONIZE,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                nullptr,
                OPEN_ALWAYS,
                FILE_ATTRIBUTE_NORMAL,
                nullptr);
            if (file == INVALID_HANDLE_VALUE) return false;

            DWORD written = 0;
            const BOOL ok = WriteFile(
                file,
                line.data(),
                static_cast<DWORD>(line.size()),
                &written,
                nullptr);
            if (ok) {
                (void)FlushFileBuffers(file);
            }
            CloseHandle(file);
            return ok != FALSE && written == line.size();
        } catch (...) {
            return false;
        }
    }

private:
    static void EnsureParentDirectory(std::wstring const &path) noexcept {
        const auto slash = path.find_last_of(L"\\/");
        if (slash == std::wstring::npos || slash == 0) return;
        const std::wstring dir = path.substr(0, slash);
        (void)CreateDirectoryW(dir.c_str(), nullptr);
    }

    static void RotateIfNeededLocked(
        std::wstring const &path,
        std::size_t incomingBytes,
        std::uint64_t maxBytes) noexcept {
        WIN32_FILE_ATTRIBUTE_DATA info{};
        if (!GetFileAttributesExW(path.c_str(), GetFileExInfoStandard, &info)) {
            return;
        }
        const std::uint64_t currentSize =
            (static_cast<std::uint64_t>(info.nFileSizeHigh) << 32) |
            static_cast<std::uint64_t>(info.nFileSizeLow);
        if (currentSize == 0 || currentSize + incomingBytes <= maxBytes) {
            return;
        }
        const std::wstring previousPath = PreviousDiagnosticsLogPath(path);
        (void)MoveFileExW(
            path.c_str(),
            previousPath.c_str(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH);
    }

    mutable std::mutex mutex_;
    std::wstring path_;
    std::uint64_t maxBytes_ = kDefaultMaxDiagnosticsLogBytes;
};

struct PowerResumeContext {
    std::uint64_t suspendCount = 0;
    std::uint64_t resumeCount = 0;
    std::uint64_t sleepDurationMs = 0;
    std::uint64_t elapsedSinceResumeMs = 0;
    bool userResume = false;
};

struct PowerLifecycleSnapshot {
    std::uint64_t suspendCount = 0;
    std::uint64_t resumeCount = 0;
    std::uint64_t sleepDurationMs = 0;
    std::uint64_t elapsedSinceSuspendMs = 0;
    std::uint64_t elapsedSinceResumeMs = 0;
    bool suspended = false;
    bool pendingFirstShow = false;
    bool userResume = false;
};

// 纯内存原子电源生命周期状态机：
// 供 WM_POWERBROADCAST(PBT_APMSUSPEND / PBT_APMRESUME*) 零锁更新，严禁触发任何 WinRT/XAML/DWM/I/O 调用。
class PowerLifecycleTracker {
public:
    void OnSuspend(std::uint64_t nowMs) noexcept {
        lastSuspendTickMs_.store(nowMs, std::memory_order_release);
        suspended_.store(true, std::memory_order_release);
        suspendCount_.fetch_add(1, std::memory_order_acq_rel);
    }

    void OnResume(std::uint64_t nowMs, bool userResume) noexcept {
        const auto suspendTick = lastSuspendTickMs_.load(std::memory_order_acquire);
        const std::uint64_t sleepMs =
            (suspendTick > 0 && nowMs >= suspendTick) ? (nowMs - suspendTick) : 0;
        lastSleepDurationMs_.store(sleepMs, std::memory_order_release);
        lastResumeTickMs_.store(nowMs, std::memory_order_release);
        lastResumeUser_.store(userResume, std::memory_order_release);
        suspended_.store(false, std::memory_order_release);
        pendingFirstShow_.store(true, std::memory_order_release);
        resumeCount_.fetch_add(1, std::memory_order_acq_rel);
    }

    std::optional<PowerResumeContext> ConsumeFirstShowAfterResume(std::uint64_t nowMs) noexcept {
        if (!pendingFirstShow_.exchange(false, std::memory_order_acq_rel)) {
            return std::nullopt;
        }
        const auto resumeTick = lastResumeTickMs_.load(std::memory_order_acquire);
        PowerResumeContext context{};
        context.suspendCount = suspendCount_.load(std::memory_order_acquire);
        context.resumeCount = resumeCount_.load(std::memory_order_acquire);
        context.sleepDurationMs = lastSleepDurationMs_.load(std::memory_order_acquire);
        context.elapsedSinceResumeMs =
            (resumeTick > 0 && nowMs >= resumeTick) ? (nowMs - resumeTick) : 0;
        context.userResume = lastResumeUser_.load(std::memory_order_acquire);
        return context;
    }

    PowerLifecycleSnapshot Snapshot(std::uint64_t nowMs) const noexcept {
        PowerLifecycleSnapshot snapshot{};
        const auto suspendTick = lastSuspendTickMs_.load(std::memory_order_acquire);
        const auto resumeTick = lastResumeTickMs_.load(std::memory_order_acquire);
        snapshot.suspendCount = suspendCount_.load(std::memory_order_acquire);
        snapshot.resumeCount = resumeCount_.load(std::memory_order_acquire);
        snapshot.sleepDurationMs = lastSleepDurationMs_.load(std::memory_order_acquire);
        snapshot.elapsedSinceSuspendMs =
            (suspendTick > 0 && nowMs >= suspendTick) ? (nowMs - suspendTick) : 0;
        snapshot.elapsedSinceResumeMs =
            (resumeTick > 0 && nowMs >= resumeTick) ? (nowMs - resumeTick) : 0;
        snapshot.suspended = suspended_.load(std::memory_order_acquire);
        snapshot.pendingFirstShow = pendingFirstShow_.load(std::memory_order_acquire);
        snapshot.userResume = lastResumeUser_.load(std::memory_order_acquire);
        return snapshot;
    }

    void Reset() noexcept {
        suspendCount_.store(0, std::memory_order_release);
        resumeCount_.store(0, std::memory_order_release);
        lastSuspendTickMs_.store(0, std::memory_order_release);
        lastResumeTickMs_.store(0, std::memory_order_release);
        lastSleepDurationMs_.store(0, std::memory_order_release);
        suspended_.store(false, std::memory_order_release);
        pendingFirstShow_.store(false, std::memory_order_release);
        lastResumeUser_.store(false, std::memory_order_release);
    }

private:
    std::atomic<std::uint64_t> suspendCount_{0};
    std::atomic<std::uint64_t> resumeCount_{0};
    std::atomic<std::uint64_t> lastSuspendTickMs_{0};
    std::atomic<std::uint64_t> lastResumeTickMs_{0};
    std::atomic<std::uint64_t> lastSleepDurationMs_{0};
    std::atomic<bool> suspended_{false};
    std::atomic<bool> pendingFirstShow_{false};
    std::atomic<bool> lastResumeUser_{false};
};

} // namespace vpaste::winui

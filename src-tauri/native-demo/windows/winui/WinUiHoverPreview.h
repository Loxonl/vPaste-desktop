#pragma once
#include <cstdint>
#include <functional>
#include <memory>
#include <string>

namespace vpaste::winui {
// Matches the shipping hover delays; this controller never owns window geometry.
class HoverPreview {
public:
    using Request = std::function<void(const std::wstring &, const std::wstring &)>;
    HoverPreview(Request request, std::function<bool()> allowed);
    ~HoverPreview();
    HoverPreview(HoverPreview const &) = delete;
    HoverPreview &operator=(HoverPreview const &) = delete;
    void Enter(std::wstring const &hash, std::wstring const &type);
    void Leave();
    void PreviewPointer(bool inside);
    void Cancel();
#ifdef _DEBUG
    void TestShow();
    void TestClose();
    bool TestPending() const;
#endif
private:
    struct Impl;
    std::shared_ptr<Impl> impl_;
};
#ifdef _DEBUG
void TestHoverPreview(std::uint32_t &stage);
#endif
}

#pragma once
#include <cstdint>
#include <functional>
#include <memory>
#include <winrt/Microsoft.UI.Xaml.h>
#include <winrt/Windows.Data.Json.h>

namespace vpaste::winui {
class OnboardingView {
public:
    using Request = std::function<std::uint64_t(wchar_t const *, winrt::Windows::Data::Json::JsonObject const &)>;
    OnboardingView(winrt::Windows::Data::Json::JsonObject const &data, Request request);
    ~OnboardingView();
    winrt::Microsoft::UI::Xaml::FrameworkElement Root() const;
    std::uint64_t Session() const;
    bool Preview() const;
    void Update(winrt::Windows::Data::Json::JsonObject const &data, std::uint64_t request);
    void Shown();
    bool CancelPreview();
private:
    struct Impl;
    std::shared_ptr<Impl> impl_;
};
}

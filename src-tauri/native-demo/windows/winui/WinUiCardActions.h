#pragma once
#include <windows.h>
#include <shobjidl.h>
#undef GetCurrentTime
#include <winrt/Windows.Data.Json.h>
#include <winrt/Microsoft.UI.Xaml.Controls.h>
#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <utility>

namespace vpaste::winui {
using CardActionRequest = std::function<std::uint64_t(
    const std::wstring &, const std::wstring &, const std::wstring &)>;

struct CardMenuExtras {
    winrt::Microsoft::UI::Xaml::Controls::MenuFlyoutItem exportImage{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::MenuFlyoutSubItem colors{nullptr};
    winrt::Microsoft::UI::Xaml::Controls::MenuFlyoutItem pastePlain{nullptr};
};

CardMenuExtras AppendCardActions(
    winrt::Microsoft::UI::Xaml::Controls::MenuFlyout const &menu,
    std::wstring const &hash, winrt::hstring const &type, bool hasTags,
    bool english, CardActionRequest request);
void UpdateCardActions(CardMenuExtras const &menu,
    winrt::Windows::Data::Json::JsonObject const &metadata,
    std::wstring const &hash, CardActionRequest request);

// One HWND-owned native picker. All methods run on the island's STA.
class ImageExport {
public:
    using Report = std::function<void(const std::wstring &, bool)>;
    ImageExport(HWND owner, CardActionRequest request, Report report);
    ~ImageExport();
    void Start(std::wstring const &hash);
    void Receive(winrt::Windows::Data::Json::JsonObject const &response);
    void Cancel() noexcept;
    bool Active() const noexcept { return busy_; }
#ifdef _DEBUG
    using Chooser = std::function<std::optional<std::wstring>(std::wstring const &)>;
    void SetTestChooser(Chooser chooser) { testChooser_ = std::move(chooser); }
#endif
private:
    std::optional<std::wstring> Choose(std::wstring const &name);
    HWND owner_;
    CardActionRequest request_;
    Report report_;
    bool busy_ = false;
    std::uint64_t pending_ = 0, generation_ = 0;
    std::wstring hash_, operation_;
    winrt::com_ptr<IFileSaveDialog> dialog_;
#ifdef _DEBUG
    Chooser testChooser_;
#endif
};
}

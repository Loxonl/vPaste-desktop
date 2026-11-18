#include "WinUiCardActions.h"
#include "WinUiAppearance.h"
#include <shlobj.h>
#include <winrt/Microsoft.UI.Xaml.h>
#include <winrt/Microsoft.UI.Xaml.Controls.Primitives.h>
#include <memory>
#include <utility>

namespace vpaste::winui {
using namespace winrt::Microsoft::UI::Xaml;
using namespace winrt::Microsoft::UI::Xaml::Controls;
using namespace winrt::Windows::Data::Json;

CardMenuExtras AppendCardActions(MenuFlyout const &menu, std::wstring const &hash,
    winrt::hstring const &type, bool hasTags, bool english, CardActionRequest request) {
    CardMenuExtras extras;
    auto add = [&](const wchar_t *zh, const wchar_t *en, const wchar_t *glyph, const wchar_t *operation) {
        MenuFlyoutItem item;
        item.Text(english ? en : zh);
        item.Icon(Glyph(glyph));
        item.Click([request, hash, operation = std::wstring{operation}](auto const &, auto const &) {
            (void)request(operation, hash, {});
        });
        menu.Items().Append(item);
        return item;
    };
    const bool text = type == L"Text" || type == L"TextFile" || type == L"Link";
    if (text || type == L"Image" || type == L"File" || type == L"Color" || hasTags)
        menu.Items().Append(MenuFlyoutSeparator{});
    if (text) {
        add(L"复制为纯文本", L"Copy as plain text", L"\uE8A5", L"copyPlain");
        extras.pastePlain = add(L"粘贴为纯文本", L"Paste as plain text", L"\uE77F", L"pastePlain");
    }
    if (type == L"Image") add(L"图片文字", L"Image text", L"\uE8A5", L"imageText");
    if (type == L"File") {
        add(L"打开所在目录", L"Open containing folder", L"\uE838", L"openFolder");
        add(L"复制所在目录", L"Copy containing folder", L"\uE8C8", L"copyFolder");
    }
    if (type == L"Image" || type == L"File") {
        extras.exportImage = add(L"导出图片…", L"Export image…", L"\uE74E", L"exportPrepare");
        if (type == L"File") extras.exportImage.Visibility(Visibility::Collapsed);
    }
    if (type == L"Color") {
        extras.colors = MenuFlyoutSubItem{};
        extras.colors.Text(english ? L"Copy color as" : L"复制颜色格式");
        extras.colors.Icon(Glyph(L"\uE790"));
        extras.colors.IsEnabled(false);
        menu.Items().Append(extras.colors);
    }
    if (hasTags) add(L"移除全部标签", L"Remove all assigned tags", L"\uE8EC", L"clearTags");
    return extras;
}

void UpdateCardActions(CardMenuExtras const &menu, JsonObject const &metadata,
    std::wstring const &hash, CardActionRequest request) {
    if (menu.exportImage) menu.exportImage.Visibility(
        metadata.GetNamedBoolean(L"canExportImage", false) ? Visibility::Visible : Visibility::Collapsed);
    if (!menu.colors) return;
    menu.colors.Items().Clear();
    for (auto const &value : metadata.GetNamedArray(L"colorFormats", JsonArray{})) {
        const auto color = value.GetObject();
        const auto format = std::wstring{color.GetNamedString(L"format")};
        MenuFlyoutItem item;
        item.Text(format + L"   " + std::wstring{color.GetNamedString(L"value")});
        item.Click([request, hash, format](auto const &, auto const &) { (void)request(L"copyColor", hash, format); });
        menu.colors.Items().Append(item);
    }
    menu.colors.IsEnabled(menu.colors.Items().Size() > 0);
}

ImageExport::ImageExport(HWND owner, CardActionRequest request, Report report)
    : owner_(owner), request_(std::move(request)), report_(std::move(report)) {}
ImageExport::~ImageExport() { Cancel(); }

void ImageExport::Start(std::wstring const &hash) {
    if (busy_ || dialog_) return;
    busy_ = true;
    ++generation_;
    hash_ = hash;
    operation_ = L"exportPrepare";
    pending_ = request_(operation_, hash_, {});
    if (!pending_) { Cancel(); report_(L"Export unavailable / 暂时无法导出", true); }
}

void ImageExport::Cancel() noexcept {
    ++generation_;
    busy_ = false;
    pending_ = 0;
    if (dialog_) (void)dialog_->Close(HRESULT_FROM_WIN32(ERROR_CANCELLED));
}

std::optional<std::wstring> ImageExport::Choose(std::wstring const &name) {
    const auto generation = generation_;
#ifdef _DEBUG
    if (testChooser_) return testChooser_(name);
#endif
    dialog_ = winrt::create_instance<IFileSaveDialog>(CLSID_FileSaveDialog, CLSCTX_INPROC_SERVER);
    struct Release { winrt::com_ptr<IFileSaveDialog> &dialog; ~Release() { dialog = nullptr; } } release{dialog_};
    const COMDLG_FILTERSPEC filters[] = {
        {L"PNG", L"*.png"}, {L"JPEG", L"*.jpg;*.jpeg"}, {L"WebP", L"*.webp"}, {L"Bitmap", L"*.bmp"}};
    winrt::check_hresult(dialog_->SetFileTypes(ARRAYSIZE(filters), filters));
    winrt::check_hresult(dialog_->SetDefaultExtension(L"png"));
    winrt::check_hresult(dialog_->SetFileName(name.c_str()));
    FILEOPENDIALOGOPTIONS options{};
    winrt::check_hresult(dialog_->GetOptions(&options));
    winrt::check_hresult(dialog_->SetOptions(options | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST | FOS_OVERWRITEPROMPT | FOS_STRICTFILETYPES | FOS_NOCHANGEDIR));
    // Separate Windows MRU for exports; SetDefaultFolder does not override it.
    static constexpr GUID client{0x0e4529bf,0x2b3a,0x481c,{0xb5,0xee,0x98,0x50,0xb3,0xe0,0x58,0x48}};
    winrt::check_hresult(dialog_->SetClientGuid(client));
    winrt::com_ptr<IShellItem> desktop;
    if (SUCCEEDED(SHGetKnownFolderItem(FOLDERID_Desktop, KF_FLAG_DEFAULT, nullptr, IID_PPV_ARGS(desktop.put()))))
        winrt::check_hresult(dialog_->SetDefaultFolder(desktop.get()));
    if (!busy_ || generation != generation_) return std::nullopt;
    const auto result = dialog_->Show(owner_);
    if (result == HRESULT_FROM_WIN32(ERROR_CANCELLED)) return std::nullopt;
    winrt::check_hresult(result);
    winrt::com_ptr<IShellItem> chosen;
    winrt::check_hresult(dialog_->GetResult(chosen.put()));
    PWSTR raw = nullptr;
    winrt::check_hresult(chosen->GetDisplayName(SIGDN_FILESYSPATH, &raw));
    std::unique_ptr<wchar_t, decltype(&CoTaskMemFree)> path{raw, &CoTaskMemFree};
    return std::wstring{path.get()};
}

void ImageExport::Receive(JsonObject const &response) {
    if (!busy_ || response.GetNamedString(L"op", L"") != operation_ ||
        static_cast<std::uint64_t>(response.GetNamedNumber(L"id", 0)) != pending_) return;
    try {
        if (response.HasKey(L"error")) {
            Cancel(); report_(std::wstring{response.GetNamedString(L"error")}, true); return;
        }
        const auto data = response.GetNamedObject(L"data");
        if (operation_ == L"exportImage") {
            Cancel();
            const auto warning = data.GetNamedValue(L"warning", nullptr);
            const bool hasWarning = warning && warning.ValueType() == JsonValueType::String;
            report_(hasWarning ? L"图片已保存 / Image saved: " + std::wstring{warning.GetString()}
                : L"Image exported / 图片已导出", hasWarning);
            return;
        }
        const auto generation = generation_;
        std::optional<std::wstring> path;
        {
            (void)request_(L"modalBegin", {}, {});
            struct EndModal {
                CardActionRequest &request;
                ~EndModal() { (void)request(L"modalEnd", {}, {}); }
            } end{request_};
            path = Choose(std::wstring{data.GetNamedString(L"fileName")});
        }
        if (generation != generation_ || !busy_) return;
        if (!path) { Cancel(); return; }
        operation_ = L"exportImage";
        pending_ = request_(operation_, hash_, *path);
        if (!pending_) { Cancel(); report_(L"Export unavailable / 暂时无法导出", true); }
    } catch (winrt::hresult_error const &error) {
        Cancel(); report_(std::wstring{error.message()}, true);
    } catch (...) {
        Cancel(); report_(L"Export failed / 导出失败", true);
    }
}
}

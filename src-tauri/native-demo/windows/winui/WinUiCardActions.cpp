#include "WinUiCardActions.h"
#include "WinUiAppearance.h"
#include "WinUiHeaderArtwork.h"
#include <shlobj.h>
#include <winrt/Microsoft.UI.Xaml.h>
#include <winrt/Microsoft.UI.Xaml.Controls.Primitives.h>
#include <memory>
#include <utility>

namespace vpaste::winui {
using namespace winrt::Microsoft::UI::Xaml;
using namespace winrt::Microsoft::UI::Xaml::Controls;
using namespace winrt::Windows::Data::Json;

namespace {
// Microsoft Fluent UI System Icons — ic_fluent_scan_text_24_regular.svg (MIT).
constexpr wchar_t ScanText[] = LR"(M5.25 3.5C4.2835 3.5 3.5 4.2835 3.5 5.25V8.25C3.5 8.66421 3.16421 9 2.75 9C2.33579 9 2 8.66421 2 8.25V5.25C2 3.45507 3.45507 2 5.25 2H8.25C8.66421 2 9 2.33579 9 2.75C9 3.16421 8.66421 3.5 8.25 3.5H5.25ZM5.25 20.5C4.2835 20.5 3.5 19.7165 3.5 18.75V15.75C3.5 15.3358 3.16421 15 2.75 15C2.33579 15 2 15.3358 2 15.75V18.75C2 20.5449 3.45507 22 5.25 22H8.25C8.66421 22 9 21.6642 9 21.25C9 20.8358 8.66421 20.5 8.25 20.5H5.25ZM20.5 5.25C20.5 4.2835 19.7165 3.5 18.75 3.5H15.75C15.3358 3.5 15 3.16421 15 2.75C15 2.33579 15.3358 2 15.75 2H18.75C20.5449 2 22 3.45507 22 5.25V8.25C22 8.66421 21.6642 9 21.25 9C20.8358 9 20.5 8.66421 20.5 8.25V5.25ZM18.75 20.5C19.7165 20.5 20.5 19.7165 20.5 18.75V15.75C20.5 15.3358 20.8358 15 21.25 15C21.6642 15 22 15.3358 22 15.75V18.75C22 20.5449 20.5449 22 18.75 22H15.75C15.3358 22 15 21.6642 15 21.25C15 20.8358 15.3358 20.5 15.75 20.5H18.75ZM7.75 7C7.33579 7 7 7.33579 7 7.75C7 8.16421 7.33579 8.5 7.75 8.5H16.25C16.6642 8.5 17 8.16421 17 7.75C17 7.33579 16.6642 7 16.25 7H7.75ZM7 11.75C7 11.3358 7.33579 11 7.75 11H16.25C16.6642 11 17 11.3358 17 11.75C17 12.1642 16.6642 12.5 16.25 12.5H7.75C7.33579 12.5 7 12.1642 7 11.75ZM7.75 15C7.33579 15 7 15.3358 7 15.75C7 16.1642 7.33579 16.5 7.75 16.5H12.25C12.6642 16.5 13 16.1642 13 15.75C13 15.3358 12.6642 15 12.25 15H7.75Z)";
}

PathIcon MakeImageTextIcon() { return HeaderIcon(ScanText); }

MenuFlyoutItem MakeImageTextAction(std::wstring const &hash, bool english, CardActionRequest const &request) {
    MenuFlyoutItem item;
    item.Text(english ? L"Recognize text in image" : L"识别图片文字");
    item.Icon(MakeImageTextIcon());
    item.Click([request, hash](auto const &, auto const &) { (void)request(L"imageText", hash, {}); });
    return item;
}

CardMenuExtras AppendCardActions(MenuFlyout const &menu, std::wstring const &hash,
    winrt::hstring const &type, bool english, CardActionRequest request) {
    CardMenuExtras extras;
    auto add = [&](const wchar_t *zh, const wchar_t *en, const wchar_t *glyph, const wchar_t *operation) {
        MenuFlyoutItem item;
        item.Text(english ? en : zh);
        item.Icon(Glyph(glyph));
        item.Click([request, hash, operation = std::wstring{operation}](auto const &, auto const &) {
            (void)request(operation, hash, {});
        });
        return item;
    };
    const bool text = type == L"Text" || type == L"TextFile" || type == L"Link";
    if (text) {
        extras.pastePlain = add(L"粘贴为纯文本", L"Paste as plain text", L"\uE77F", L"pastePlain");
    }
    if (type == L"File") {
        menu.Items().Append(add(L"打开所在目录", L"Open containing folder", L"\uE838", L"openFolder"));
        menu.Items().Append(add(L"复制所在目录", L"Copy containing folder", L"\uE8C8", L"copyFolder"));
    }
    if (type == L"Image" || type == L"File") {
        extras.exportImage = add(L"导出图片…", L"Export image…", L"\uE74E", L"exportPrepare");
        extras.exportImage.IsEnabled(false);
        ToolTipService::SetToolTip(extras.exportImage, winrt::box_value(english
            ? L"Waiting for image export details" : L"正在读取图片导出信息"));
        menu.Items().Append(extras.exportImage);
        if (type == L"File") extras.exportImage.Visibility(Visibility::Collapsed);
    }
    if (type == L"Color") {
        extras.colors = MenuFlyoutSubItem{};
        extras.colors.Text(english ? L"Copy color as" : L"复制颜色格式");
        extras.colors.Icon(Glyph(L"\uE790"));
        extras.colors.IsEnabled(false);
        ToolTipService::SetToolTip(extras.colors, winrt::box_value(english ? L"Waiting for color formats" : L"正在读取颜色格式"));
        menu.Items().Append(extras.colors);
    }
    return extras;
}

void UpdateCardActions(CardMenuExtras const &menu, JsonObject const &metadata,
    std::wstring const &hash, CardActionRequest request) {
    if (menu.exportImage) {
        const bool canExport = metadata.GetNamedBoolean(L"canExportImage", false);
        menu.exportImage.IsEnabled(canExport);
        menu.exportImage.Visibility(canExport ? Visibility::Visible : Visibility::Collapsed);
        ToolTipService::SetToolTip(menu.exportImage, nullptr);
    }
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
    if (menu.colors.IsEnabled()) ToolTipService::SetToolTip(menu.colors, nullptr);
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

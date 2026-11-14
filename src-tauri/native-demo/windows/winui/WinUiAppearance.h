#pragma once

#include <windows.h>
#undef GetCurrentTime
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Microsoft.UI.Xaml.h>
#include <winrt/Microsoft.UI.Xaml.Automation.h>
#include <winrt/Microsoft.UI.Xaml.Controls.h>
#include <winrt/Microsoft.UI.Xaml.Markup.h>
#include <winrt/Microsoft.UI.Xaml.Media.h>
#include <winrt/Windows.UI.ViewManagement.h>

namespace vpaste::winui {

inline constexpr wchar_t WindowCanvasResource[] = L"VPaste.WindowCanvasBrush";
inline constexpr double ManagementInset = 12;
inline constexpr double QueueContentWidth = 360;
inline constexpr double QueueContentHeight = 448;
inline constexpr double TagContentHeight = 420;
inline constexpr double ManagementMinHeight = 320;
inline constexpr double CompactActionSize = 32;
inline constexpr double ManagementRowRadius = 8;
inline constexpr double DragSourceOpacity = 0.65;
// Native ThemeShadow elevation in DIPs, kept deliberately small for the dock.
inline constexpr float CardElevation = 4;
inline constexpr float HoveredCardElevation = 8;
inline constexpr float HeaderElevation = 4;
inline constexpr float ControlElevation = 2;

inline bool HighContrastEnabled() {
    HIGHCONTRASTW settings{sizeof(HIGHCONTRASTW)};
    winrt::check_bool(SystemParametersInfoW(SPI_GETHIGHCONTRAST, sizeof(settings), &settings, 0));
    return (settings.dwFlags & HCF_HIGHCONTRASTON) != 0;
}

// WinRT structs are aggregates, unlike XAML's uniform "8" shorthand.
inline winrt::Microsoft::UI::Xaml::Thickness UniformThickness(double value) {
    return {value, value, value, value};
}

inline winrt::Microsoft::UI::Xaml::CornerRadius UniformRadius(double value) {
    return {value, value, value, value};
}

inline void ApplyElevation(const winrt::Microsoft::UI::Xaml::UIElement &element,
                           float elevation, bool contrast,
                           const winrt::Microsoft::UI::Xaml::UIElement &receiver = nullptr) {
    using namespace winrt::Microsoft::UI::Xaml::Media;
    if (!element) return;
    auto translation = element.Translation();
    translation.z = contrast ? 0 : elevation;
    element.Translation(translation);
    if (contrast) {
        element.Shadow(nullptr);
    } else if (!element.Shadow()) {
        ThemeShadow shadow;
        // Windows 10 needs a sibling receiver. Windows 11 draws the standard
        // drop shadow automatically and ignores this receiver collection.
        if (receiver) shadow.Receivers().Append(receiver);
        element.Shadow(shadow);
    }
}

// Setters keep ThemeResource expressions alive on the actual element, including
// an explicit app theme and Windows contrast themes. Do not cache resolved brushes.
inline void InstallAppearanceResources() {
    using namespace winrt::Microsoft::UI::Xaml;
    Application::Current().Resources().MergedDictionaries().Append(
        Markup::XamlReader::Load(LR"(<ResourceDictionary
            xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
            xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
          <Style x:Key="VPaste.Body" TargetType="TextBlock">
            <Setter Property="FontSize" Value="14"/>
            <Setter Property="Foreground" Value="{ThemeResource TextFillColorPrimaryBrush}"/>
          </Style>
          <Style x:Key="VPaste.Secondary" TargetType="TextBlock">
            <Setter Property="FontSize" Value="12"/>
            <Setter Property="Foreground" Value="{ThemeResource TextFillColorSecondaryBrush}"/>
          </Style>
          <Style x:Key="VPaste.Caption" TargetType="TextBlock">
            <Setter Property="FontSize" Value="12"/>
            <Setter Property="Foreground" Value="{ThemeResource TextFillColorTertiaryBrush}"/>
          </Style>
          <Style x:Key="VPaste.Title" TargetType="TextBlock" BasedOn="{StaticResource VPaste.Body}">
            <Setter Property="FontSize" Value="20"/>
            <Setter Property="FontWeight" Value="SemiBold"/>
          </Style>
          <Style x:Key="VPaste.CompactTitle" TargetType="TextBlock" BasedOn="{StaticResource VPaste.Body}">
            <Setter Property="FontWeight" Value="SemiBold"/>
          </Style>
          <Style x:Key="VPaste.EmptyTitle" TargetType="TextBlock" BasedOn="{StaticResource VPaste.Body}">
            <Setter Property="FontSize" Value="16"/>
            <Setter Property="FontWeight" Value="SemiBold"/>
          </Style>
          <Style x:Key="VPaste.CardTitle" TargetType="TextBlock">
            <Setter Property="FontSize" Value="13"/>
            <Setter Property="FontWeight" Value="Bold"/>
            <Setter Property="Foreground" Value="White"/>
          </Style>
          <Style x:Key="VPaste.CardTime" TargetType="TextBlock">
            <Setter Property="FontSize" Value="11"/>
            <Setter Property="Foreground" Value="White"/>
            <Setter Property="Opacity" Value="0.94"/>
          </Style>
          <Style x:Key="VPaste.CardTag" TargetType="TextBlock">
            <Setter Property="FontSize" Value="11"/>
            <Setter Property="FontWeight" Value="SemiBold"/>
            <Setter Property="Foreground" Value="{ThemeResource AccentFillColorDefaultBrush}"/>
          </Style>
          <Style x:Key="VPaste.ContrastCardTitle" TargetType="TextBlock" BasedOn="{StaticResource VPaste.CardTitle}">
            <Setter Property="Foreground" Value="{ThemeResource TextFillColorPrimaryBrush}"/>
          </Style>
          <Style x:Key="VPaste.ContrastCardTime" TargetType="TextBlock" BasedOn="{StaticResource VPaste.CardTime}">
            <Setter Property="Foreground" Value="{ThemeResource TextFillColorPrimaryBrush}"/>
            <Setter Property="Opacity" Value="1"/>
          </Style>
          <Style x:Key="VPaste.ContrastCardHeader" TargetType="Border">
            <Setter Property="Background" Value="{ThemeResource ControlFillColorDefaultBrush}"/>
          </Style>
          <Style x:Key="VPaste.ClipboardItem" TargetType="ListViewItem">
            <Setter Property="FocusVisualPrimaryBrush" Value="{ThemeResource AccentFillColorDefaultBrush}"/>
            <Setter Property="FocusVisualPrimaryThickness" Value="2"/>
            <Setter Property="FocusVisualSecondaryThickness" Value="0"/>
          </Style>
          <Style x:Key="VPaste.Surface" TargetType="Border">
            <Setter Property="Background" Value="{ThemeResource SolidBackgroundFillColorTertiaryBrush}"/>
            <Setter Property="BorderBrush" Value="{ThemeResource ControlStrokeColorDefaultBrush}"/>
            <Setter Property="BorderThickness" Value="1"/>
            <Setter Property="CornerRadius" Value="8"/>
          </Style>
          <Style x:Key="VPaste.SelectedSurface" TargetType="Border" BasedOn="{StaticResource VPaste.Surface}">
            <Setter Property="BorderBrush" Value="{ThemeResource AccentFillColorDefaultBrush}"/>
            <Setter Property="BorderThickness" Value="2"/>
          </Style>
          <Style x:Key="VPaste.CardOutline" TargetType="Border" BasedOn="{StaticResource VPaste.SelectedSurface}">
            <Setter Property="Background" Value="Transparent"/>
            <Setter Property="IsHitTestVisible" Value="False"/>
          </Style>
          <Style x:Key="VPaste.CardTagSurface" TargetType="Border" BasedOn="{StaticResource VPaste.Surface}">
            <Setter Property="Background" Value="{ThemeResource SolidBackgroundFillColorSecondaryBrush}"/>
            <Setter Property="CornerRadius" Value="10"/>
          </Style>
        )" LR"(
          <Style x:Key="VPaste.Inset" TargetType="Border">
            <Setter Property="Background" Value="{ThemeResource SubtleFillColorSecondaryBrush}"/>
            <Setter Property="CornerRadius" Value="4"/>
          </Style>
          <Style x:Key="VPaste.QueueInsertion" TargetType="Border">
            <Setter Property="Background" Value="{ThemeResource AccentFillColorDefaultBrush}"/>
            <Setter Property="Height" Value="2"/>
            <Setter Property="IsHitTestVisible" Value="False"/>
          </Style>
          <Style x:Key="VPaste.Glyph" TargetType="FontIcon">
            <Setter Property="FontSize" Value="16"/>
            <Setter Property="Foreground" Value="{ThemeResource TextFillColorSecondaryBrush}"/>
          </Style>
          <Style x:Key="VPaste.IconButton" TargetType="Button" BasedOn="{StaticResource DefaultButtonStyle}">
            <Setter Property="Background" Value="Transparent"/>
            <Setter Property="BorderBrush" Value="Transparent"/>
            <Setter Property="Padding" Value="0"/>
          </Style>
          <Style x:Key="VPaste.RoundToolbarButton" TargetType="Button" BasedOn="{StaticResource DefaultButtonStyle}">
            <Setter Property="Width" Value="28"/>
            <Setter Property="Height" Value="28"/>
            <Setter Property="Padding" Value="0"/>
            <Setter Property="CornerRadius" Value="14"/>
            <Setter Property="Background" Value="{ThemeResource ControlFillColorDefaultBrush}"/>
            <Setter Property="BorderBrush" Value="{ThemeResource ControlStrokeColorDefaultBrush}"/>
          </Style>
          <Style x:Key="VPaste.RoundToolbarCommand" TargetType="AppBarButton" BasedOn="{StaticResource DefaultAppBarButtonStyle}">
            <Setter Property="Width" Value="36"/>
            <Setter Property="Height" Value="40"/>
            <Setter Property="MinWidth" Value="0"/>
            <Setter Property="VerticalAlignment" Value="Center"/>
            <Setter Property="CornerRadius" Value="14"/>
            <Setter Property="Background" Value="{ThemeResource ControlFillColorDefaultBrush}"/>
            <Setter Property="BorderBrush" Value="{ThemeResource ControlStrokeColorDefaultBrush}"/>
            <Setter Property="BorderThickness" Value="1"/>
          </Style>
          <Style x:Key="VPaste.RoundToolbarUpdate" TargetType="AppBarButton" BasedOn="{StaticResource VPaste.RoundToolbarCommand}">
            <Setter Property="Background" Value="{ThemeResource AccentFillColorDefaultBrush}"/>
            <Setter Property="BorderBrush" Value="{ThemeResource AccentFillColorDefaultBrush}"/>
            <Setter Property="Foreground" Value="{ThemeResource TextOnAccentFillColorPrimaryBrush}"/>
          </Style>
          <Style x:Key="VPaste.ActiveToolbarCommand" TargetType="AppBarButton" BasedOn="{StaticResource VPaste.RoundToolbarCommand}">
            <Setter Property="BorderBrush" Value="{ThemeResource AccentFillColorDefaultBrush}"/>
            <Setter Property="Foreground" Value="{ThemeResource AccentFillColorDefaultBrush}"/>
          </Style>
          <Style x:Key="VPaste.SelectionBar" TargetType="Border" BasedOn="{StaticResource VPaste.Surface}">
            <Setter Property="Background" Value="{ThemeResource SolidBackgroundFillColorSecondaryBrush}"/>
            <Setter Property="CornerRadius" Value="10"/>
            <Setter Property="Padding" Value="12,8"/>
          </Style>
          <Style x:Key="VPaste.ClipboardHeader" TargetType="Grid">
            <Setter Property="Background" Value="{ThemeResource LayerFillColorDefaultBrush}"/>
            <Setter Property="BorderBrush" Value="{ThemeResource ControlStrokeColorDefaultBrush}"/>
            <Setter Property="BorderThickness" Value="0,0,0,1"/>
          </Style>
        </ResourceDictionary>)").as<ResourceDictionary>());
}

inline void ApplyStyle(const winrt::Microsoft::UI::Xaml::FrameworkElement &element,
                       const wchar_t *key) {
    element.Style(winrt::Microsoft::UI::Xaml::Application::Current().Resources()
        .Lookup(winrt::box_value(key)).as<winrt::Microsoft::UI::Xaml::Style>());
}

inline winrt::hstring TypeLabel(const winrt::hstring &type, bool english) {
    if (type == L"Image") return english ? L"Image" : L"图片";
    if (type == L"File") return english ? L"File" : L"文件";
    if (type == L"TextFile") return english ? L"Text file" : L"文本文件";
    if (type == L"Link") return english ? L"Link" : L"链接";
    if (type == L"Color") return english ? L"Color" : L"颜色";
    return english ? L"Text" : L"文本";
}

inline winrt::hstring TypeGlyph(const winrt::hstring &type) {
    if (type == L"Image") return L"\uEB9F"; // Photo2
    if (type == L"File") return L"\uE8B7"; // OpenFolderHorizontal
    if (type == L"Link") return L"\uE71B"; // Link
    if (type == L"Color") return L"\uE790"; // Color
    return L"\uE8A5"; // Document
}

inline winrt::Microsoft::UI::Xaml::Controls::FontIcon Glyph(const winrt::hstring &glyph) {
    winrt::Microsoft::UI::Xaml::Controls::FontIcon icon;
    icon.Glyph(glyph);
    ApplyStyle(icon, L"VPaste.Glyph");
    return icon;
}

inline winrt::Microsoft::UI::Xaml::Controls::StackPanel EmptyState(
    const winrt::hstring &glyph, const winrt::hstring &title, const winrt::hstring &description) {
    using namespace winrt::Microsoft::UI::Xaml;
    using namespace winrt::Microsoft::UI::Xaml::Controls;
    StackPanel panel;
    panel.Spacing(8);
    panel.MaxWidth(420);
    panel.HorizontalAlignment(HorizontalAlignment::Center);
    panel.VerticalAlignment(VerticalAlignment::Center);
    TextBlock heading;
    heading.Text(title);
    heading.TextAlignment(TextAlignment::Center);
    ApplyStyle(heading, L"VPaste.EmptyTitle");
    TextBlock detail;
    detail.Text(description);
    detail.TextWrapping(TextWrapping::Wrap);
    detail.TextAlignment(TextAlignment::Center);
    ApplyStyle(detail, L"VPaste.Secondary");
    auto icon = Glyph(glyph);
    icon.FontSize(32);
    icon.Margin(Thickness{0, 0, 0, 4});
    // Shared order: icon, title, description, then optional recovery actions.
    panel.Children().Append(heading);
    panel.Children().Append(detail);
    panel.Children().InsertAt(0, icon);
    return panel;
}

inline void NameIconButton(const winrt::Microsoft::UI::Xaml::Controls::Button &button,
                           const winrt::hstring &label) {
    winrt::Microsoft::UI::Xaml::Automation::AutomationProperties::SetName(button, label);
    winrt::Microsoft::UI::Xaml::Controls::ToolTipService::SetToolTip(button, winrt::box_value(label));
}

inline winrt::Microsoft::UI::Xaml::Controls::Button NamedIconButton(
    const winrt::Microsoft::UI::Xaml::Controls::IconElement &icon, const winrt::hstring &label) {
    using namespace winrt::Microsoft::UI::Xaml;
    using namespace winrt::Microsoft::UI::Xaml::Controls;
    Button button;
    ApplyStyle(button, L"VPaste.IconButton");
    button.Width(CompactActionSize);
    button.Height(CompactActionSize);
    button.Padding(Thickness{0});
    button.Content(icon);
    NameIconButton(button, label);
    return button;
}

inline winrt::Microsoft::UI::Xaml::Controls::ContentDialog MakeConfirmationDialog(
    const winrt::Microsoft::UI::Xaml::FrameworkElement &owner,
    const winrt::hstring &title, const winrt::hstring &content,
    const winrt::hstring &confirm, const winrt::hstring &cancel) {
    using namespace winrt::Microsoft::UI::Xaml::Controls;
    ContentDialog dialog;
    dialog.XamlRoot(owner.XamlRoot());
    dialog.RequestedTheme(owner.ActualTheme());
    dialog.Title(winrt::box_value(title));
    dialog.Content(winrt::box_value(content));
    dialog.PrimaryButtonText(confirm);
    dialog.CloseButtonText(cancel);
    dialog.DefaultButton(ContentDialogButton::Close);
    return dialog;
}

// The native host owns this shared brush. Transparent paint preserves hit
// testing while exposing its one system backdrop, including in the other views.
inline winrt::Microsoft::UI::Xaml::Media::Brush WindowCanvasBackground() {
    auto resources = winrt::Microsoft::UI::Xaml::Application::Current().Resources();
    auto brush = resources.TryLookup(winrt::box_value(WindowCanvasResource));
    if (!brush) brush = resources.Lookup(winrt::box_value(L"ApplicationPageBackgroundThemeBrush"));
    return brush.as<winrt::Microsoft::UI::Xaml::Media::Brush>();
}

} // namespace vpaste::winui

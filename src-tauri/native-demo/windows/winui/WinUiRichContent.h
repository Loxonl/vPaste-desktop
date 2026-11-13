#pragma once

#include <winrt/Windows.Data.Json.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Microsoft.UI.Xaml.Controls.h>
#include "WinUiCardContent.h"

namespace vpaste::winui {

winrt::Windows::Foundation::Uri LocalAssetUri(const winrt::hstring &path);

winrt::Microsoft::UI::Xaml::Controls::ScrollViewer RenderRichContent(
    const winrt::Windows::Data::Json::JsonArray &blocks, bool darkCanvas, SearchTerms const &terms = {});

} // namespace vpaste::winui

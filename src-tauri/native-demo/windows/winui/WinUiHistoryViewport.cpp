#include "WinUiHistoryViewport.h"
#include <algorithm>
#include <cmath>
#include <limits>
namespace vpaste::winui {
double ClampHistoryOffset(double offset, double maximum) {
    if (!std::isfinite(offset) || !std::isfinite(maximum)) return 0;
    return std::clamp(offset, 0.0, std::max(0.0, maximum));
}
bool NearHistoryEnd(double offset, double maximum, double viewport) {
    return std::isfinite(offset) && std::isfinite(viewport) && viewport > 0 && std::isfinite(maximum) && maximum >= 0 &&
        maximum - ClampHistoryOffset(offset, maximum) <= viewport * 0.5;
}
int HistoryPageStep(double viewport, double cardWidth) {
    if (!std::isfinite(viewport) || !std::isfinite(cardWidth) || viewport <= 0 || cardWidth <= 0) return 1;
    return static_cast<int>(std::clamp(std::floor(viewport / cardWidth), 1.0, static_cast<double>(std::numeric_limits<int>::max())));
}
}

#pragma once
#include <string>

namespace vpaste::winui {
struct HistoryQuery {
    std::wstring search, category, tag;
    bool operator==(HistoryQuery const &) const = default;
};
double ClampHistoryOffset(double offset, double maximum);
bool NearHistoryEnd(double offset, double maximum, double viewport);
int HistoryPageStep(double viewport, double cardWidth);
}

#include "ledger.hpp"
#include "policy.h"

#include <numeric>
#include <stdexcept>

void Ledger::add(std::string title, int value) {
    if (!valid_title(title.c_str()) || value < 0) {
        throw std::invalid_argument("invalid ledger entry");
    }
    values_.push_back(value);
}

int Ledger::total(int maximum) const {
    return clamp_total(std::accumulate(values_.begin(), values_.end(), 0), maximum);
}

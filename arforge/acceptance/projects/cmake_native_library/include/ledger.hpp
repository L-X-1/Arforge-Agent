#pragma once

#include <string>
#include <vector>

class Ledger {
public:
    void add(std::string title, int value);
    int total(int maximum) const;

private:
    std::vector<int> values_;
};

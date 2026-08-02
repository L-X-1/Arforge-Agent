#include "ledger.hpp"
#include "policy.h"

#include <cassert>
#include <stdexcept>
#include <string>

int main(int argc, char **argv) {
    assert(argc == 2);
    const std::string suite = argv[1];
    if (suite == "unit") {
        assert(clamp_total(50, 42) == 42);
        assert(valid_title("work") == 1);
    } else if (suite == "integration") {
        Ledger ledger;
        ledger.add("first", 20);
        ledger.add("second", 22);
        assert(ledger.total(100) == 42);
    } else if (suite == "negative") {
        Ledger ledger;
        bool rejected = false;
        try {
            ledger.add("   ", -1);
        } catch (const std::invalid_argument &) {
            rejected = true;
        }
        assert(rejected);
        assert(ledger.total(100) == 0);
    } else {
        return 2;
    }
    return 0;
}

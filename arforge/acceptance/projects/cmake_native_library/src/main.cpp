#include "ledger.hpp"

#include <iostream>

int main() {
    Ledger ledger;
    ledger.add("project", 20);
    ledger.add("depth", 22);
    std::cout << ledger.total(100) << '\n';
    return ledger.total(100) == 42 ? 0 : 1;
}

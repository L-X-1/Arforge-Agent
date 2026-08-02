#include "policy.h"

#include <ctype.h>

int clamp_total(int value, int maximum) {
    if (maximum < 0) {
        return 0;
    }
    return value > maximum ? maximum : value;
}

int valid_title(const char *title) {
    if (title == 0) {
        return 0;
    }
    while (*title != '\0') {
        if (!isspace((unsigned char)*title)) {
            return 1;
        }
        title++;
    }
    return 0;
}

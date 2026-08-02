#ifndef ARFORGE_POLICY_H
#define ARFORGE_POLICY_H

#ifdef __cplusplus
extern "C" {
#endif

int clamp_total(int value, int maximum);
int valid_title(const char *title);

#ifdef __cplusplus
}
#endif
#endif

"""Audit bridge method coverage."""
import re
from pathlib import Path

content = Path(r"E:\Arforge-Agent\arforge\bridge.py").read_text(encoding="utf-8")

# Find all method-set definitions
sets_defs = ["READ_ONLY_METHODS", "SESSION_METHODS", "ACTION_METHODS", "TASK_METHODS", "PRODUCT_METHODS", "GIT_METHODS"]

for name in sets_defs:
    match = re.search(rf'{name}\s*=\s*\{{(.*?)\}}', content, re.DOTALL)
    if match:
        methods = re.findall(r'"([^"]+)"', match.group(1))
        print(f"{name}: {len(methods)} methods")
        # Check which are handled by individual dispatch
        for m in sorted(methods):
            # Check if dispatched individually (elif method == "X") or in a sub-dispatcher
            if f'method == "{m}"' in content:
                print(f"  [OK] {m}")
            else:
                print(f"  [??] {m}  (no explicit handler)")

# Also check individual method handlers outside the sets
print("\n--- Individual dispatch methods (outside sets) ---")
individual = re.findall(r'elif method == "([^"]+)"', content)
for m in sorted(individual):
    print(f"  {m}")

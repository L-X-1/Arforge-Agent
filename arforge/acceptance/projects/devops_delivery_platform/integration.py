from __future__ import annotations

from pathlib import Path
import subprocess
import time
from urllib.request import urlopen

docker = "docker"
image = Path(".runtime/image.id").read_text(encoding="utf-8").strip()
label = f"arforge.acceptance.workspace={Path.cwd().name}"
container = subprocess.check_output(
    [docker, "run", "-d", "-P", "--label", label, image],
    text=True,
).strip()
try:
    mapping = subprocess.check_output(
        [docker, "port", container, "8080/tcp"],
        text=True,
    ).strip()
    port = mapping.rsplit(":", 1)[1]
    for _ in range(30):
        try:
            with urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as response:
                if response.read() == b'{"status":"ok"}':
                    break
        except OSError:
            time.sleep(1)
    else:
        raise RuntimeError("Nginx health endpoint did not become ready")
    with urlopen(f"http://127.0.0.1:{port}/", timeout=2) as response:
        assert b"Arforge project-depth delivery" in response.read()
finally:
    subprocess.run([docker, "rm", "-f", container], check=False)
print("PASS:Docker:Nginx")

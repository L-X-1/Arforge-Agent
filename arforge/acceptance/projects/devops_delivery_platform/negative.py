from __future__ import annotations

from pathlib import Path
import subprocess
import tempfile

label = f"arforge.acceptance.workspace={Path.cwd().name}"
with tempfile.TemporaryDirectory() as raw:
    temporary = Path(raw)
    invalid_nginx = temporary / "nginx.conf"
    invalid_nginx.write_text("events {} http { invalid; }", encoding="utf-8")
    nginx = subprocess.run(
        [
            "docker",
            "run",
            "--rm",
            "--label",
            label,
            "-v",
            f"{invalid_nginx}:/etc/nginx/nginx.conf:ro",
            "nginx:1.27-alpine",
            "nginx",
            "-t",
        ],
        capture_output=True,
        text=True,
    )
    if nginx.returncode == 0:
        raise RuntimeError("invalid Nginx config was accepted")

    kubernetes = subprocess.run(
        [
            "kubectl",
            "create",
            "deployment",
            "invalid",
            "--dry-run=client",
        ],
        capture_output=True,
        text=True,
    )
    if kubernetes.returncode == 0:
        raise RuntimeError("invalid Kubernetes deployment was accepted")
print("PASS:negative")

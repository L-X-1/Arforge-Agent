from __future__ import annotations

import hashlib
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
CANONICAL = ROOT / "assets" / "brand" / "Arforge-logo-app-icon.ico"


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _master() -> Image.Image:
    source = Image.open(CANONICAL)
    return source.ico.getimage((256, 256)).convert("RGBA")


def test_every_product_ico_is_the_owner_supplied_canonical_asset() -> None:
    roots = (
        ROOT / "packages" / "desktop" / "icons",
        ROOT / "packages" / "desktop" / "resources" / "icons",
        ROOT / "packages" / "ui" / "src" / "assets",
        ROOT / "packages" / "app" / "public",
        ROOT / "icons",
    )
    icons = sorted(path for root in roots for path in root.rglob("*.ico"))

    assert len(icons) == 10
    expected = _sha256(CANONICAL)
    assert expected == "311b8b1dfcb5bb7e5de690c5b0ceda618f1f7f63fe79f327e38e6cd22072a03e"
    assert all(_sha256(path) == expected for path in icons)


def test_representative_desktop_and_web_pngs_derive_from_the_canonical_icon() -> None:
    master = _master()
    targets = (
        ROOT / "packages" / "desktop" / "icons" / "dev" / "icon.png",
        ROOT / "packages" / "desktop" / "icons" / "beta" / "icon.png",
        ROOT / "packages" / "desktop" / "icons" / "prod" / "icon.png",
        ROOT / "packages" / "desktop" / "resources" / "icons" / "icon.png",
        ROOT / "packages" / "app" / "public" / "web-app-manifest-512x512.png",
        ROOT / "packages" / "ui" / "src" / "assets" / "brand" / "arforge-logo.png",
    )

    for target in targets:
        with Image.open(target) as actual:
            rgba = actual.convert("RGBA")
            expected = master.resize(rgba.size, Image.Resampling.LANCZOS)
            assert rgba.tobytes() == expected.tobytes(), target


def test_electron_runtime_and_packager_both_use_the_canonical_icon_path() -> None:
    windows = (ROOT / "packages" / "desktop" / "src" / "main" / "windows.ts").read_text(encoding="utf-8")
    builder = (ROOT / "packages" / "desktop" / "electron-builder.config.ts").read_text(encoding="utf-8")

    assert 'const ext = process.platform === "win32" ? "ico" : "png"' in windows
    assert "nativeImage.createFromPath(path)" in windows
    assert "win.setIcon(icon)" in windows
    assert "win.setAppDetails({" in windows
    assert "appIconPath: iconPath()" in windows
    assert "icon: `resources/icons/icon.ico`" in builder
    assert "installerIcon: `resources/icons/icon.ico`" in builder
    assert "installerHeaderIcon: `resources/icons/icon.ico`" in builder

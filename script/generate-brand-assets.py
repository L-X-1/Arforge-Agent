#!/usr/bin/env python3
"""Generate every Arforge product logo asset from the canonical ICO source."""

from __future__ import annotations

import base64
import shutil
from io import BytesIO
from pathlib import Path

try:
    from PIL import Image
except ImportError as error:
    raise SystemExit("Pillow is required: python -m pip install Pillow") from error


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "brand" / "Arforge-logo-app-icon.ico"
RESAMPLING = Image.Resampling.LANCZOS


def master_image() -> Image.Image:
    source = Image.open(SOURCE)
    return source.ico.getimage((256, 256)).convert("RGBA")


def save_png(image: Image.Image, target: Path, size: tuple[int, int]) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    image.resize(size, RESAMPLING).save(target, format="PNG", optimize=True)


def save_svg(image: Image.Image, target: Path) -> None:
    png = BytesIO()
    image.save(png, format="PNG", optimize=True)
    encoded = base64.b64encode(png.getvalue()).decode("ascii")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        "\n".join(
            [
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-label="Arforge">',
                f'  <image width="256" height="256" href="data:image/png;base64,{encoded}" />',
                "</svg>",
                "",
            ]
        ),
        encoding="utf-8",
    )


def replace_desktop_icons(image: Image.Image) -> None:
    desktop = ROOT / "packages" / "desktop"
    for channel in ("dev", "beta", "prod"):
        directory = desktop / "icons" / channel
        for target in directory.rglob("*.png"):
            with Image.open(target) as existing:
                save_png(image, target, existing.size)
        shutil.copyfile(SOURCE, directory / "icon.ico")
        image.resize((1024, 1024), RESAMPLING).save(directory / "icon.icns", format="ICNS")

    resources = desktop / "resources" / "icons"
    for target in resources.rglob("*.png"):
        with Image.open(target) as existing:
            save_png(image, target, existing.size)
    shutil.copyfile(SOURCE, resources / "icon.ico")
    image.resize((1024, 1024), RESAMPLING).save(resources / "icon.icns", format="ICNS")
    shutil.copyfile(SOURCE, ROOT / "icons" / "icon.ico")


def replace_web_icons(image: Image.Image) -> None:
    ui = ROOT / "packages" / "ui" / "src" / "assets"
    brand = ui / "brand"
    save_png(image, brand / "arforge-logo.png", (1024, 1024))
    shutil.copyfile(SOURCE, brand / "arforge-logo.ico")

    favicon = ui / "favicon"
    for name in ("favicon.ico", "favicon-v3.ico"):
        shutil.copyfile(SOURCE, favicon / name)
    for name in ("favicon.svg", "favicon-v3.svg"):
        save_svg(image, favicon / name)
    for name in ("favicon-96x96.png", "favicon-96x96-v3.png"):
        save_png(image, favicon / name, (96, 96))
    for name in ("apple-touch-icon.png", "apple-touch-icon-v3.png"):
        save_png(image, favicon / name, (180, 180))
    save_png(image, favicon / "web-app-manifest-192x192.png", (192, 192))
    save_png(image, favicon / "web-app-manifest-512x512.png", (512, 512))

    public = ROOT / "packages" / "app" / "public"
    for name in ("favicon.ico", "favicon-v3.ico"):
        shutil.copyfile(SOURCE, public / name)
    for name in ("favicon.svg", "favicon-v3.svg"):
        save_svg(image, public / name)
    for name in ("favicon-96x96.png", "favicon-96x96-v3.png"):
        save_png(image, public / name, (96, 96))
    for name in ("apple-touch-icon.png", "apple-touch-icon-v3.png"):
        save_png(image, public / name, (180, 180))
    save_png(image, public / "web-app-manifest-192x192.png", (192, 192))
    save_png(image, public / "web-app-manifest-512x512.png", (512, 512))
    shutil.copyfile(favicon / "site.webmanifest", public / "site.webmanifest")

    docs = ROOT / "packages" / "docs"
    for name in ("favicon.svg", "favicon-v3.svg"):
        save_svg(image, docs / name)


def replace_social_cards(image: Image.Image) -> None:
    ui = ROOT / "packages" / "ui" / "src" / "assets"
    public = ROOT / "packages" / "app" / "public"
    cards = {
        "social-share.png": "#0B1020",
        "social-share-black.png": "#080808",
        "social-share-zen.png": "#F4F1EA",
    }
    logo = image.resize((420, 420), RESAMPLING)
    for name, color in cards.items():
        card = Image.new("RGB", (1200, 630), color)
        card.paste(logo, ((card.width - logo.width) // 2, (card.height - logo.height) // 2), logo)
        target = ui / "images" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        card.save(target, format="PNG", optimize=True)
        if name != "social-share-black.png":
            shutil.copyfile(target, public / name)


def main() -> None:
    if not SOURCE.is_file():
        raise SystemExit(f"Canonical logo source is missing: {SOURCE}")
    image = master_image()
    replace_desktop_icons(image)
    replace_web_icons(image)
    replace_social_cards(image)
    print(f"Generated Arforge brand assets from {SOURCE}")


if __name__ == "__main__":
    main()

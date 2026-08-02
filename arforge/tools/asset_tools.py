"""Asset download tool — download CDN resources to local static directory.

Lets Arforge create self-contained frontends that don't depend on
unreliable CDN connections.
"""

from __future__ import annotations

import os
import ssl
import urllib.request

from arforge.tool_registry import ParamSchema, register_tool


@register_tool(
    "download_asset",
    "Download a JavaScript or CSS file from a URL to the local static resources "
    "directory so the frontend does not depend on CDN availability. Use this when "
    "CDN scripts fail to load or time out. Returns the local path that can be "
    "referenced in HTML.",
    keywords=[
        "download", "cdn", "asset", "local", "static",
        "save script", "download js", "download css",
    ],
    params=[
        ParamSchema("url", "string", "URL of the JS/CSS file to download"),
        ParamSchema("save_dir", "string",
                    "Directory to save to (e.g. src/main/resources/static/js/)",
                    required=False,
                    default="src/main/resources/static/"),
    ],
    risk="low",
    requires_confirmation=False,
    timeout=30,
    category="network",
    source=__name__,
)
def download_asset(url: str, save_dir: str = "src/main/resources/static/") -> str:
    """Download a CDN asset and save it locally, returning the relative path.

    The relative path can be used in HTML like:
      <script src="/static/js/vue.min.js"></script>
    """
    url = (url or "").strip()
    save_dir = (save_dir or "src/main/resources/static/").strip()

    if not url.startswith("http://") and not url.startswith("https://"):
        return "Error: url must start with http:// or https://"

    # Determine filename from URL
    filename = url.rsplit("/", 1)[-1].split("?")[0]
    if not filename or "." not in filename:
        return f"Error: could not determine filename from URL: {url}"

    # Resolve save directory relative to workspace
    from arforge.tools.file_tools import get_workspace

    full_dir = os.path.join(
        str(get_workspace()),
        save_dir.replace("\\", "/"),
    )
    os.makedirs(full_dir, exist_ok=True)

    filepath = os.path.join(full_dir, filename)

    # Download
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    try:
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "Mozilla/5.0 ArforgeDownloader/1.0"},
        )
        with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
            data = resp.read()
            content_type = resp.headers.get("Content-Type", "unknown")
            status = resp.status

        with open(filepath, "wb") as f:
            f.write(data)

        size_kb = len(data) / 1024
        relative = os.path.join(save_dir, filename).replace("\\", "/")

        return (
            f"Downloaded: {url}\n"
            f"  Status: HTTP {status}\n"
            f"  Type: {content_type}\n"
            f"  Size: {size_kb:.1f} KB\n"
            f"  Saved to: {filepath}\n"
            f"  Relative path for HTML: {relative}\n"
            f"  Use in HTML: src=\"{relative}\" or href=\"{relative}\""
        )
    except Exception as e:
        return f"Failed to download {url}: {e}"


@register_tool(
    "download_all_cdn",
    "Download ALL external CDN resources referenced in an HTML file to local static "
    "directory, and rewrite the HTML to use local paths instead of CDN URLs. "
    "This makes the frontend fully self-contained and immune to CDN outages.",
    keywords=[
        "download all", "localize", "offline", "self-contained",
        "bundle assets", "vendor", "cdn to local",
    ],
    params=[
        ParamSchema("html_path", "string",
                    "Path to the HTML file (e.g. src/main/resources/static/index.html)"),
    ],
    risk="medium",
    requires_confirmation=False,
    timeout=60,
    category="network",
    source=__name__,
)
def download_all_cdn(html_path: str) -> str:
    """Download all CDN <script src> and <link href> resources to local static dir,
    then rewrite the HTML to use local paths.

    Handles both http:// and https:// URLs. Non-CDN references (local paths)
    are left unchanged.
    """
    import re

    html_path = (html_path or "").strip()
    from arforge.tools.file_tools import get_workspace

    full_html_path = os.path.join(
        str(get_workspace()),
        html_path.replace("\\", "/"),
    )

    if not os.path.isfile(full_html_path):
        return f"Error: file not found: {full_html_path}"

    html_dir = os.path.dirname(full_html_path)

    with open(full_html_path, "r", encoding="utf-8") as f:
        html = f.read()

    # Find all external URLs
    SRC_RE = re.compile(r'''(src|href)\s*=\s*["'](https?://[^"'\s]+)["']''', re.IGNORECASE)
    urls = SRC_RE.findall(html)

    external_urls = [(attr, url) for attr, url in urls if url.startswith("http")]

    if not external_urls:
        return f"No external CDN URLs found in {html_path}"

    # Create vendor directories
    js_dir = os.path.join(html_dir, "vendor", "js")
    css_dir = os.path.join(html_dir, "vendor", "css")
    os.makedirs(js_dir, exist_ok=True)
    os.makedirs(css_dir, exist_ok=True)

    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    report: list[str] = []
    report.append(f"=== Downloading {len(external_urls)} CDN resources ===")
    report.append("")

    replacements: dict[str, str] = {}  # old_url -> new_relative_path

    for attr, url in external_urls:
        if url in replacements:
            continue  # already processed

        filename = url.rsplit("/", 1)[-1].split("?")[0]
        if not filename:
            continue

        # Determine subdirectory based on extension
        if filename.endswith(".css"):
            subdir = "vendor/css"
        else:
            subdir = "vendor/js"

        dest_path = os.path.join(html_dir, subdir, filename)

        try:
            req = urllib.request.Request(
                url,
                headers={"User-Agent": "Mozilla/5.0 ArforgeDownloader/1.0"},
            )
            with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
                data = resp.read()

            with open(dest_path, "wb") as f:
                f.write(data)

            size_kb = len(data) / 1024
            relative = f"{subdir}/{filename}"

            report.append(f"  [OK] {size_kb:5.1f}KB  {filename}")
            report.append(f"       {url}")
            report.append(f"       -> {relative}")

            replacements[url] = relative

        except Exception as e:
            report.append(f"  [FAIL] {filename}: {e}")
            report.append(f"         {url}")

    report.append("")

    if not replacements:
        return "\n".join(report) + "\nNo CDN resources could be downloaded."

    # Rewrite HTML
    for old_url, new_path in replacements.items():
        html = html.replace(old_url, new_path)

    # Write updated HTML
    with open(full_html_path, "w", encoding="utf-8") as f:
        f.write(html)

    report.append(f"=== Updated {html_path} ===")
    report.append(f"Replaced {len(replacements)} CDN URLs with local paths.")
    report.append(f"Local assets in: {html_dir}/vendor/")
    report.append("")
    report.append("NEXT: rebuild the jar and restart the server.")

    return "\n".join(report)

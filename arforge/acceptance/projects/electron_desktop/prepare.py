from hashlib import sha256
from pathlib import Path
from urllib.request import urlretrieve
from zipfile import ZipFile

url = (
    "https://npmmirror.com/mirrors/electron/37.2.6/"
    "electron-v37.2.6-win32-x64.zip"
)
archive = Path("electron.zip")
if not archive.is_file():
    urlretrieve(url, archive)
expected = "f7732d90dc70b9c7415a06f97f47f1ad45af8d6d89f557f6b00cee613f9a508e"
observed = sha256(archive.read_bytes()).hexdigest()
if observed != expected:
    raise RuntimeError(f"Electron archive digest mismatch: {observed}")
destination = Path("electron-dist")
if not (destination / "electron.exe").is_file():
    with ZipFile(archive) as package:
        package.extractall(destination)

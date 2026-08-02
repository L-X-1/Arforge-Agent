from __future__ import annotations

import binascii
from pathlib import Path
import struct
import zlib


def chunk(kind: bytes, payload: bytes) -> bytes:
    return (
        struct.pack(">I", len(payload))
        + kind
        + payload
        + struct.pack(">I", binascii.crc32(kind + payload) & 0xFFFFFFFF)
    )


width = height = 32
row = b"\x00" + bytes((36, 190, 120, 255)) * width
png = (
    b"\x89PNG\r\n\x1a\n"
    + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
    + chunk(b"IDAT", zlib.compress(row * height))
    + chunk(b"IEND", b"")
)
header = struct.pack("<HHH", 0, 1, 1)
directory = struct.pack("<BBBBHHII", width, height, 0, 0, 1, 32, len(png), 22)
destination = Path("icons/icon.ico")
destination.parent.mkdir(parents=True, exist_ok=True)
destination.write_bytes(header + directory + png)

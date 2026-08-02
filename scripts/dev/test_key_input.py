"""Standalone test for arrow key reading — run in terminal to verify."""
import sys

# Ensure we're in a real terminal
if not sys.stdout.isatty():
    print("ERROR: Must run in a real terminal, not piped")
    sys.exit(1)

print("Arrow Key Test — press ↑↓ Enter Esc to see what codes are read")
print("Press Ctrl+C to exit\n")

def read_key():
    """Read a single keypress — debug version that shows raw bytes."""
    if sys.platform == "win32":
        import msvcrt
        ch = msvcrt.getch()
        print(f"  RAW first byte: {ch!r} (ord={ord(ch) if len(ch)==1 else 'N/A'})")

        if ch == b'\r' or ch == b'\n':
            return "enter"

        # Extended keys on Windows: \xe0 or \x00 prefix
        if ch == b'\xe0' or ch == b'\x00':
            if msvcrt.kbhit():
                ch2 = msvcrt.getch()
                print(f"  RAW extended byte: {ch2!r}")
                if ch2 == b'H':
                    return "up"
                if ch2 == b'P':
                    return "down"
                if ch2 == b'K':
                    return "left"
                if ch2 == b'M':
                    return "right"

        # ANSI escape sequences (Windows Terminal, ConEmu, etc.)
        if ch == b'\x1b':
            if msvcrt.kbhit():
                ch2 = msvcrt.getch()
                print(f"  RAW esc+2nd: {ch2!r}")
                if ch2 in (b'[', b'O'):
                    if msvcrt.kbhit():
                        ch3 = msvcrt.getch()
                        print(f"  RAW esc+3rd: {ch3!r}")
                        if ch3 == b'A':
                            return "up"
                        if ch3 == b'B':
                            return "down"
                        if ch3 == b'C':
                            return "right"
                        if ch3 == b'D':
                            return "left"
            return "esc"

        # Regular character
        try:
            decoded = ch.decode("utf-8", errors="replace")
            print(f"  Decoded: {decoded!r}")
            return decoded
        except Exception:
            return "?"

    else:
        import termios
        import tty

        fd = sys.stdin.fileno()
        old = termios.tcgetattr(fd)
        try:
            tty.setraw(fd)
            ch = sys.stdin.read(1)
            print(f"  RAW: {ch!r} (ord={ord(ch)})")
            if ch == '\r' or ch == '\n':
                return "enter"
            if ch == '\x1b':
                ch2 = sys.stdin.read(1)
                print(f"  RAW2: {ch2!r}")
                if ch2 == '[':
                    ch3 = sys.stdin.read(1)
                    print(f"  RAW3: {ch3!r}")
                    if ch3 == 'A':
                        return "up"
                    if ch3 == 'B':
                        return "down"
                return "esc"
            return ch
        finally:
            termios.tcsetattr(fd, termios.TCSADRAIN, old)


# Test loop
while True:
    key = read_key()
    print(f"  → RESULT: {key!r}\n")
    if key == 'q':
        break
    if key == 'esc':
        print("  ESC pressed — exiting")
        break

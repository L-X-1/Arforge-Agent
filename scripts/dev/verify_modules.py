# Recovered loader stub. Original source was damaged during a bulk rename attempt.
# Loads the last known-good Python 3.12 bytecode for this module.
import marshal as _marshal
import pathlib as _pathlib
_pyc = _pathlib.Path(__file__).with_name("__pycache__") / 'verify_modules.cpython-312.pyc'
exec(_marshal.loads(_pyc.read_bytes()[16:]), globals())

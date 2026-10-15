import ctypes
import json
import os
from pathlib import Path
import runpy
import sys

class Blob(ctypes.Structure):
    _fields_ = [("size", ctypes.c_ulong), ("data", ctypes.POINTER(ctypes.c_ubyte))]

def key():
    folder = Path(os.environ["LOCALAPPDATA"]) / "VoiceQA"
    path = folder / "openrouter-api-key.dpapi"
    if not path.exists():
        path = folder / "api-key.dpapi"
    encrypted = path.read_bytes()
    buffer = ctypes.create_string_buffer(encrypted)
    source = Blob(len(encrypted), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
    output = Blob()
    if not ctypes.windll.crypt32.CryptUnprotectData(ctypes.byref(source), None, None, None, None, 0, ctypes.byref(output)):
        raise RuntimeError("Cannot decrypt the local OpenRouter credential")
    try:
        return ctypes.string_at(output.data, output.size).decode()
    finally:
        ctypes.windll.kernel32.LocalFree(output.data)

if '--live-paid' not in sys.argv:
    raise SystemExit('Explicit --live-paid is required for Qwen calls')
worker = runpy.run_path(str(Path(__file__).resolve().parents[1] / "agent_s" / "worker.py"))
session = None
for line in sys.stdin:
    try:
        payload = json.loads(line)
        if session is None:
            session = worker["Session"](key(), payload.get("readOnly", False))
        import contextlib, io
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            result = session.call(payload)
        print(json.dumps(result), flush=True)
    except Exception as error:
        import traceback
        frames = [{"file": Path(f.filename).name, "line": f.lineno, "function": f.name} for f in traceback.extract_tb(error.__traceback__)]
        print(json.dumps({"errorClass": type(error).__name__, "error": str(error)[:300], "frames": frames,"candidate":getattr(session.aci,'last_candidate','') if session else '',"response":getattr(session.engine,'last_response','') if session else ''}), flush=True)

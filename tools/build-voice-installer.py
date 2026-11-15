"""Build a self-contained installer with no credentials and no network code."""
import base64
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
source = root / "home-assistant/custom_components/alice_gpt_voice"
files = {}
for path in sorted(source.rglob("*")):
    if not path.is_file() or "__pycache__" in path.parts:
        continue
    data = path.read_bytes().replace(b"\r\n", b"\n")
    files[path.relative_to(source).as_posix()] = {
        "data": base64.b64encode(data).decode(), "sha256": hashlib.sha256(data).hexdigest()
    }
payload = base64.b64encode(json.dumps(files).encode()).decode()
installer = '''"""Install only alice_gpt_voice; never modify existing configuration or credentials."""
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile

FILES = json.loads(base64.b64decode("PAYLOAD"))

def install(base):
    base = Path(base).resolve()
    if not (base / "configuration.yaml").is_file():
        raise SystemExit("Upload this installer beside configuration.yaml, then run it again.")
    parent = base / "custom_components"
    if parent.is_symlink():
        raise SystemExit("Refusing a symlink custom_components directory.")
    parent.mkdir(exist_ok=True)
    target = parent / "alice_gpt_voice"
    if target.exists() or target.is_symlink():
        raise SystemExit("alice_gpt_voice already exists; nothing was overwritten.")
    temporary = Path(tempfile.mkdtemp(prefix=".alice-gpt-install-", dir=parent))
    try:
        for name, item in FILES.items():
            relative = Path(name)
            if relative.is_absolute() or ".." in relative.parts:
                raise SystemExit("Invalid package path.")
            data = base64.b64decode(item["data"], validate=True)
            if hashlib.sha256(data).hexdigest() != item["sha256"]:
                raise SystemExit("Package checksum mismatch.")
            path = temporary / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        manifest = json.loads((temporary / "manifest.json").read_text(encoding="utf-8"))
        if manifest.get("domain") != "alice_gpt_voice":
            raise SystemExit("Invalid package domain.")
        os.rename(temporary, target)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
    print("Installed alice_gpt_voice. Restart Home Assistant, then add the integration.")

if __name__ == "__main__":
    install(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).parent)
'''.replace("PAYLOAD", payload)
destination = root / "public/install-alice-gpt-voice.py"
destination.parent.mkdir(parents=True, exist_ok=True)
destination.write_text(installer, encoding="utf-8", newline="\n")
print(f"Built installer: {len(files)} files")

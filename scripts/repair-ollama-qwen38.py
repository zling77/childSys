#!/usr/bin/env python3
"""Pinned, reversible runtime upgrade for 192.168.1.204; run there with sudo.

The archive must already be downloaded. Existing model blobs and the old runtime
remain in place. No application database or front-end files are accessed.
"""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
import pwd

VERSION = "0.40.6"
SHA256 = "c164ab8b1b28e2a247c29719b8e404c423c5b83ae64c3ab4e59d50c7ff7fc5e0"
SOURCE = Path("/home/a001/.local/share/childpsych-ollama-repair/v0.40.6")
INSTALL = Path("/opt/childpsych-ollama/v0.40.6")
DROPIN = Path("/etc/systemd/system/ollama.service.d/90-childpsych-qwen38.conf")
MARKER = "# ChildPsych pinned Qwen 3.8 runtime repair\n"
MODELS = Path("/usr/share/ollama/.ollama/models")
BASE = "http://192.168.1.204:11434"


def run(*args):
    subprocess.run(args, check=True)


def rollback():
    if DROPIN.exists():
        if not DROPIN.read_text().startswith(MARKER):
            raise RuntimeError("Refusing to replace a drop-in modified by another administrator")
        DROPIN.replace(INSTALL / "disabled-runtime-override.conf")
        run("systemctl", "daemon-reload")
        run("systemctl", "restart", "ollama")
    print("Original runtime restored; original model metadata and blobs retained.")


def main():
    if os.geteuid() != 0:
        sys.exit("Run this script on 192.168.1.204 with sudo; systemd is root-owned.")
    if sys.argv[1:] == ["--rollback"]:
        rollback()
        return
    if sys.argv[1:]:
        sys.exit("Usage: sudo python3 repair-ollama-qwen38.py [--rollback]")
    if INSTALL.exists() or DROPIN.exists():
        sys.exit("Repair target already exists. Inspect it before another install.")
    account = pwd.getpwnam("ollama")
    if not (MODELS / "manifests").is_dir():
        sys.exit("Expected original model manifests were not found.")
    parent = INSTALL.parent
    parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=".stage-", dir=parent))
    archive = stage / "verified-runtime.tar.zst"
    shutil.copyfile(SOURCE / "ollama-linux-amd64.tar.zst", archive)
    digest = hashlib.sha256()
    with archive.open("rb") as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            digest.update(block)
    if digest.hexdigest() != SHA256:
        sys.exit("Official archive SHA256 mismatch; service has not been changed.")
    names = subprocess.check_output(["tar", "--zstd", "-tf", str(archive)], text=True).splitlines()
    if any(PurePosixPath(n).is_absolute() or ".." in PurePosixPath(n).parts for n in names):
        sys.exit("Unsafe archive paths; service has not been changed.")
    runtime = stage / "runtime"
    runtime.mkdir()
    run("tar", "--zstd", "-xf", str(archive), "-C", str(runtime))
    run("chmod", "-R", "go-w", str(runtime))
    models = stage / "models"
    models.mkdir()
    for name in ("manifests", "manifests-v2"):
        if (MODELS / name).is_dir():
            shutil.copytree(MODELS / name, models / name)
    # Only metadata is copied. All installed models retain their original blobs.
    (models / "blobs").symlink_to(MODELS / "blobs", target_is_directory=True)
    for path in [models, *models.rglob("*")]:
        os.chown(path, account.pw_uid, account.pw_gid, follow_symlinks=False)
    stage.chmod(0o755)
    stage.replace(INSTALL)
    DROPIN.parent.mkdir(parents=True, exist_ok=True)
    DROPIN.write_text(MARKER + "[Service]\nExecStart=\n"
                      + f"ExecStart={INSTALL}/runtime/bin/ollama serve\n"
                      + f'Environment="OLLAMA_MODELS={INSTALL}/models"\n'
                      + 'Environment="OLLAMA_CONTEXT_LENGTH=8192"\n'
                      + 'Environment="OLLAMA_NUM_PARALLEL=1"\n')
    try:
        run("systemctl", "daemon-reload")
        run("systemctl", "restart", "ollama")
        for attempt in range(60):
            try:
                version = json.load(urllib.request.urlopen(BASE + "/api/version", timeout=2))
                if version.get("version") == VERSION:
                    break
            except Exception:
                pass
            time.sleep(0.5)
        else:
            raise RuntimeError("New runtime did not become ready")
        payload = {"model": "qwen3.8:27b", "stream": False, "think": False,
                   "messages": [{"role": "user", "content": "只回复：调用成功"}],
                   "options": {"num_ctx": 8192, "num_predict": 32}}
        request = urllib.request.Request(BASE + "/api/chat", data=json.dumps(payload).encode(),
                                         headers={"Content-Type": "application/json"})
        response = json.load(urllib.request.urlopen(request, timeout=120))
        if not response.get("done") or not response.get("message", {}).get("content"):
            raise RuntimeError("Model warm-up did not return a complete response")
        print(json.dumps({"version": VERSION, "endpoint": BASE, "model": response["model"],
                          "reply": response["message"]["content"], "rollback": "rerun with --rollback"},
                         ensure_ascii=False))
    except BaseException:
        rollback()
        raise


if __name__ == "__main__":
    main()

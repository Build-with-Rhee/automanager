#!/usr/bin/env python3
"""Provision CPU speech engines and complete verified offline packs into a chosen directory.

Requires Python 3.11/3.12, C++ compiler and make (or Visual Studio C++ tools on Windows).
No TLS bypass, no shell interpolation, and no automatic downloads during inference.
"""
import argparse
import hashlib
import importlib.util
import json
import os
import pathlib
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.parse
import urllib.request
import venv

REPOSITORY = pathlib.Path(__file__).resolve().parent.parent
RESOURCES = REPOSITORY / "resources" / "engines"
spec = importlib.util.spec_from_file_location("safe_unpack", RESOURCES / "unpack.py")
unpacker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(unpacker)


def run(args, **kwargs):
    subprocess.run([str(arg) for arg in args], check=True, **kwargs)


def verify(path, artifact):
    if not path.is_file() or path.is_symlink() or path.stat().st_size != artifact["sizeBytes"]:
        return False
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for data in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(data)
    return digest.hexdigest() == artifact["sha256"]


def download(artifact, path):
    if verify(path, artifact):
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    url = artifact["url"]
    if urllib.parse.urlparse(url).scheme != "https":
        raise RuntimeError("Only HTTPS downloads are supported")
    if shutil.disk_usage(path.parent).free < artifact["sizeBytes"] + 512 * 1024 ** 2:
        raise RuntimeError("Download would violate the 512 MiB free-space reserve")
    staging = path.with_name(path.name + ".part")
    try:
        with urllib.request.urlopen(url, timeout=60) as response, staging.open("wb") as output:
            if urllib.parse.urlparse(response.url).scheme != "https":
                raise RuntimeError("Insecure download redirect")
            count = 0
            for data in iter(lambda: response.read(1024 * 1024), b""):
                count += len(data)
                if count > artifact["sizeBytes"]:
                    raise RuntimeError("Download exceeds pinned size")
                output.write(data)
            output.flush()
            os.fsync(output.fileno())
        if not verify(staging, artifact):
            raise RuntimeError("Artifact size/SHA-256 mismatch: " + path.name)
        staging.replace(path)
    finally:
        staging.unlink(missing_ok=True)


def provision_model(model, directory, cache):
    target = directory / "models" / model["id"]
    if all(verify(target / a["path"], a) for a in model["artifacts"]):
        print("Verified existing model:", model["id"], flush=True)
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    required = sum(a["sizeBytes"] for a in model["artifacts"]) + model.get("archive", {}).get("sizeBytes", 0)
    if shutil.disk_usage(target.parent).free < required + 512 * 1024 ** 2:
        raise RuntimeError("Insufficient space for complete model pack")
    staging = pathlib.Path(tempfile.mkdtemp(prefix="." + model["id"] + "-", dir=target.parent))
    try:
        if "archive" in model:
            artifact = model["archive"]
            archive = cache / (artifact["sha256"] + ".tar.bz2")
            download(artifact, archive)
            unpacker.unpack(archive, staging, artifact["prefix"])
        else:
            for artifact in model["artifacts"]:
                download(artifact, staging / artifact["path"])
        if not all(verify(staging / a["path"], a) for a in model["artifacts"]):
            raise RuntimeError("Incomplete/corrupt model pack")
        backup = target.with_name(target.name + ".old")
        if backup.exists():
            shutil.rmtree(backup)
        if target.exists():
            target.replace(backup)
        try:
            staging.replace(target)
        except BaseException:
            if backup.exists():
                backup.replace(target)
            raise
        if backup.exists():
            shutil.rmtree(backup)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    print("Installed and SHA-256 verified model:", model["id"], flush=True)


def source(name, metadata, directory, cache):
    artifact = metadata[name]
    archive = cache / artifact["path"]
    download(artifact, archive)
    target = directory / "sources" / name
    if not target.exists():
        prefix = ("whisper.cpp-" if name == "whisper" else "MeloTTS-") + artifact["revision"] + "/"
        unpacker.unpack(archive, target, prefix)
    return target


def portable_python(metadata, directory, cache):
    if platform.machine().lower() not in ("x86_64", "amd64") or sys.platform not in ("linux", "win32"):
        raise RuntimeError("Reviewed portable Python packs support Linux x64 and Windows x64")
    name = "python-windows-x64" if os.name == "nt" else "python-linux-x64"
    artifact = metadata[name]
    archive_path = cache / artifact["path"]
    download(artifact, archive_path)
    target = directory / "python-portable"
    receipt = target / "automanager-runtime.json"
    expected = artifact["sha256"]
    if not receipt.exists() or json.loads(receipt.read_text()).get("sha256") != expected:
        staging = pathlib.Path(tempfile.mkdtemp(prefix=".python-portable-", dir=directory))
        try:
            with tarfile.open(archive_path, "r:gz") as archive:
                links = []
                total = 0
                members = archive.getmembers()
                if len(members) > 50000:
                    raise RuntimeError("Portable Python archive has excessive entries")
                for member in members:
                    if not member.name.startswith("python/"):
                        raise RuntimeError("Unexpected portable Python archive prefix")
                    relative = pathlib.PurePosixPath(member.name[len("python/"):])
                    if not relative.parts:
                        continue
                    if relative.is_absolute() or ".." in relative.parts or "\\" in str(relative) or ":" in str(relative):
                        raise RuntimeError("Portable Python path escapes destination")
                    path = staging.joinpath(*relative.parts)
                    if member.isdir():
                        path.mkdir(parents=True, exist_ok=True)
                    elif member.isfile():
                        total += member.size
                        if total > 1024 ** 3:
                            raise RuntimeError("Portable Python archive exceeds extraction budget")
                        path.parent.mkdir(parents=True, exist_ok=True)
                        with archive.extractfile(member) as incoming, path.open("xb") as outgoing:
                            shutil.copyfileobj(incoming, outgoing)
                        path.chmod(member.mode & 0o755 if member.mode & 0o111 else 0o644)
                    elif member.issym() or member.islnk():
                        links.append((member, path))
                    else:
                        raise RuntimeError("Unsupported portable Python archive member")
                # Allow only internal links from the SHA-256-verified runtime archive.
                # Links are created after all files, so none can redirect extraction writes.
                for member, path in links:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    if member.issym():
                        linked = (path.parent / member.linkname).resolve()
                        if pathlib.Path(member.linkname).is_absolute() or not linked.is_relative_to(staging.resolve()):
                            raise RuntimeError("Portable Python symlink escapes runtime")
                        path.symlink_to(member.linkname)
                    else:
                        if not member.linkname.startswith("python/"):
                            raise RuntimeError("Portable Python hardlink escapes runtime")
                        linked = (staging / member.linkname[len("python/"):]).resolve()
                        if not linked.is_relative_to(staging.resolve()) or not linked.is_file():
                            raise RuntimeError("Invalid portable Python hardlink")
                        shutil.copyfile(linked, path)
            (staging / "automanager-runtime.json").write_text(json.dumps(artifact, indent=2) + "\n")
            if target.exists():
                shutil.rmtree(target)
            staging.replace(target)
        finally:
            if staging.exists():
                shutil.rmtree(staging)
    python = target / ("python.exe" if os.name == "nt" else "bin/python3")
    run([python, "-c", "import ssl,sys;assert sys.version_info[:2]==(3,12);print('Portable CPython verified:',sys.version.split()[0])"])
    return python


def mirror_tts_sources(metadata, directory, cache):
    archives = directory / "source-archives"
    archives.mkdir(exist_ok=True)
    for name in ("sherpa", "espeak"):
        artifact = metadata[name]
        downloaded = cache / artifact["path"]
        download(artifact, downloaded)
        destination = archives / artifact["path"]
        if not verify(destination, artifact):
            shutil.copyfile(downloaded, destination)
    shutil.copyfile(RESOURCES / "THIRD_PARTY_NOTICES.md", directory / "THIRD_PARTY_NOTICES.md")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", required=True, help="Runtime destination, e.g. resources/engines/runtime")
    parser.add_argument("--whisper", action="store_true")
    parser.add_argument("--python", action="store_true", help="Install owned Korean Melo and sherpa/Kokoro Python runtime")
    parser.add_argument("--portable-python", action="store_true", help="Use reviewed standalone CPython for a relocatable target-OS engine pack")
    parser.add_argument("--models", nargs="*", default=[])
    parser.add_argument("--jobs", type=int, default=4)
    args = parser.parse_args()
    if not any([args.whisper, args.python, args.models]):
        parser.error("Select --whisper, --python, and/or --models")
    directory = pathlib.Path(args.directory).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    cache = directory / "cache"
    cache.mkdir(exist_ok=True)
    metadata = json.loads((RESOURCES / "runtime-sources.json").read_text())
    paths_file = directory / "engine-paths.json"
    paths = json.loads(paths_file.read_text()) if paths_file.exists() else {}
    environment = directory / "python"
    python = environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if args.portable_python:
        python = portable_python(metadata, directory, cache)
        environment = python.parent if os.name == "nt" else python.parent.parent
    if args.python or args.whisper and shutil.which("cmake") is None:
        if not python.exists():
            venv.EnvBuilder(with_pip=True).create(environment)
        run([python, "-m", "pip", "install", "--disable-pip-version-check", "--no-input", "cmake==3.31.6"])
    if args.whisper:
        original = source("whisper", metadata, directory, cache)
        cmake = [shutil.which("cmake")] if shutil.which("cmake") else [python, "-m", "cmake"]
        build = directory / "whisper" / "build"
        run([*cmake, "-S", original, "-B", build, "-DCMAKE_BUILD_TYPE=Release", "-DCMAKE_BUILD_RPATH_USE_ORIGIN=ON", "-DCMAKE_INSTALL_RPATH=$ORIGIN", "-DWHISPER_BUILD_SERVER=ON",
             "-DWHISPER_BUILD_TESTS=OFF", "-DGGML_NATIVE=OFF", "-DGGML_CUDA=OFF", "-DGGML_VULKAN=OFF"])
        run([*cmake, "--build", build, "--config", "Release", "--target", "whisper-server", "whisper-cli", "--parallel", str(max(1, min(args.jobs, 8)))])
        candidates = [build / "bin" / "whisper-server", build / "bin" / "Release" / "whisper-server.exe", build / "bin" / "whisper-server.exe"]
        executable = next((p for p in candidates if p.exists()), None)
        if executable is None:
            raise RuntimeError("whisper-server build output missing")
        run([executable, "--help"], stdout=subprocess.DEVNULL)
        paths["whisper"] = str(executable.relative_to(directory))
        print("Built whisper.cpp CPU runtime", flush=True)
    if args.python:
        run([python, "-m", "pip", "install", "--disable-pip-version-check", "--no-input", "--index-url",
             "https://download.pytorch.org/whl/cpu", "torch==2.5.1", "torchaudio==2.5.1"])
        # Stock Melo's transformers 4.27 pin requires tokenizers 0.13, which has no
        # Python 3.12 wheels. BERT APIs used here are verified with 4.41/0.19.
        requirements = ["wheel==0.45.1", "numpy==1.26.4", "transformers==4.41.2", "tokenizers==0.19.1", "cached_path==1.6.7", "txtsplit==1.0.0",
                        "num2words==0.5.12", "anyascii==0.3.2", "jamo==0.4.1", "g2pkk==0.1.2", "nltk==3.9.1",
                        "python-mecab-ko==1.3.7", "python-mecab-ko-dic==2.1.1.post2", "librosa==0.9.2",
                        "soundfile==0.13.1", "pydub==0.25.1", "langid==1.1.6", "unidecode==1.3.7",
                        "sherpa-onnx==1.13.8", "onnxruntime==1.20.1", "tqdm==4.67.1"]
        run([python, "-m", "pip", "install", "--disable-pip-version-check", "--no-input", *requirements])
        original = source("melo", metadata, directory, cache)
        run([python, "-m", "pip", "install", "--disable-pip-version-check", "--no-input", "--no-deps", "--no-build-isolation", str(original)])
        run([python, "-c", "import torch,torchaudio,melo,sherpa_onnx,onnxruntime,mecab,librosa;print('Engine runtime imports passed')"])
        frozen = subprocess.check_output([str(python), "-m", "pip", "freeze"], text=True)
        # The reviewed source artifact, rather than a build-machine file URL, owns Melo's pin.
        frozen = "\n".join("melotts==0.1.2" if line.lower().startswith("melotts @") else line for line in frozen.splitlines()) + "\n"
        (directory / "python-dependencies.lock.txt").write_text(frozen)
        paths["melo"] = paths["sherpa"] = str(python.relative_to(directory))
        mirror_tts_sources(metadata, directory, cache)
    models = json.loads((RESOURCES / "models.json").read_text())
    for id in args.models:
        model = next((m for m in models if m["id"] == id), None)
        if model is None:
            raise ValueError("Unknown model: " + id)
        provision_model(model, directory, cache)
    temporary = paths_file.with_suffix(".part")
    temporary.write_text(json.dumps(paths, indent=2) + "\n")
    temporary.replace(paths_file)
    (directory / "runtime-platform.json").write_text(json.dumps({"platform": sys.platform,
        "architecture": "x64" if platform.machine().lower() in ("amd64", "x86_64") else platform.machine().lower(),
        "portablePython": args.portable_python}, indent=2) + "\n")
    print("Saved engine-paths.json. Run actual offline STT/TTS samples before claiming inference readiness.", flush=True)


if __name__ == "__main__":
    main()

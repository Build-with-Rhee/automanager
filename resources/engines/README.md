Speech runtime resources are scripts and reviewed manifests; executable engines are provisioned separately.

From the repository root, with Python 3.11/3.12 and a C++ compiler:

```
python3 scripts/setup-engines.py --directory resources/engines/runtime --portable-python --whisper --python --models whisper-base melo-ko kokoro-en
```

Windows: run the PowerShell wrapper from a Visual Studio C++ developer shell:

```
.\scripts\setup-engines.ps1 -Directory resources\engines\runtime -PortablePython -Whisper -Python -Models whisper-base,melo-ko,kokoro-en
```

The setup script verifies source and model SHA-256/byte sizes, preserves TLS verification, builds CPU whisper-server/whisper-cli, installs pinned direct Python dependencies, and saves the resolved dependency list and executable paths. Source files remain in runtime/sources for attribution and corresponding-source distribution. Transitive Python resolution is recorded for review; rerunning from scratch can resolve different transitive versions.

`--portable-python` provisions official Astral python-build-standalone CPython 3.12.15 release 20261009, with reviewed immutable URL, byte size, and upstream SHA-256 for Linux x64 or Windows x64. It installs Python and dependencies in `runtime/python-portable` and writes relative executable paths. Keep the interpreter, standard library, native libraries, and site-packages together when moving this pack. Build on the target OS; a Linux runtime pack does not supply Windows binaries. The command itself uses host Python as a bootstrap, but inference uses the owned portable interpreter. Without this option, the script creates a machine-specific virtual environment requiring the host Python installation.

`EngineManager` discovers `runtime/engine-paths.json` and `runtime/models/<model-id>` under its resources directory. Custom executable selections are persisted in the application's data directory. Pick `whisper-server`, not `whisper-cli`; Melo/sherpa selections are Python interpreter executables. Model imports use an exact, fully verified pack directory (a single `.bin` file is also accepted for Whisper).

Models: whisper-base, whisper-small, whisper-turbo; melo-ko; kokoro-en. Voices: melo-ko (Korean), af_heart (American English). Kokoro's reviewed archive includes multilingual assets, but this adapter exposes English only. Model sizes shown in the application include model assets; Python runtime and dependencies consume additional space.

MIT applies to whisper.cpp/Whisper and Melo model/code. Korean BERT uses Apache-2.0, and the CMU pronunciation dictionary carries its upstream terms. Kokoro weights use Apache-2.0; sherpa's TTS build and the included eSpeak NG data introduce GPLv3 obligations. The setup script mirrors reviewed sherpa/eSpeak source archives and THIRD_PARTY_NOTICES.md into the managed runtime. Retain complete corresponding source/distribution materials and compatible derivative binary licensing when conveying precise runtime binaries and voice data. Runtime Python package licenses reside in the installed distributions. No permissive-only license claim is made for the complete binary pack. Keep runtime/source-archives and notices in the engine pack; cache archives can be excluded.

The resident Korean helper uses the original Korean G2P/BERT path and replaces Melo's eager multilingual cleaner imports with a Korean-only route. Hugging Face downloads and NLTK downloads are disabled; all asset paths are local. Actual offline Korean/English synthesis and target-OS STT must be tested after provisioning. These scripts are not evidence of Windows engine readiness or redistribution portability.

The owned runtime uses transformers 4.41.2 / tokenizers 0.19.1 rather than Melo's upstream 4.27.4 pin, because tokenizers 0.13 lacks Python 3.12 wheels. It installs the reviewed Melo source with `--no-deps` and verifies its Korean BERT/tokenizer API through the worker's startup and synthesis checks.

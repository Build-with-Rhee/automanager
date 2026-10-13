Automanager managed speech engine pack

whisper.cpp and original Whisper weights use the MIT License. The reviewed whisper.cpp source is retained under runtime/sources/whisper, including its LICENSE. https://github.com/ggml-org/whisper.cpp

MeloTTS source and Korean voice weights declare MIT. The reviewed source and license are retained under runtime/sources/melo. Korean BERT pretrained assets use Apache-2.0 according to their originating LM-kor repository. https://github.com/myshell-ai/MeloTTS and https://github.com/kiyoungkim1/LM-kor

The CMU pronunciation dictionary archive includes its upstream copyright and redistribution terms. Preserve that dictionary and its notices when conveying the Korean model pack. https://github.com/cmusphinx/cmudict

Kokoro weights declare Apache-2.0. Their reviewed converted model archive includes LICENSE. https://huggingface.co/hexgrad/Kokoro-82M

sherpa-onnx source declares Apache-2.0, but TTS builds statically include eSpeak NG, whose code/data use GPLv3. The combined TTS runtime requires the applicable GPL-compatible distribution terms and corresponding source. This pack mirrors the reviewed sherpa-onnx v1.13.8 source and its pinned eSpeak fork in runtime/source-archives, with full licenses and build scripts inside the archives. URLs and SHA-256 values are recorded in resources/engines/runtime-sources.json. The source recipe fetches additional documented ONNX Runtime/build dependencies; retain the complete source/distribution materials for the precise binaries and voice data being conveyed. https://github.com/k2-fsa/sherpa-onnx/tree/v1.13.8 and https://github.com/csukuangfj/espeak-ng/tree/ed530aa113046142eb5115cf2fc9157854d0ffe1

Portable CPython is the official Astral python-build-standalone CPython 3.12.15 distribution (PSF license and bundled dependency terms), pinned to release 20261009. Keep its included licenses with the interpreter. https://github.com/astral-sh/python-build-standalone

PyTorch/torchaudio, ONNX Runtime, transformers, tokenizers, MeCab, and other Python dependencies retain their installed distribution license files and metadata under site-packages. The tested installed dependency list is runtime/python-dependencies.lock.txt. Direct source pins and model pins are separate from that dependency list.

This notice records bundled components and source locations; it does not replace their full license texts or claim that all components share the application's license. Build, package, and verify the runtime on the target OS, preserving each component's licensing and source requirements.

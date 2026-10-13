"""Owned resident TTS worker. All inference assets are local and protocol stdout is JSON only."""
import argparse
import contextlib
import importlib
import json
import os
import pathlib
import socket
import sys
import types

os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", TOKENIZERS_PARALLELISM="false")


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def load_melo(root):
    os.environ["NLTK_DATA"] = str(root / "nltk_data")
    import nltk
    import torch
    from transformers import AutoTokenizer, AutoModelForMaskedLM
    torch.set_num_threads(2)

    def no_download(*args, **kwargs):
        raise RuntimeError("Offline G2P assets missing; reinstall the complete Korean model pack")
    nltk.download = no_download
    tokenizer_loader = AutoTokenizer.from_pretrained
    bert_loader = AutoModelForMaskedLM.from_pretrained

    def local_model(name, loader, **kwargs):
        if str(name) != "kykim/bert-kor-base":
            raise RuntimeError("Unexpected external model dependency: " + str(name))
        kwargs["local_files_only"] = True
        return loader(str(root / "bert"), **kwargs)
    AutoTokenizer.from_pretrained = staticmethod(lambda name, **kwargs: local_model(name, tokenizer_loader, **kwargs))
    AutoModelForMaskedLM.from_pretrained = staticmethod(lambda name, **kwargs: local_model(name, bert_loader, **kwargs))

    # Melo's stock cleaner eagerly imports every language. This owned Korean path
    # loads only the original Korean G2P/BERT implementation, with local model paths.
    import melo.text
    korean = importlib.import_module("melo.text.korean")
    cleaner = types.ModuleType("melo.text.cleaner")

    def clean_text(text, language):
        if language != "KR":
            raise ValueError("This worker supports Korean only")
        normalized = korean.text_normalize(text)
        phones, tones, word2ph = korean.g2p(normalized)
        return normalized, phones, tones, word2ph
    cleaner.clean_text = clean_text
    sys.modules["melo.text.cleaner"] = cleaner
    melo.text.get_bert = lambda text, word2ph, language, device: korean.get_bert_feature(text, word2ph, device)
    from melo.api import TTS
    engine = TTS(language="KR", device="cpu", config_path=str(root / "config.json"), ckpt_path=str(root / "checkpoint.pth"))
    # Prewarm the dictionary and BERT now so missing assets fail startup, not a later job.
    normalized, _, _, alignment = clean_text("안녕하세요", "KR")
    korean.get_bert_feature(normalized, alignment, "cpu")
    return engine


def load_kokoro(root):
    import onnxruntime
    import sherpa_onnx
    options = onnxruntime.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    session = onnxruntime.InferenceSession(str(root / "model.int8.onnx"), options, providers=["CPUExecutionProvider"])
    metadata = session.get_modelmeta().custom_metadata_map
    del session
    # The approved sherpa export stores `name->id` pairs, not JSON.
    speakers = {name: int(identifier) for name, identifier in
                (pair.rsplit("->", 1) for pair in metadata["speaker2id"].split(","))}
    if "af_heart" not in speakers:
        raise RuntimeError("Pinned Kokoro model does not contain the requested af_heart voice")
    config = sherpa_onnx.OfflineTtsConfig(model=sherpa_onnx.OfflineTtsModelConfig(
        kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(
            model=str(root / "model.int8.onnx"), voices=str(root / "voices.bin"),
            tokens=str(root / "tokens.txt"), data_dir=str(root / "espeak-ng-data"),
            lexicon=str(root / "lexicon-us-en.txt"), lang="en-us"), num_threads=2, provider="cpu"))
    if not config.validate():
        raise RuntimeError("Invalid Kokoro model configuration")
    return sherpa_onnx.OfflineTts(config), speakers


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine", choices=["melo", "sherpa"], required=True)
    parser.add_argument("--models", required=True)
    args = parser.parse_args()
    root = pathlib.Path(args.models).resolve()
    with contextlib.redirect_stdout(sys.stderr):
        engine = load_melo(root) if args.engine == "melo" else load_kokoro(root)
        import soundfile
    # The worker uses pipes, not sockets. Make accidental Python network access fail.
    class OfflineSocket(socket.socket):
        def connect(self, address):
            raise RuntimeError("Network is disabled in local speech workers")
    socket.socket = OfflineSocket
    emit({"ready": True})
    for line in sys.stdin:
        request = {}
        try:
            if len(line) > 65536:
                raise ValueError("TTS request too large")
            request = json.loads(line)
            text = request["text"]
            speed = float(request.get("speed", 1))
            output = pathlib.Path(request["output"])
            if not isinstance(text, str) or not text.strip() or len(text) > 10000 or not 0.5 <= speed <= 2:
                raise ValueError("Invalid synthesis text or speed")
            if not output.is_absolute() or output.suffix != ".wav":
                raise ValueError("Expected an absolute WAV output path")
            with contextlib.redirect_stdout(sys.stderr):
                if args.engine == "melo":
                    if request.get("voice") != "melo-ko":
                        raise ValueError("Unsupported Korean voice")
                    audio = engine.tts_to_file(text, speaker_id=engine.hps.data.spk2id["KR"], speed=speed, quiet=True)
                    rate = engine.hps.data.sampling_rate
                else:
                    tts, speakers = engine
                    voice = "af_heart" if request.get("voice") == "kokoro-en" else request.get("voice")
                    if voice != "af_heart":
                        raise ValueError("Unsupported English voice")
                    result = tts.generate(text, sid=int(speakers[voice]), speed=speed)
                    audio, rate = result.samples, result.sample_rate
                if len(audio) == 0:
                    raise RuntimeError("Engine returned empty audio")
                soundfile.write(str(output), audio, rate, subtype="PCM_16", format="WAV")
            emit({"id": request["id"], "result": {"output": str(output), "sampleRate": rate}})
        except Exception as error:
            emit({"id": request.get("id", "invalid"), "error": f"{type(error).__name__}: {error}"})


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit({"error": f"{type(error).__name__}: {error}"})
        sys.exit(1)

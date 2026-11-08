"""One bounded local job. No service/network calls; model is a preinstalled local path."""
import json
import os
import sys

MAX_SECONDS = 300
SAMPLE_RATE = 16000


def decode_bounded(filename):
    import av
    import numpy as np

    if os.path.getsize(filename) > 20 * 1024 * 1024:
        raise ValueError("invalid-audio")
    parts = []
    samples = 0
    with av.open(filename, options={"protocol_whitelist": "file,pipe"}) as container:
        if len(container.streams.audio) != 1 or len(container.streams.video):
            raise ValueError("invalid-audio")
        stream = container.streams.audio[0]
        stream.codec_context.thread_count = 1
        resampler = av.AudioResampler(format="fltp", layout="mono", rate=SAMPLE_RATE)
        for frame in container.decode(stream):
            for audio in resampler.resample(frame):
                values = audio.to_ndarray().reshape(-1)
                samples += len(values)
                if samples > SAMPLE_RATE * MAX_SECONDS:
                    raise ValueError("invalid-audio")
                parts.append(values)
        for audio in resampler.resample(None):
            values = audio.to_ndarray().reshape(-1)
            samples += len(values)
            if samples > SAMPLE_RATE * MAX_SECONDS:
                raise ValueError("invalid-audio")
            parts.append(values)
    if not samples:
        raise ValueError("invalid-audio")
    return np.concatenate(parts), samples / SAMPLE_RATE


def main():
    try:
        audio, duration = decode_bounded(sys.argv[1])
    except Exception:
        return 2
    # Import/load inference only after the file's actual decoded size/duration is validated.
    from faster_whisper import WhisperModel
    model = WhisperModel(sys.argv[2], device="cpu", compute_type="int8", cpu_threads=2, num_workers=1, local_files_only=True)
    segments, _ = model.transcribe(audio, beam_size=1, vad_filter=True, condition_on_previous_text=False)
    text = " ".join(segment.text.strip() for segment in segments).strip()
    if len(text) > 20000:
        return 3
    print(json.dumps({"text": text, "duration": duration}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())

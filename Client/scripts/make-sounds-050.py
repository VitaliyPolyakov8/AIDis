"""0.5.0 interface sounds, synthesized from scratch (no samples, no third-party audio).

  notify.wav        new message notification: a short, playful two-syllable "quack-like" honk
                    (a buzzy source with a falling pitch through duck-ish formants), not too loud
  viewer-join.wav   someone started watching your / this stream: a soft rising two-note chime
  viewer-leave.wav  someone stopped watching: the same family, falling and quieter

Run: python scripts/make-sounds-050.py   (writes into src/assets/sounds, 48 kHz mono 16-bit)
"""
import math
import os
import random
import struct
import wave

RATE = 48000
OUT = os.path.join(os.path.dirname(__file__), '..', 'src', 'assets', 'sounds')


def write(name, samples, peak):
    m = max(abs(s) for s in samples) or 1.0
    with wave.open(os.path.join(OUT, name), 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(b''.join(struct.pack('<h', int(max(-1, min(1, s / m * peak)) * 32767)) for s in samples))


class Resonator:
    """Two-pole band-pass (formant) filter."""

    def __init__(self, freq, bw):
        r = math.exp(-math.pi * bw / RATE)
        self.a1 = 2 * r * math.cos(2 * math.pi * freq / RATE)
        self.a2 = -r * r
        self.g = 1 - r
        self.y1 = self.y2 = 0.0

    def __call__(self, x):
        y = self.g * x + self.a1 * self.y1 + self.a2 * self.y2
        self.y2, self.y1 = self.y1, y
        return y


def honk(duration, f_start, f_end, formants, vibrato=0.0):
    n = int(duration * RATE)
    filters = [(Resonator(f, bw), gain) for f, bw, gain in formants]
    out, phase = [], 0.0
    rnd = random.Random(7)
    for i in range(n):
        t = i / n
        f = f_start * (f_end / f_start) ** t * (1 + vibrato * math.sin(2 * math.pi * 28 * i / RATE))
        phase += f / RATE
        saw = 2 * (phase % 1.0) - 1  # buzzy, reed-like source
        src = saw + 0.04 * (rnd.random() * 2 - 1)
        y = sum(flt(src) * gain for flt, gain in filters)
        env = min(1.0, i / (0.012 * RATE)) * (1 - t) ** 1.6
        out.append(y * env)
    return out


def chime(notes, note_len, gap, decay):
    out = []
    for k, f in enumerate(notes):
        n = int(note_len * RATE)
        for i in range(n):
            tt = i / RATE
            env = min(1.0, i / (0.004 * RATE)) * math.exp(-tt * decay)
            s = math.sin(2 * math.pi * f * tt) + 0.3 * math.sin(2 * math.pi * 2 * f * tt) * math.exp(-tt * 18)
            out.append(s * env)
        if k < len(notes) - 1:
            out.extend([0.0] * int(gap * RATE))
    return out


duck = [(1050, 220, 1.0), (2300, 300, 0.55), (3400, 400, 0.25)]
quack = honk(0.085, 420, 330, duck, 0.02) + [0.0] * int(0.035 * RATE) + honk(0.13, 390, 250, duck, 0.03)
write('notify.wav', quack, 0.55)
write('viewer-join.wav', chime([740, 988], 0.16, 0.0, 16), 0.42)
write('viewer-leave.wav', chime([880, 659], 0.15, 0.0, 20), 0.3)
print('ok')

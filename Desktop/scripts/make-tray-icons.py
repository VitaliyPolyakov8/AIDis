"""Generates the tray state icons (assets/tray/*.ico).

0.4.5 (Discord-like): while in voice the tray shows a microphone, not the logo, so the state is
readable at a glance in a 16 px tray slot. Each icon is drawn per size (16, 20, 24, 32, 40, 48 px)
with 8x supersampling:

  tray-voice.ico     in voice, mic on, silent: dim grey microphone (low intensity, NOT a mute look)
  tray-speaking.ico  speaking: bright green microphone with a soft green halo
  tray-muted.ico     microphone muted: red microphone with a slash
  tray-deafened.ico  deafened: red headphones with a slash

Not in voice: the normal AIDis icon (assets/aidis.ico).
Run: python scripts/make-tray-icons.py   (needs Pillow; only for regenerating the assets)
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'assets' / 'tray'
SIZES = [16, 20, 24, 32, 40, 48]
SS = 8

STATES = {
    'voice': {'color': (150, 156, 170, 170), 'glyph': 'mic', 'slash': False, 'halo': None},
    'speaking': {'color': (63, 222, 155, 255), 'glyph': 'mic', 'slash': False, 'halo': (63, 212, 155, 120)},
    'muted': {'color': (240, 72, 82, 255), 'glyph': 'mic', 'slash': True, 'halo': None},
    'deafened': {'color': (240, 72, 82, 255), 'glyph': 'headphones', 'slash': True, 'halo': None},
}


def draw_mic(d, c, s, color, w):
    cw, ch = s * 0.30, s * 0.46
    d.rounded_rectangle([c - cw / 2, s * 0.08, c + cw / 2, s * 0.08 + ch], radius=cw / 2, fill=color)
    d.arc([c - s * 0.30, s * 0.20, c + s * 0.30, s * 0.70], start=0, end=180, fill=color, width=w)
    d.line([c, s * 0.69, c, s * 0.86], fill=color, width=w)
    d.line([c - s * 0.17, s * 0.88, c + s * 0.17, s * 0.88], fill=color, width=w)


def draw_headphones(d, c, s, color, w):
    d.arc([c - s * 0.38, s * 0.12, c + s * 0.38, s * 0.84], start=180, end=360, fill=color, width=w)
    ew, eh = s * 0.22, s * 0.36
    d.rounded_rectangle([c - s * 0.42, s * 0.46, c - s * 0.42 + ew, s * 0.46 + eh], radius=ew / 3, fill=color)
    d.rounded_rectangle([c + s * 0.42 - ew, s * 0.46, c + s * 0.42, s * 0.46 + eh], radius=ew / 3, fill=color)


def icon(size, state):
    big = size * SS
    img = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    if state['halo']:
        halo = Image.new('RGBA', (big, big), (0, 0, 0, 0))
        ImageDraw.Draw(halo).ellipse([big * 0.05, big * 0.05, big * 0.95, big * 0.95], fill=state['halo'])
        img.alpha_composite(halo.filter(ImageFilter.GaussianBlur(big * 0.07)))
    glyph = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(glyph)
    w = max(SS, int(big * (0.11 if size <= 20 else 0.09)))
    c = big / 2
    if state['glyph'] == 'mic':
        draw_mic(d, c, big, state['color'], w)
    else:
        draw_headphones(d, c, big, state['color'], w)
    if state['slash']:
        line = [big * 0.14, big * 0.10, big * 0.88, big * 0.92]
        # Cut a gap around the slash so it stays legible on any taskbar color.
        mask = Image.new('L', (big, big), 255)
        ImageDraw.Draw(mask).line(line, fill=0, width=int(w * 2.4))
        glyph.putalpha(Image.composite(glyph.getchannel('A'), Image.new('L', (big, big), 0), mask))
        ImageDraw.Draw(glyph).line(line, fill=state['color'], width=w)
    img.alpha_composite(glyph)
    return img.resize((size, size), Image.LANCZOS)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for name, state in STATES.items():
        frames = [icon(size, state) for size in SIZES]
        frames[-1].save(OUT / f'tray-{name}.ico', sizes=[(s, s) for s in SIZES], append_images=frames[:-1])
    print('written', sorted(p.name for p in OUT.iterdir()))


if __name__ == '__main__':
    main()

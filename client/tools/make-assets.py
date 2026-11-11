#!/usr/bin/env python3
"""
Generates the ORIGINAL game assets used in Lab 03 (no third-party art or audio):

  public/assets/sprites.png   sprite sheet, 8 x 2 cells of 128 x 128 px
  public/assets/sprites.json  atlas: frame rectangles (+ how to scale them to an entity)
  public/assets/sounds/*.wav  four short synthesised effects

The generated files are committed, so you do NOT need to run this to play the game.
Re-generate with:  python3 tools/make-assets.py     (needs: pillow, numpy)
"""
import json
import math
import random
import wave
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent / "public" / "assets"
CELL = 128
SS = 4  # supersampling factor for anti-aliasing
COLS, ROWS = 8, 2


def new_cell():
    img = Image.new("RGBA", (CELL * SS, CELL * SS), (0, 0, 0, 0))
    return img, ImageDraw.Draw(img)


def px(points):
    return [(x * SS, y * SS) for x, y in points]


def finish(img):
    return img.resize((CELL, CELL), Image.LANCZOS)


def glow(img, blur, strength=1.0):
    """Soft halo under the sprite: blurred copy of its alpha, tinted with its own colours."""
    halo = img.filter(ImageFilter.GaussianBlur(blur * SS))
    r, g, b, a = halo.split()
    a = a.point(lambda v: min(255, int(v * strength)))
    halo = Image.merge("RGBA", (r, g, b, a))
    return Image.alpha_composite(halo, img)


# --------------------------------------------------------------------------- ship
def ship(thrust):
    img, d = new_cell()
    if thrust:
        d.polygon(px([(40, 50), (4, 64), (40, 78)]), fill=(255, 140, 40, 255))
        d.polygon(px([(40, 57), (18, 64), (40, 71)]), fill=(255, 226, 120, 255))
        img = glow(img, 3, 1.2)
        d = ImageDraw.Draw(img)
    hull = [(106, 64), (30, 24), (44, 64), (30, 104)]
    d.polygon(px(hull), fill=(127, 227, 255, 255), outline=(255, 255, 255, 255), width=3 * SS)
    d.polygon(px([(88, 64), (50, 40), (56, 64), (50, 88)]), fill=(70, 150, 200, 255))
    d.ellipse([c * SS for c in (62, 55, 82, 73)], fill=(14, 30, 60, 255), outline=(200, 240, 255, 255), width=SS)
    return finish(img)


# --------------------------------------------------------------------------- bullet
def bullet(color):
    img, d = new_cell()
    cx = cy = 64
    d.rounded_rectangle([c * SS for c in (cx - 22, cy - 7, cx + 22, cy + 7)], radius=7 * SS, fill=color + (255,))
    img = glow(img, 6, 1.6)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([c * SS for c in (cx - 14, cy - 3, cx + 14, cy + 3)], radius=3 * SS, fill=(255, 255, 255, 255))
    return finish(img)


# --------------------------------------------------------------------------- asteroid
def asteroid(seed, hunter=False):
    rnd = random.Random(seed)
    img, d = new_cell()
    n = 13
    pts = []
    for i in range(n):
        a = i / n * math.tau
        r = 50 * (0.82 + rnd.random() * 0.28)
        pts.append((64 + math.cos(a) * r, 64 + math.sin(a) * r))
    base = (74, 34, 44, 255) if hunter else (58, 70, 104, 255)
    edge = (255, 107, 107, 255) if hunter else (143, 163, 209, 255)
    d.polygon(px(pts), fill=base, outline=edge, width=3 * SS)

    # craters, clipped to the rock
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).polygon(px(pts), fill=255)
    craters = Image.new("RGBA", img.size, (0, 0, 0, 0))
    cd = ImageDraw.Draw(craters)
    for _ in range(4):
        a, r = rnd.random() * math.tau, rnd.random() * 26
        cx, cy, cr = 64 + math.cos(a) * r, 64 + math.sin(a) * r, 6 + rnd.random() * 9
        cd.ellipse([c * SS for c in (cx - cr, cy - cr, cx + cr, cy + cr)], fill=(0, 0, 0, 70), outline=(255, 255, 255, 40), width=SS)
    img = Image.alpha_composite(img, Image.composite(craters, Image.new("RGBA", img.size, (0, 0, 0, 0)), mask))
    d = ImageDraw.Draw(img)
    if hunter:  # two glowing eyes: this rock hunts the player
        for ex in (50, 78):
            d.ellipse([c * SS for c in (ex - 6, 54, ex + 6, 66)], fill=(255, 70, 70, 255))
            d.ellipse([c * SS for c in (ex - 2, 58, ex + 2, 62)], fill=(255, 235, 200, 255))
    return finish(img)


# --------------------------------------------------------------------------- pickups
def pickup(kind, color):
    img, d = new_cell()
    d.ellipse([c * SS for c in (18, 18, 110, 110)], outline=color + (255,), width=5 * SS)
    img = glow(img, 4, 1.0)
    d = ImageDraw.Draw(img)
    fill = color + (255,)
    if kind == "shield":
        d.polygon(px([(64, 34), (90, 44), (88, 70), (64, 94), (40, 70), (38, 44)]), outline=fill, width=4 * SS)
    elif kind == "rapid":
        for dx in (-14, 8):
            d.polygon(px([(46 + dx + 14, 38), (64 + dx + 14, 64), (46 + dx + 14, 90), (38 + dx + 14, 90), (56 + dx + 14, 64), (38 + dx + 14, 38)]), fill=fill)
    else:  # homing: crosshair
        d.ellipse([c * SS for c in (44, 44, 84, 84)], outline=fill, width=4 * SS)
        for a, b in (((64, 30), (64, 48)), ((64, 80), (64, 98)), ((30, 64), (48, 64)), ((80, 64), (98, 64))):
            d.line(px([a, b]), fill=fill, width=4 * SS)
    return finish(img)


# --------------------------------------------------------------------------- sheet + atlas
# name -> (cell index, body radius in px). dest size = entity.radius * CELL / body_r.
FRAMES = [
    ("ship", ship(False), 38),
    ("ship-thrust", ship(True), 38),
    ("bullet", bullet((255, 214, 90)), 9),
    ("bullet-homing", bullet((199, 125, 255)), 9),
    ("pickup-shield", pickup("shield", (110, 255, 220)), 46),
    ("pickup-rapid", pickup("rapid", (255, 209, 102)), 46),
    ("pickup-homing", pickup("homing", (199, 125, 255)), 46),
    ("asteroid-1", asteroid(11), 50),
    ("asteroid-2", asteroid(23), 50),
    ("asteroid-3", asteroid(37), 50),
    ("hunter-1", asteroid(51, hunter=True), 50),
]


def build_sheet():
    # row 0 holds the first 7 frames, row 1 the asteroids (cell index = row * COLS + col)
    layout = {name: (i if i < 7 else COLS + (i - 7)) for i, (name, _, _) in enumerate(FRAMES)}
    sheet = Image.new("RGBA", (CELL * COLS, CELL * ROWS), (0, 0, 0, 0))
    frames = {}
    for name, img, body_r in FRAMES:
        idx = layout[name]
        x, y = (idx % COLS) * CELL, (idx // COLS) * CELL
        sheet.paste(img, (x, y))
        frames[name] = {"x": x, "y": y, "w": CELL, "h": CELL, "fit": round(CELL / body_r, 3)}
    sheet.save(ROOT / "sprites.png", optimize=True)
    atlas = {"image": "sprites.png", "cell": CELL, "frames": frames}
    (ROOT / "sprites.json").write_text(json.dumps(atlas, indent=2) + "\n")


# --------------------------------------------------------------------------- sounds
RATE = 44100
rng = np.random.default_rng(7)


def t_axis(sec):
    return np.linspace(0, sec, int(RATE * sec), endpoint=False)


def lowpass(x, k):
    return np.convolve(x, np.ones(k) / k, mode="same")


def save_wav(name, samples):
    samples = samples / max(1e-9, np.max(np.abs(samples))) * 0.8
    data = (samples * 32767).astype("<i2")
    with wave.open(str(ROOT / "sounds" / name), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(data.tobytes())


def make_sounds():
    (ROOT / "sounds").mkdir(parents=True, exist_ok=True)

    t = t_axis(0.16)  # shoot: falling square-ish chirp
    freq = 950 * np.exp(-t * 11)
    phase = np.cumsum(freq) / RATE * math.tau
    save_wav("shoot.wav", (np.sign(np.sin(phase)) * 0.5 + np.sin(phase) * 0.5) * np.exp(-t * 18))

    t = t_axis(0.14)  # hit: short noise crack + low thump
    noise = lowpass(rng.standard_normal(t.size), 3)
    save_wav("hit.wav", (noise * 0.8 + np.sin(math.tau * 170 * t) * 0.6) * np.exp(-t * 30))

    t = t_axis(0.75)  # explode: rumbling low-passed noise + falling sine
    rumble = lowpass(rng.standard_normal(t.size), 40) * 6
    sweep = np.sin(np.cumsum(90 * np.exp(-t * 3)) / RATE * math.tau)
    save_wav("explode.wav", (rumble * 0.8 + sweep * 0.7) * np.exp(-t * 4.5))

    t = t_axis(0.3)  # pickup: rising three-note arpeggio
    out = np.zeros_like(t)
    for i, f in enumerate((660, 880, 1320)):
        start = int(i * 0.07 * RATE)
        seg = t[: t.size - start]
        out[start:] += np.sin(math.tau * f * seg) * np.exp(-seg * 12)
    save_wav("pickup.wav", out)


if __name__ == "__main__":
    ROOT.mkdir(parents=True, exist_ok=True)
    build_sheet()
    make_sounds()
    print("assets written to", ROOT)

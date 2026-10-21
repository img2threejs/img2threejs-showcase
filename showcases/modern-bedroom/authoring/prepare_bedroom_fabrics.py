"""Deterministic bedroom-specific knit, pile, linen, weave and wood PBR (no source-photo pixels of the room).
Run with the isolated image environment after the installed surface recipe (surfaces.json):

    .venv-images/bin/python prepare_bedroom_fabrics.py --workspace . --run-id <fresh> [--only throw,rug,...]

Throw: chunky seed/moss stitch as a VERTICAL WALE knit - rounded lobes (taller than wide, 1.35:1) carried on wales
13 mm apart across the throw, with the odd wale shifted half a lobe row so the lobes interlock; 2-ply twist grooves
on the lobe flanks, per-lobe marled lightness and a low-frequency marl field. The CC0 ambientCG Fabric085 scan
(resources/ambientcg/Fabric085, hash-verified) only supplies the fibre micro-relief and micro-roughness.
Floor/walnut use the Poly Haven scans in resources.json. Rug, linen, pillow and headboard weave are authored
periodic maps. Tile sizes and colours come from bedroom_materials.TEXTILES, the single source for the UV0
metres-per-repeat.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path

import numpy as np
from PIL import Image

SIZE = 2048

# ----------------------------------------------------------------------------------------------------------
# Throw (throwtex-r01). The reference throw is a chunky seed/moss stitch: rounded lobes (purl beads) carried on
# VERTICAL WALES that run down the hang, with neighbouring wales offset by half a lobe so the lobes interlock
# (ref-audit-r01/AUDIT.md B; close reads in ref-audit-r01/throw-ref-macro-8x.png and throwtex-r01/ref/plain12.png).
#
# The close read (throwtex-r01/ref/plain12.png, 12x of a 60 px reference patch) shows THREE superimposed scales:
#   1. the WALE: a continuous vertical column of knit stitches, ~13 mm wide, running the full height of the
#      hang. The wales are separated by narrow deep vertical grooves;
#   2. the LOBE: the rounded purl beads sitting on the wales, one every ~14-15 mm, each ~12 mm wide and
#      ~14 mm tall (taller than wide), with a bright rounded crest;
#   3. the YARN: a fat 2-ply twist, visible as diagonal ridges on each lobe and on the wale column.
# The lobes of neighbouring wales interlock like a seed stitch (odd wales sit half a lobe row lower).
#
# Pitch, measured on the reference crop x1650-1930 / y960-1310 at 335 px/m across and 400 px/m along the hang
# (throwtex-r01/scripts/): band-limited 2-D spectrum |k| 85-95 cycles/m (lambda 10.5-11.8 mm) at 45-60 deg;
# 1-D strip autocorrelation 10-12 mm across and 10-12.5 mm along; bright-crest nearest-neighbour 10.6-13.7 mm.
#
# throwtex-r02 - the r01 model read as SPARSE OVALS on a black ground: the lobes were far too small for their
# cell, the rib modulation cut a deep vertical channel between the wales, and the dark ground between the
# lobes was the near-black valley colour. The reference is the opposite: a CONTINUOUS chunky fabric in which
# the rounded lobes TOUCH (fill >= 85 % of the area) and only a thin crease (about 0.5-1 mm) of L* 16 runs
# between them; the ground between two lobes is the lobe's own flank colour (L* 28), never black. So:
#   * the lobe is as big as its cell (12.0 x 14.0 mm in a 13.33 x 15.0 mm cell) and the superellipse is fuller
#     (exponent 2.6 instead of 2.2), so neighbouring lobes overlap and interlock;
#   * the rib modulation is GONE: a vertical channel between the wales is exactly the black gap that has to
#     disappear. The columnar read now comes from the aligned columns of lobes and the marl;
#   * the lobe profile is a rounded shoulder of a fixed 3.0 mm width (not a (1-q)^0.55 cone, which was dark
#     over most of the lobe) so the light falls off smoothly from the crown to the crease;
#   * the albedo is an ABSOLUTE map of the height (no percentile remap), so the tonal ranges of the brief
#     hold: crease 16, flank 28, body 36, crown 60;
#   * the salt-and-pepper speckle is gone: the scan micro-relief is band-limited to 0.45-1.6 mm (the raw
#     high-pass kept the 0.23 mm pixel, whose slope is what read as pepper) and the white-noise terms that
#     fed the albedo and the height are removed.
THROW_WALE_MM = 13.0               # wale (column) pitch across the throw (U)
THROW_ROW_MM = 15.0                # lobe row pitch along the hang (V)
THROW_LOBE_FILL = 1.12             # the lobe's base outline is 112 % of its cell, so neighbouring lobes overlap
                                  # and the only dark ground is the narrow crease at their junctions
THROW_LOBE_SHAPE = 2.6             # superellipse exponent: a full, chunky, ROUNDED cell (not a circle, not a lozenge)
THROW_PHASE_ALT = 0.5              # odd wales are shifted half a lobe row -> the interlocking of a seed stitch
# The HEIGHT of a lobe is a plateau with a rounded edge: it rises from the crease to the plateau over
# THROW_ROLL_MM and then climbs gently to the crown. The height field is the MAX over the 3x3 neighbouring
# lobes, so where two lobes meet the surface stays HIGH and their junction is a narrow pit. r01 used a deep
# canyon between the lobes, which is exactly what made it read as separate beads on a black ground.
THROW_ROLL_MM = 1.6                # width of the rounded edge of a lobe (the crease lives in its first ~1 mm)
THROW_FLAT = 0.62                  # the height of the lobe's plateau, relative to the crown
THROW_DOME_FRAC = 0.85             # how much of the crown is a dome over the middle of the lobe
# The WALE: a shallow groove runs down the boundary between two neighbouring wales, so the columns of lobes
# read as vertical wales. It is shallow on purpose - a deep channel is what made r01 read as separate beads.
THROW_WALE_GROOVE = 0.06           # how much the wale groove lowers the surface (relative to the crown)
THROW_WALE_HALF = 0.42             # half-width of the wale groove, in wale-pitch units
# The albedo is banded on the height, so the tonal ranges of the brief hold exactly: the crease is a thin
# L* 16 line, the ground between two lobes is the FLANK colour (28), the body of a lobe is a mid charcoal
# (36) and only the crown of the lobe is light grey (60).
THROW_L_CREASE = 16.0              # albedo L* in the crease between the lobes
THROW_L_FLANK = 28.0               # albedo L* at the flank of a lobe (and the ground between two lobes)
THROW_L_BODY = 36.0                # albedo L* in the body of a lobe
THROW_L_CROWN = 64.0               # albedo L* at the crown of a lobe
THROW_D_CREASE = 0.15              # d (mm inside the nearest lobe) below this reads as the dark crease
THROW_D_FLANK = 0.70               # d below this reads as the flank (the ground between two lobes)
THROW_D_BODY = 1.90                # d below this reads as the lobe's body
THROW_D_CROWN = 4.00               # d below this reads as the lobe's crown
THROW_WALE_TONE = 7.0              # extra L* the shadowed wale line takes off the albedo
THROW_H_FLANK = 0.42               # height at which the flank colour is reached (roughness only)
THROW_H_BODY = 0.66                # height at which the body colour is reached (roughness only)
THROW_TWIST_TURNS = 0.85           # 2-ply twist: turns of the ply helix over the lobe height
THROW_TWIST_DEPTH = 0.05           # depth of the ply grooves in the height field
THROW_JITTER_POS = 0.02            # per-lobe position jitter (cell units)
THROW_JITTER_SIZE = (0.98, 1.02)   # per-lobe size jitter
THROW_RELIEF_MM = 2.4              # crest-to-crease relief
THROW_SOFTEN_PX = (1.4, 1.2)       # (height, albedo) Gaussian sigma: keeps the 13 mm lattice from aliasing
THROW_STITCH_JITTER_L = 4.0        # per-lobe lightness jitter (the marl)
THROW_MARL_L = 2.5                 # low-frequency marl field amplitude (+-L*)
THROW_MARL_MM = 55.0               # marl correlation length
THROW_AB = (0.0, -0.8)             # neutral with a hair of warmth: native bakes read blue (sky ambient), render cast target R-B 0..+6
THROW_ROUGHNESS = 0.93
THROW_MICRO_MM = 0.025             # scan-derived fibre micro-relief amplitude (mm, std), band-limited to 0.45-1.6 mm
THROW_SEED = 97

FLOOR_SOURCE = 'wooden_floor_02'
# Deep satin walnut floor: old albedo x0.8 linear (L* 40.3), then a* x0.8 / b* x0.55 at constant L*.
FLOOR_DYE_SRGB = (115, 90, 80)
# Within-board grain solved to L* std 3.0, plus 1.6 fine streaks and +-3 L* plank tone => total std ~4.0 (x2.3 the original).
FLOOR_BOUNDS, FLOOR_GRAIN_L_STD = (0.62, 1.9), 3.0
FLOOR_STREAK_L_STD = 1.6
FLOOR_ROUGHNESS = {'offset': 0.30, 'scale': 0.25, 'bounds': (0.20, 0.42)}
FLOOR_STRIP_W, FLOOR_STRIP_H, FLOOR_OVERLAP = 840, 210, 80
# (left, top) of 920 x 210 crops of the 4096 scan, each inside one board (no joints) and one 256-px board row.
FLOOR_BOARDS = ((160, 52), (879, 308), (1949, 2099), (3140, 3123), (2260, 1843))
FLOOR_TONE_DL = (-3.0, 2.0, -1.0, 3.0, -1.0)      # per-plank tone jitter in L*
FLOOR_V_MARGIN = 0.03

# Walnut veneer (Poly Haven black_walnut_veneer_02, 2K): calm, long, straight grain. The scan's log-luminance is split
# into a broad figure band (cathedral, > ~2 cm), a mid band (grain lines, 3-20 mm) and a fine band (pores, < 3 mm);
# the mid band is smeared along the grain so it reads straight, and the bands are re-weighted.
WALNUT_SOURCE = 'black_walnut_veneer_02'
WALNUT_BAND_SIGMAS = (6.0, 40.0)             # px (0.49 mm/px on the 1 m tile)
# Band energies of the scan's log-ratio: low 0.020, mid 0.073, fine 0.114 (std), so the broad figure needs the largest gain.
WALNUT_GAIN = {'low': 5.0, 'mid': 1.5, 'fine': 1.0}
WALNUT_MID_STRAIGHTEN = (45.0, 1.0, 0.55)    # (sigma along the grain, across) px, and the mix fraction of the smeared mid band
WALNUT_RATIO_BOUNDS = (0.45, 2.1)
# walnut: bed frame / nightstands / art frames (renders L* 38, a*/b* 11.5/13.5 vs reference 36/11/15); walnutwarm: the lit, more
# orange near wardrobe (reference (128,87,60) vs 99,72,58 with the plain dye); walnutdark: dresser.
WALNUT_DYES = {'walnut': (115, 90, 78), 'walnutwarm': (149, 106, 77), 'walnutdark': (72, 45, 29)}


# ----------------------------------------------------------------------------------------------------------
def load_materials_module(root):
    spec = importlib.util.spec_from_file_location('bedroom_materials_for_textures', root / 'bedroom_materials.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sha256_file(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def encode_srgb(lin):
    lin = np.clip(lin, 0, 1)
    return np.where(lin <= 0.0031308, 12.92*lin, 1.055*lin**(1/2.4) - 0.055)


def decode_srgb(c):
    return np.where(c <= 0.04045, c/12.92, ((c + 0.055)/1.055)**2.4)


def _apply3(matrix, channels):
    """3x3 matrix applied per pixel with explicit arithmetic (no BLAS: macOS Accelerate segfaulted on large stacks)."""
    return [sum(matrix[i][j]*channels[j] for j in range(3)) for i in range(3)]


def lab_to_srgb255(lightness, a, b):
    """CIE L*a*b* (D65) -> sRGB 0..255 float, last axis = channel; lightness may be an array."""
    fy = (lightness + 16)/116
    fx, fz = fy + a/500, fy - b/200

    def inverse(t):
        return np.where(t**3 > 216/24389, t**3, (116*t - 16)/(24389/27))
    xyz = (0.95047*inverse(fx), inverse(fy), 1.08883*inverse(fz))
    linear = _apply3(((3.2406, -1.5372, -0.4986), (-0.9689, 1.8758, 0.0415), (0.0557, -0.2040, 1.0570)), xyz)
    return 255*encode_srgb(np.stack(linear, axis=-1))


def srgb255_to_lab(rgb):
    c = np.asarray(rgb, dtype=np.float64)/255
    lin = decode_srgb(c)
    xyz = _apply3(((0.4124, 0.3576, 0.1805), (0.2126, 0.7152, 0.0722), (0.0193, 0.1192, 0.9505)),
                  (lin[..., 0], lin[..., 1], lin[..., 2]))
    xyz = [xyz[0]/0.95047, xyz[1], xyz[2]/1.08883]
    f = [np.where(t > 216/24389, np.cbrt(t), (24389/27*t + 16)/116) for t in xyz]
    return np.stack((116*f[1] - 16, 500*(f[0] - f[1]), 200*(f[1] - f[2])), axis=-1)


def gaussian_filter_periodic(field, sigma_x, sigma_y):
    freq_y = np.fft.fftfreq(field.shape[0])[:, None]
    freq_x = np.fft.fftfreq(field.shape[1])[None, :]
    kernel = np.exp(-2*np.pi**2*((sigma_x*freq_x)**2 + (sigma_y*freq_y)**2))
    return np.real(np.fft.ifft2(np.fft.fft2(field)*kernel)).astype(np.float32)


def zscore(a):
    return (a - a.mean())/max(float(a.std()), 1e-9)


def noise(rng, sigma_x, sigma_y=None):
    """Periodic Gaussian-filtered white noise, unit variance (sigma in pixels)."""
    white = rng.standard_normal((SIZE, SIZE)).astype(np.float32)
    return zscore(gaussian_filter_periodic(white, sigma_x, sigma_x if sigma_y is None else sigma_y))


def aniso_noise(rng, sigma_long, sigma_short, theta):
    """Periodic noise smeared sigma_long px along direction theta and sigma_short px across it; unit variance."""
    white = rng.standard_normal((SIZE, SIZE)).astype(np.float32)
    fy = np.fft.fftfreq(SIZE)[:, None]
    fx = np.fft.fftfreq(SIZE)[None, :]
    along = fx*np.cos(theta) + fy*np.sin(theta)
    across = -fx*np.sin(theta) + fy*np.cos(theta)
    kernel = np.exp(-2*np.pi**2*((sigma_long*along)**2 + (sigma_short*across)**2))
    return zscore(np.real(np.fft.ifft2(np.fft.fft2(white)*kernel)).astype(np.float32))


def smoothstep(edge0, edge1, x):
    t = np.clip((x - edge0)/(edge1 - edge0), 0, 1)
    return t*t*(3 - 2*t)


def write_png(path, pixels, root):
    Image.fromarray(pixels).save(path, optimize=True)
    return {'path': str(path.relative_to(root)), 'sha256': sha256_file(path), 'min': int(pixels.min()),
            'max': int(pixels.max()), 'mean': float(pixels.mean()), 'std': float(pixels.std())}


def normal_map(height_m, tile):
    """OpenGL +Y tangent normals from a periodic height field in metres on a tile of `tile` metres (rows point down)."""
    pitch = tile/height_m.shape[0]
    dx = (np.roll(height_m, -1, axis=1) - np.roll(height_m, 1, axis=1))/(2*pitch)
    dy = -(np.roll(height_m, -1, axis=0) - np.roll(height_m, 1, axis=0))/(2*pitch)
    normal = np.stack((-dx, -dy, np.ones_like(dx)), axis=-1)
    normal /= np.linalg.norm(normal, axis=-1, keepdims=True)
    return np.rint((normal*.5 + .5)*255).astype(np.uint8)


def pixels_per_mm(tile):
    return SIZE/(tile*1000)


def even(value):
    return int(round(value/2))*2


def stats_of(color_u8):
    lab = srgb255_to_lab(color_u8.reshape(-1, 3))
    return {'L_mean': float(lab[:, 0].mean()), 'L_std': float(lab[:, 0].std()),
            'L_percentiles_1_5_25_50_75_95_99': np.percentile(lab[:, 0], [1, 5, 25, 50, 75, 95, 99]).round(2).tolist(),
            'a_mean': float(lab[:, 1].mean()), 'b_mean': float(lab[:, 2].mean()),
            'srgb_mean': color_u8.reshape(-1, 3).mean(axis=0).round(1).tolist()}


def save_set(assets, root, key, color, normal, rough):
    maps = {'basecolor': np.rint(np.clip(color, 0, 255)).astype(np.uint8), 'normal': normal,
            'roughness': np.rint(np.clip(rough, 0, 1)*255).astype(np.uint8)}
    return maps, {channel: write_png(assets / f'bedroom-{key}-{channel}.png', pixels, root) for channel, pixels in maps.items()}


# ----------------------------------------------------------------------------------------------------------
def scan_micro(root):
    """Fibre micro-relief and micro-roughness from the CC0 scan, tiled 2x2 at 0.8x of the real size on the 0.48 m tile.

    throwtex-r02: the raw high-pass (subtract a 4 px Gaussian from the 0.29 mm/px downsample) kept the scan's own
    0.23 mm pixel grid, and that grid's SLOPE is what read as salt-and-pepper pepper at the 179 x 150 mm macro
    window. The detail is now band-limited to 0.45-1.6 mm - a real fibre scale, well below the 13 mm stitch - so
    it only adds a fine nap and never a visible speckle.
    """
    scan_dir = root / 'resources/ambientcg/Fabric085'
    receipt = json.loads((scan_dir / 'source.json').read_text())
    expected = {Path(row['path']).name: row['sha256'] for row in receipt['files']}
    maps = {}
    for name in ('Displacement', 'Roughness'):
        path = scan_dir / f'Fabric085_2K-JPG_{name}.jpg'
        if sha256_file(path) != expected[path.name]:
            raise ValueError(f'Fabric085 hash mismatch: {path.name}')
        with Image.open(path) as image:
            if image.size != (SIZE, SIZE):
                raise ValueError(f'unexpected scan size {image.size}: {path.name}')
            array = np.asarray(image.convert('L'), dtype=np.float32)/255
        half = array.reshape(SIZE//2, 2, SIZE//2, 2).mean(axis=(1, 3))          # 0.29 mm/px
        # band-limit to 0.45-1.6 mm: low-pass at 1.6 mm, high-pass at 0.45 mm (both in the 0.29 mm/px grid)
        low = gaussian_filter_periodic(half, 1.6/0.29, 1.6/0.29)
        mid = gaussian_filter_periodic(half, 0.45/0.29, 0.45/0.29)
        detail = low - mid
        maps[name] = np.tile(zscore(detail), (2, 2))                            # 1024 px x 2 = 2048 px = 0.48 m
    return maps, receipt


def build_throw(root, assets, tile):
    """Chunky seed/moss stitch: rounded-square lobes carried on vertical wales, alternating column phase.

    throwtex-r02 model. The wale lattice is explicit: `nx` wales across (U) and `ny` lobe rows along (V).
    Every lobe is a full superellipse cell (a rounded SQUARE, exponent 3.2) that fills its 13.33 x 15.0 mm
    cell; odd wales are shifted half a lobe row so the lobes interlock like a seed stitch.

    Three things make this read as a continuous chunky fabric rather than as separate beads:
      1. the lobe's height is a PLATEAU with a rounded edge, not a cone: it rises from the crease to the
         plateau over THROW_ROLL_MM and then climbs gently to the crown, so the flanks are not black;
      2. the height is the MAX over the 3x3 neighbouring lobes, so where two lobes meet the surface stays
         HIGH and their junction is a narrow pit, never a wide open gap;
      3. the albedo is banded on that height (crease 16 / flank 28 / body 36 / crown 60 L*), so the ground
         between two lobes is the flank colour and only a thin ~1 mm crease is dark.
    """
    nx = even(tile*1000/THROW_WALE_MM)
    ny = even(tile*1000/THROW_ROW_MM)
    rng = np.random.default_rng(THROW_SEED)
    cell_mm_x = tile*1000/nx                              # wale pitch in mm
    cell_mm_y = tile*1000/ny                              # lobe row pitch in mm
    ppm = pixels_per_mm(tile)                             # px per mm
    coordinate = (np.arange(SIZE, dtype=np.float32) + 0.5)/SIZE
    cx, cy = coordinate[None, :]*nx, coordinate[:, None]*ny
    i, j = np.floor(cx).astype(np.int32), np.floor(cy).astype(np.int32)
    u, v = cx - i - 0.5, cy - j - 0.5
    shift_u = rng.uniform(-THROW_JITTER_POS, THROW_JITTER_POS, (ny, nx)).astype(np.float32)
    shift_v = rng.uniform(-THROW_JITTER_POS, THROW_JITTER_POS, (ny, nx)).astype(np.float32)
    size_jitter = rng.uniform(*THROW_JITTER_SIZE, (ny, nx)).astype(np.float32)
    tone_jitter = rng.standard_normal((ny, nx)).astype(np.float32)
    phase = rng.uniform(0, 2*np.pi, (ny, nx)).astype(np.float32)
    # the alternating column phase: odd wales sit half a lobe row lower (seed stitch)
    wale_phase = ((np.arange(nx) % 2)*THROW_PHASE_ALT).astype(np.float32)

    # the lobe's BASE outline is the cell itself, so neighbouring lobes TOUCH: the ground between two lobes
    # is only the narrow crease, never a wide black gap
    ru0 = 0.5*THROW_LOBE_FILL*cell_mm_x                # lobe half-width, mm
    rv0 = 0.5*THROW_LOBE_FILL*cell_mm_y                # lobe half-height, mm

    height = np.zeros((SIZE, SIZE), dtype=np.float32)
    dmax = np.full((SIZE, SIZE), -1e9, dtype=np.float32)
    jitter_tone = np.zeros((SIZE, SIZE), dtype=np.float32)
    ply = np.zeros((SIZE, SIZE), dtype=np.float32)
    for dj in (-1, 0, 1):
        for di in (-1, 0, 1):
            ci, cj = (i + di) % nx, (j + dj) % ny
            du = (u - di - shift_u[cj, ci])*cell_mm_x      # offset from the lobe centre, mm
            dv = (v - dj - wale_phase[ci] - shift_v[cj, ci])*cell_mm_y
            ru = ru0*size_jitter[cj, ci]
            rv = rv0*size_jitter[cj, ci]
            # the superellipse is the lobe's OUTLINE; q = 1 on the outline, 0 at the lobe's centre
            q = (np.abs(du/ru)**THROW_LOBE_SHAPE + np.abs(dv/rv)**THROW_LOBE_SHAPE)**(1/THROW_LOBE_SHAPE)
            # the signed distance from the outline, in mm (negative outside the lobe)
            d = (1.0 - q)*0.5*(ru + rv)
            # the lobe's height: a plateau with a rounded edge (THROW_ROLL_MM wide) plus a broad crown over
            # the middle of the lobe
            edge = 1.0 - smoothstep(1.0 - THROW_ROLL_MM/(0.5*(ru + rv)), 1.0, q)
            crown = np.clip(1.0 - q, 0, 1)**1.4
            h = edge*(THROW_FLAT + (1.0 - THROW_FLAT)*(THROW_DOME_FRAC*crown + (1.0 - THROW_DOME_FRAC)))
            # 2-ply yarn: two helices winding up the lobe flanks (they read as the twist of a fat yarn).
            # The stroke is confined to the lobe's interior: the (1-q)^0.35 profile has an infinite slope at
            # the outline, which put single-pixel spikes into the normal map.
            helix = np.sin(2*np.pi*THROW_TWIST_TURNS*(dv/rv) + np.pi*np.sign(du + 1e-9) + phase[cj, ci])
            stroke = np.abs(helix)*np.clip(1.0 - q, 0, 1)
            # the MAX over the neighbouring lobes: where two lobes meet the surface stays high, so their
            # junction is a narrow pit instead of a wide valley
            take = h > height
            height = np.where(take, h, height)
            # the distance to the NEAREST lobe outline: at the junction of two lobes it is 0, so the crease
            # between them is a thin line and the rest of the cell is lobe
            dmax = np.maximum(dmax, d)
            jitter_tone = np.where(take, tone_jitter[cj, ci], jitter_tone)
            ply = np.where(take, stroke, ply)

    # the 2-ply grooves ride on the lobe's flanks
    height *= (1.0 - THROW_TWIST_DEPTH*(1.0 - ply))
    # The WALE: a shallow groove down the boundary between two neighbouring wales, so the columns of lobes
    # read as vertical wales. It is shallow on purpose: a deep channel is what made r01 read as beads.
    wale = np.clip(np.abs(u + 0.5)/THROW_WALE_HALF, 0, 1)      # 0 at a wale centre, 1 at the wale boundary
    height -= THROW_WALE_GROOVE*wale**2*height
    height = gaussian_filter_periodic(height, THROW_SOFTEN_PX[0], THROW_SOFTEN_PX[0])

    micro, receipt = scan_micro(root)
    height_m = height*THROW_RELIEF_MM/1000 + micro['Displacement']*THROW_MICRO_MM/1000

    # Albedo: banded on the lobe-local DISTANCE d (mm inside the nearest lobe outline), not on the height, so
    # the tonal ranges of the brief hold directly and the crease between two lobes is a thin line:
    # the crease is L* 16, the ground between two lobes is the flank colour (28), the body of a lobe is a
    # mid charcoal (36) and only the crown of the lobe is light grey (60).
    lightness = np.full((SIZE, SIZE), THROW_L_CREASE, dtype=np.float32)
    lightness += (THROW_L_FLANK - THROW_L_CREASE)*smoothstep(THROW_D_CREASE, THROW_D_FLANK, dmax)
    lightness += (THROW_L_BODY - THROW_L_FLANK)*smoothstep(THROW_D_FLANK, THROW_D_BODY, dmax)
    lightness += (THROW_L_CROWN - THROW_L_BODY)*smoothstep(THROW_D_BODY, THROW_D_CROWN, dmax)
    lightness += THROW_STITCH_JITTER_L*jitter_tone                                # per-lobe marl
    marl = zscore(gaussian_filter_periodic(rng.standard_normal((SIZE, SIZE)).astype(np.float32),
                                            THROW_MARL_MM*pixels_per_mm(tile)/2.0,
                                            THROW_MARL_MM*pixels_per_mm(tile)/2.0))
    # the marl field is isotropic: remove its linear trend so the tile carries no baked ombre
    yy, xx = np.mgrid[0:SIZE, 0:SIZE].astype(np.float32)
    xx -= xx.mean()
    yy -= yy.mean()
    marl -= (float((marl*xx).sum()/ (xx*xx).sum())*xx + float((marl*yy).sum()/(yy*yy).sum())*yy)
    marl = zscore(marl)
    lightness += THROW_MARL_L*marl                                                # low-frequency marl field
    lightness += 1.0*(ply - 0.5)*smoothstep(THROW_D_FLANK, THROW_D_BODY, dmax)    # the ply grooves read as tone streaks
    # The WALE line: the columns of lobes read as vertical wales because the crease network that separates
    # them is a shadowed line, and the odd wale's offset makes that line a wale and a groove in turn.
    lightness -= THROW_WALE_TONE*wale**2*smoothstep(THROW_D_FLANK, THROW_D_BODY, dmax)
    lightness = gaussian_filter_periodic(lightness, THROW_SOFTEN_PX[1], THROW_SOFTEN_PX[1])
    # the marl may not push the crease below the L* 14 floor: the ground between the lobes must stay a
    # flank colour, never black
    lightness = np.clip(lightness, 14.0, 92.0)
    color = lab_to_srgb255(lightness, *THROW_AB)
    h = np.clip(height, 0, 1)
    body = smoothstep(THROW_H_FLANK, THROW_H_BODY, h)
    rough = THROW_ROUGHNESS + 0.020*(body - 0.5) + 0.012*micro['Roughness']
    maps, outputs = save_set(assets, root, 'throw', color, normal_map(height_m, tile), np.clip(rough, 0.84, 0.99))
    return {'material': 'throw',
            'construction': 'chunky seed/moss stitch: full rounded lobes carried on vertical wales, odd wales shifted '
                            'half a lobe row, 2-ply twist grooves on the flanks, per-lobe marled lightness and a '
                            'low-frequency marl field; CC0 ambientCG Fabric085 scan supplies only the fibre micro-relief',
            'source': {'asset': 'ambientCG Fabric085', 'url': receipt['assetUrl'], 'license': receipt['license'],
                       'receipt': 'resources/ambientcg/Fabric085/source.json',
                       'usedFor': 'Displacement + Roughness band-pass (0.45-1.6 mm), tiled 2x2 at 0.8x size',
                       'files': {row['path']: row['sha256'] for row in receipt['files']}},
            'tileMetres': tile, 'wales': nx, 'lobeRows': ny,
            'waleMm': 1000*tile/nx, 'lobeRowMm': 1000*tile/ny,
            'lobeMm': {'wide': 2*ru0, 'tall': 2*rv0},
            'creaseMm': THROW_ROLL_MM, 'reliefMm': THROW_RELIEF_MM, 'microMm': THROW_MICRO_MM,
            'albedoStats': stats_of(maps['basecolor']), 'size': SIZE, 'seed': THROW_SEED, 'outputs': outputs}


# ----------------------------------------------------------------------------------------------------------
def build_rug(root, assets, tile, rgb):
    """Dense soft low-pile heather: multi-scale isotropic fibre grain + gentle low-frequency tone. No grid, no streaks."""
    ppm = pixels_per_mm(tile)                    # px per mm
    rng = np.random.default_rng(47)
    fine, grain, clump = noise(rng, 0.45*ppm), noise(rng, 0.9*ppm), noise(rng, 2.2*ppm)
    soft = noise(rng, 9.0*ppm)
    mid = noise(rng, 22.0*ppm)
    broad = noise(rng, 55.0*ppm)
    weft = noise(rng, 5.0*ppm, 0.7*ppm)          # very faint weft-direction hand
    tone = 1 + 0.075*fine + 0.090*grain + 0.075*clump + 0.035*soft + 0.020*mid + 0.030*broad + 0.012*weft
    height_m = (0.00018*grain + 0.00026*clump + 0.00010*soft + 0.00006*fine)
    rough = 0.96 + 0.015*grain + 0.012*clump
    color = np.asarray(rgb, dtype=np.float32)*tone[..., None]
    maps, outputs = save_set(assets, root, 'rug', color, normal_map(height_m, tile), np.clip(rough, .88, .99))
    return {'material': 'rug',
            'construction': 'dense low-pile heather: fibre grain 0.4-2 mm, clumps ~4 mm, soft tone 18 mm, broad tone 80 mm, relief ~0.2 mm',
            'tileMetres': tile, 'albedoStats': stats_of(maps['basecolor']), 'size': SIZE, 'seed': 47, 'outputs': outputs}


# ----------------------------------------------------------------------------------------------------------
def woven_cloth(rng, tile, yarn_mm, slub, slub_len_mm, weave_tone, weave_height_mm):
    """Plain weave with per-yarn thick/thin slubs. Returns (yarn pattern, slub field), both ~unit variance."""
    ppm = pixels_per_mm(tile)
    yarns = even(tile*1000/yarn_mm)
    coordinate = (np.arange(SIZE, dtype=np.float32) + 0.5)/SIZE
    wx, wy = coordinate[None, :]*yarns, coordinate[:, None]*yarns
    warp = np.cos(2*np.pi*(wx + 0.040*np.sin(2*np.pi*wy/7.3 + 1.1)))
    weft = np.cos(2*np.pi*(wy + 0.035*np.sin(2*np.pi*wx/6.1 + 0.4)))
    over = np.sin(np.pi*wx)*np.sin(np.pi*wy)
    yarn = 0.5*(warp + weft) + 0.25*over*(warp - weft)

    def lengthwise(count, axis_len):
        field = rng.standard_normal((count, axis_len)).astype(np.float32)
        freq = np.fft.fftfreq(axis_len)[None, :]
        sigma = slub_len_mm*ppm
        field = np.real(np.fft.ifft(np.fft.fft(field, axis=1)*np.exp(-2*np.pi**2*(sigma*freq)**2), axis=1)).astype(np.float32)
        field /= max(float(field.std()), 1e-9)
        return field*np.exp(rng.normal(0, 0.55, (count, 1))).astype(np.float32)   # some yarns far slubbier than others
    column = np.floor(wx).astype(np.int32) % yarns
    row = np.floor(wy).astype(np.int32) % yarns
    along_y = lengthwise(yarns, SIZE)          # warp slubs: per column, along y
    along_x = lengthwise(yarns, SIZE)          # weft slubs: per row, along x
    slub_field = (along_y[column, np.arange(SIZE)[:, None]] + along_x[row, np.arange(SIZE)[None, :]])*0.7071
    return yarn, slub*slub_field


def crumple(rng, tile, rms_mm, scales_mm, weights, crease_gain=0.45):
    """Irregular linen crumple: sharp V creases at zero crossings of smeared noise plus soft folds at several scales."""
    ppm = pixels_per_mm(tile)
    total = np.zeros((SIZE, SIZE), dtype=np.float32)
    sharp = np.zeros((SIZE, SIZE), dtype=np.float32)
    for (long_mm, short_mm), weight in zip(scales_mm, weights):
        z = aniso_noise(rng, long_mm*ppm, short_mm*ppm, rng.uniform(0, np.pi))
        crease = -np.abs(z)
        total += weight*(crease + 0.35*z)
        sharp += weight*(-crease)
    total = zscore(total)*rms_mm/1000
    return total, zscore(sharp)*crease_gain


def build_linen(root, assets, key, tile, rgb, seed, yarn_mm, slub, tone_weave, crumple_rms_mm, tone_crumple, rough_crumple, seam_note,
                scales=((70, 18), (34, 9), (18, 5.5)), weights=(1.0, 0.8, 0.45)):
    rng = np.random.default_rng(seed)
    ppm = pixels_per_mm(tile)
    yarn, slub_field = woven_cloth(rng, tile, yarn_mm, slub, slub_len_mm=7.0, weave_tone=tone_weave, weave_height_mm=0.03)
    wrinkle, sharp = crumple(rng, tile, crumple_rms_mm, scales, weights)
    heather = noise(rng, 2.5*ppm)
    height_m = 0.00003*yarn + 0.00002*slub_field + wrinkle
    tone = 1 + tone_weave*yarn + 0.028*slub_field + 0.012*heather - tone_crumple*sharp
    rough = 0.90 + 0.025*yarn + 0.015*slub_field + rough_crumple*sharp*0.5
    color = np.asarray(rgb, dtype=np.float32)*tone[..., None]
    maps, outputs = save_set(assets, root, key, color, normal_map(height_m, tile), np.clip(rough, .78, .99))
    return {'material': key, 'construction': seam_note, 'tileMetres': tile, 'yarnMm': yarn_mm, 'crumpleRmsMm': crumple_rms_mm,
            'albedoStats': stats_of(maps['basecolor']), 'size': SIZE, 'seed': seed, 'outputs': outputs}


def build_headboard(root, assets, key, tile, rgb, seed):
    """Teal-blue woven/bouclé upholstery: ~2.2 mm slubby weave with visible horizontal slub streaks and loop nap."""
    rng = np.random.default_rng(seed)
    ppm = pixels_per_mm(tile)
    yarn, slub_field = woven_cloth(rng, tile, 2.2, 1.0, slub_len_mm=7.0, weave_tone=0.0, weave_height_mm=0.0)
    loops = noise(rng, 0.7*ppm)
    nap = noise(rng, 1.8*ppm)
    heather = noise(rng, 6.0*ppm)
    height_m = 0.00020*yarn + 0.00009*slub_field + 0.00006*loops
    tone = 1 + 0.060*yarn + 0.026*slub_field + 0.022*loops + 0.016*nap + 0.010*heather
    rough = 0.88 + 0.030*yarn + 0.020*slub_field
    color = np.asarray(rgb, dtype=np.float32)*tone[..., None]
    maps, outputs = save_set(assets, root, key, color, normal_map(height_m, tile), np.clip(rough, .78, .99))
    return {'material': key, 'construction': 'teal woven/bouclé: 2.2 mm slubby plain weave, loop nap, heather', 'tileMetres': tile,
            'albedoStats': stats_of(maps['basecolor']), 'size': SIZE, 'seed': seed, 'outputs': outputs}


def build_derived_basecolor(root, assets, source_key, key, target_rgb):
    """The source material's basecolor re-tinted to a new mean colour (tone variation kept, per channel in linear light)."""
    with Image.open(assets / f'bedroom-{source_key}-basecolor.png') as image:
        lin = decode_srgb(np.asarray(image.convert('RGB'), dtype=np.float32)/255)
    relative = lin/lin.reshape(-1, 3).mean(axis=0)
    pixels = np.rint(255*encode_srgb(relative*decode_srgb(np.asarray(target_rgb, dtype=np.float32)/255))).astype(np.uint8)
    return {'material': key, 'construction': f'{source_key} tone map re-tinted to mean sRGB {tuple(target_rgb)}; normal/roughness shared with {source_key}',
            'albedoStats': stats_of(pixels), 'outputs': {'basecolor': write_png(assets / f'bedroom-{key}-basecolor.png', pixels, root)}}


# ----------------------------------------------------------------------------------------------------------
def build_walnut(root, assets):
    manifest = json.loads((root / '.img2/artifacts/interior/resources.json').read_text())
    hashes = {row['path']: row['sha256'] for row in manifest['downloads']}
    relative = manifest['textures'][WALNUT_SOURCE]['color']
    path = root / relative
    if sha256_file(path) != hashes[relative]:
        raise ValueError(f'{WALNUT_SOURCE} color hash differs from resources.json')
    with Image.open(path) as image:
        scan = decode_srgb(np.asarray(image.convert('RGB'), dtype=np.float32)/255)
    luminance = scan[..., 0]*0.2126 + scan[..., 1]*0.7152 + scan[..., 2]*0.0722
    log_ratio = np.log(np.maximum(luminance/float(np.median(luminance)), 1e-3))
    small, large = WALNUT_BAND_SIGMAS
    blur_small = gaussian_filter_periodic(log_ratio, small, small)
    blur_large = gaussian_filter_periodic(log_ratio, large, large)
    low, mid, fine = blur_large, blur_small - blur_large, log_ratio - blur_small
    sigma_along, sigma_across, mix = WALNUT_MID_STRAIGHTEN                              # smear along U (the grain axis)
    smeared = gaussian_filter_periodic(mid, sigma_along, sigma_across)
    mid = (1 - mix)*mid + mix*smeared*(float(mid.std())/float(smeared.std()))
    ratio = np.exp(WALNUT_GAIN['low']*low + WALNUT_GAIN['mid']*mid + WALNUT_GAIN['fine']*fine)
    ratio = np.clip(ratio, *WALNUT_RATIO_BOUNDS)
    rows, outputs = [], {}
    for key, dye in WALNUT_DYES.items():
        pixels = np.rint(255*encode_srgb(ratio[..., None]*decode_srgb(np.asarray(dye, dtype=np.float32)/255))).astype(np.uint8)
        outputs[key] = write_png(assets / f'bedroom-{key}-basecolor.png', pixels, root)
        rows.append({'material': key, 'dyeSrgb': dye, 'albedoStats': stats_of(pixels), 'outputs': {'basecolor': outputs[key]}})
    return rows, {'gain': WALNUT_GAIN, 'bandSigmasPx': WALNUT_BAND_SIGMAS, 'straighten': WALNUT_MID_STRAIGHTEN,
                  'ratioBounds': WALNUT_RATIO_BOUNDS,
                  'source': {'asset': WALNUT_SOURCE, 'file': relative, 'sha256': hashes[relative]}}


def periodic_u(crop):
    """920-wide crop -> 840-wide strip whose last column continues into its first (cross-fade of the overlap)."""
    out = crop[:, :FLOOR_STRIP_W].copy()
    t = np.linspace(0, 1, FLOOR_OVERLAP, endpoint=False)[None, :, None]
    t = t*t*(3 - 2*t)
    out[:, :FLOOR_OVERLAP] = crop[:, FLOOR_STRIP_W:FLOOR_STRIP_W + FLOOR_OVERLAP]*(1 - t) + crop[:, :FLOOR_OVERLAP]*t
    return out


def build_floor(root, assets):
    manifest = json.loads((root / '.img2/artifacts/interior/resources.json').read_text())
    textures = manifest['textures'][FLOOR_SOURCE]
    hashes = {row['path']: row['sha256'] for row in manifest['downloads']}
    sources = {}
    for channel in ('color', 'normal', 'roughness'):
        path = root / textures[channel]
        if sha256_file(path) != hashes[textures[channel]]:
            raise ValueError(f'{FLOOR_SOURCE} {channel} hash differs from resources.json')
        with Image.open(path) as image:
            sources[channel] = np.asarray(image.convert('L' if channel == 'roughness' else 'RGB'), dtype=np.float32)/255
    dye = decode_srgb(np.asarray(FLOOR_DYE_SRGB, dtype=np.float32)/255)
    strips = {'basecolor': [], 'normal': [], 'roughness': []}
    boards = []
    for (left, top), delta_l in zip(FLOOR_BOARDS, FLOOR_TONE_DL):
        window = (slice(top, top + FLOOR_STRIP_H), slice(left, left + FLOOR_STRIP_W + FLOOR_OVERLAP))
        scan = decode_srgb(sources['color'][window])
        luminance = scan[..., 0]*0.2126 + scan[..., 1]*0.7152 + scan[..., 2]*0.0722
        relative = np.clip(luminance/float(np.median(luminance)), *FLOOR_BOUNDS)
        dye_y = float(dye[0]*0.2126 + dye[1]*0.7152 + dye[2]*0.0722)

        def grain_std(exponent):
            lightness = 116*np.cbrt(np.maximum(relative**exponent*dye_y, 1e-6)) - 16
            return float(lightness.std())
        low, high = 0.2, 6.0
        for _ in range(40):
            mid = (low + high)/2
            low, high = (mid, high) if grain_std(mid) < FLOOR_GRAIN_L_STD else (low, mid)
        exponent = (low + high)/2
        ratio = relative**exponent
        base_l = float(srgb255_to_lab(np.asarray(FLOOR_DYE_SRGB))[0])
        noise_rng = np.random.default_rng(900 + left)
        streak = zscore(gaussian_filter_periodic(
            noise_rng.standard_normal((FLOOR_STRIP_H, FLOOR_STRIP_W + FLOOR_OVERLAP)).astype(np.float32), 40.0, 1.6))
        ratio = ratio*((base_l + FLOOR_STREAK_L_STD*streak + 16)/(base_l + 16))**3
        tone = ((base_l + delta_l + 16)/(base_l + 16))**3
        colour = encode_srgb((ratio*tone)[..., None]*dye)
        rough = sources['roughness'][window]
        rough = np.clip(FLOOR_ROUGHNESS['offset'] + FLOOR_ROUGHNESS['scale']*(rough - float(np.median(rough))),
                        *FLOOR_ROUGHNESS['bounds'])
        strips['basecolor'].append(periodic_u(colour))
        strips['normal'].append(periodic_u(sources['normal'][window]))
        strips['roughness'].append(periodic_u(rough[..., None])[..., 0])
        boards.append({'crop': [left, top, left + FLOOR_STRIP_W + FLOOR_OVERLAP, top + FLOOR_STRIP_H],
                       'toneDeltaLstar': delta_l, 'solvedExponent': exponent})
    maps = {name: np.rint(np.clip(np.concatenate(rows, axis=0), 0, 1)*255).astype(np.uint8) for name, rows in strips.items()}
    outputs = {channel: write_png(assets / f'bedroom-floorwood-{channel}.png', pixels, root) for channel, pixels in maps.items()}
    lab = srgb255_to_lab(maps['basecolor'].reshape(-1, 3).astype(np.float64))
    plank_l = [float(srgb255_to_lab(maps['basecolor'][i*FLOOR_STRIP_H:(i + 1)*FLOOR_STRIP_H].reshape(-1, 3).astype(np.float64))[:, 0].mean())
               for i in range(len(FLOOR_BOARDS))]
    return {'material': 'floorwood',
            'construction': 'deep satin walnut: wooden_floor_02 board strips, deep-walnut dye, grain contrast x2.3, per-plank tone jitter',
            'source': {'asset': FLOOR_SOURCE, 'files': {textures[c]: hashes[textures[c]] for c in textures}},
            'dyeSrgb': FLOOR_DYE_SRGB, 'bounds': FLOOR_BOUNDS, 'grainLstd': FLOOR_GRAIN_L_STD, 'roughness': FLOOR_ROUGHNESS,
            'boardStrips': boards, 'stripSizePx': [FLOOR_STRIP_W, FLOOR_STRIP_H], 'strips': len(FLOOR_BOARDS),
            'uv': {'u': 'along the board, 840 px = bedroom_materials floorwood tile metres', 'vStripMargin': FLOOR_V_MARGIN},
            'albedoStats': {'L_mean': float(lab[:, 0].mean()), 'L_std': float(lab[:, 0].std()),
                            'a_mean': float(lab[:, 1].mean()), 'b_mean': float(lab[:, 2].mean()),
                            'perPlankMeanL': plank_l, 'perPlankMeanLstd': float(np.std(plank_l))},
            'outputs': outputs}


# ----------------------------------------------------------------------------------------------------------
LINEN_PARAMS = dict(yarn_mm=1.0, slub=1.0, tone_weave=0.020, crumple_rms_mm=1.1, tone_crumple=0.05, rough_crumple=0.05)
PILLOW_PARAMS = dict(yarn_mm=1.0, slub=1.1, tone_weave=0.030, crumple_rms_mm=0.9, tone_crumple=0.05, rough_crumple=0.06, scales=((70, 18), (34, 9), (18, 5.5)), weights=(1.0, 0.6, 0.25))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workspace', type=Path, required=True)
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--only', help='comma list: throw,floorwood,walnut,rug,linen,pillow,petrol,linenrear,sheet')
    parser.add_argument('--assets', type=Path, help='output directory for textures (default public/assets/interior); scratch use only')
    args = parser.parse_args()
    if not args.run_id or Path(args.run_id).name != args.run_id or args.run_id in ('.', '..'):
        raise ValueError('run-id must be a single directory name')
    root = args.workspace.resolve(strict=True)
    evidence = root / '.img2/artifacts/interior/production' / args.run_id
    evidence.mkdir(parents=True, exist_ok=False)
    assets = (args.assets or root/'public/assets/interior').resolve()
    assets.mkdir(parents=True, exist_ok=True)
    tiles = load_materials_module(root).TEXTILES
    only = set(args.only.split(',')) if args.only else None
    wanted = lambda key: only is None or key in only  # noqa: E731
    rows, extra = [], {}
    if wanted('throw'):
        rows.append(build_throw(root, assets, tiles['throw']['tile']))
    if wanted('floorwood'):
        rows.append(build_floor(root, assets))
    if wanted('walnut'):
        walnut_rows, extra['walnut'] = build_walnut(root, assets)
        rows.extend(walnut_rows)
    if wanted('rug'):
        rows.append(build_rug(root, assets, tiles['rug']['tile'], tiles['rug']['rgb']))
    if wanted('linen') or wanted('linenrear') or wanted('sheet'):
        rows.append(build_linen(root, assets, 'linen', tiles['linen']['tile'], tiles['linen']['rgb'], 31, **LINEN_PARAMS,
                                seam_note='plain weave with thick/thin slubs and irregular crumple creases (70/34/18 mm scales)'))
    if wanted('pillow'):
        rows.append(build_linen(root, assets, 'pillow', tiles['pillow']['tile'], tiles['pillow']['rgb'], 37, **PILLOW_PARAMS,
                                seam_note='grey linen: slubbed plain weave with irregular crumple creases'))
    if wanted('petrol'):
        rows.append(build_headboard(root, assets, 'petrol', tiles['petrol']['tile'], tiles['petrol']['rgb'], 41))
    for key in ('linenrear', 'sheet'):
        if wanted(key):
            rows.append(build_derived_basecolor(root, assets, tiles[key]['maps_from'], key, tiles[key]['rgb']))
    receipt = {'kind': 'bedroom.distinct-fabrics', 'version': 3, 'materials': rows, 'extra': extra,
               'normalConvention': 'OpenGL +Y, periodic metric finite differences of authored height fields',
               'limits': 'Authored periodic PBR plus Poly Haven / ambientCG CC0 scan detail; not measured BRDF, no photographic room pixels.'}
    (evidence / 'fabrics.json').write_text(json.dumps(receipt, indent=2)+'\n')
    print(json.dumps({'receipt': str(evidence.relative_to(root)/'fabrics.json'), 'materials': [row['material'] for row in rows]}))


if __name__ == '__main__':
    main()

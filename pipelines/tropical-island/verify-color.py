#!/usr/bin/env python3
"""Independent per-vertex / per-triangle / map-median / glass-bounds re-measurement.

Called by verify-surfaces.mjs as a subprocess so the verifier compares the bundled
TS decoder against an independently sampled measurement rather than against the
encoder's own recorded bytes. Re-derives everything the encoder measures:

- per-vertex sRGB colour bytes (full list, with the linear-factor round-trip)
- per-original-triangle class mask (for campfire / palm)
- ORM-sampled median roughness / metalness (every 8th texel per axis, upper-of-two)
- per-base-color texel median
- lamp glass bounds: AABB of every vertex whose source diffuse texel satisfies
  the shared contract, with the texture's KHR_texture_transform / wrapping
  honored exactly the way encode-surfaces.py does it.

Outputs JSON on stdout with: { role, totalVertices, totalTriangles, vertexColors:
<base64 of bytes>, triangleClasses?: <base64 of bytes>, medianBaseColor, medianRoughness,
medianMetalness, glassBounds?, colourHash, triangleClassHash?, vertexCount, triangleCount }.
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import math
import struct
import sys
from pathlib import Path
from typing import Any

from PIL import Image

GL_UBYTE = 5121
GL_USHORT = 5123
GL_UINT = 5125
GL_FLOAT = 5126
WRAP_REPEAT = 10497
WRAP_CLAMP_TO_EDGE = 33071
WRAP_MIRRORED_REPEAT = 33648


def read_glb(path: Path) -> tuple[bytes, dict]:
    data = path.read_bytes()
    if data[:4] != b'glTF':
        raise SystemExit(f'{path}: not a GLB')
    pos = 12
    jchunk = b''
    bchunk = b''
    while pos < len(data):
        cl, ct = struct.unpack_from('<II', data, pos)
        payload = data[pos + 8 : pos + 8 + cl]
        if ct == 0x4E4F534A:
            jchunk = payload
        elif ct == 0x004E4942:
            bchunk = payload
        pos += 8 + cl
    return data, json.loads(jchunk.decode('utf-8'))


def fetch_bv(bin_chunk: bytes, bv_index: int, gltf: dict) -> bytes:
    bv = gltf['bufferViews'][bv_index]
    return bin_chunk[bv['byteOffset']:bv['byteOffset'] + bv['byteLength']]


def decode_indices(blob: bytes, count: int, ctype: int) -> list[int]:
    if ctype == GL_UBYTE:
        return list(blob[:count])
    if ctype == GL_USHORT:
        return list(struct.unpack_from(f'<{count}H', blob, 0))
    if ctype == GL_UINT:
        return list(struct.unpack_from(f'<{count}I', blob, 0))
    raise SystemExit(f'unsupported index componentType {ctype}')


def load_image(bin_chunk: bytes, gltf: dict, image_index: int) -> Image.Image:
    img_meta = gltf['images'][image_index]
    bv_index = img_meta['bufferView']
    blob = fetch_bv(bin_chunk, bv_index, gltf)
    im = Image.open(io.BytesIO(blob))
    im.load()
    return im.convert('RGB')


def srgb_to_linear(c: float) -> float:
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def linear_to_srgb(c: float) -> float:
    return c * 12.92 if c <= 0.0031308 else 1.055 * (c ** (1.0 / 2.4)) - 0.055


def apply_wrap(u: float, wrap: int) -> float:
    if wrap == WRAP_CLAMP_TO_EDGE:
        return max(0.0, min(1.0, u))
    if wrap == WRAP_REPEAT:
        return u - math.floor(u)
    if wrap == WRAP_MIRRORED_REPEAT:
        f = math.floor(u)
        frac = u - f
        return 1.0 - frac if (int(f) & 1) else frac
    raise SystemExit(f'unsupported wrap {wrap}')


def transform_uv(u: float, v: float, t: dict) -> tuple[float, float]:
    # Coefficients of Three.js's UV matrix, independent of the encoder.
    sx, sy = t['scale']
    ox, oy = t['offset']
    c, s = math.cos(t['rotation']), math.sin(t['rotation'])
    return u * sx * c + v * sx * s + ox, -u * sy * s + v * sy * c + oy


def sample_nearest(pixels: Image.Image, u: float, v: float, wrap_s: int, wrap_t: int) -> tuple[int, int, int]:
    w, h = pixels.size
    su = apply_wrap(u, wrap_s)
    sv = apply_wrap(v, wrap_t)
    x = max(0, min(w - 1, int(su * w)))
    y = max(0, min(h - 1, int(sv * h)))
    return pixels.getpixel((x, y))


def classify_campfire(rgb: tuple[int, int, int]) -> int:
    r, g, b = rgb
    if r >= 160 and g >= 60 and r >= g * 0.95 and b < g * 0.8:
        return 0x01
    if r < 160 and g < 120 and r > g * 1.08:
        return 0x02
    return 0


def classify_palm(rgb: tuple[int, int, int]) -> int:
    r, g, b = rgb
    return 0x01 if not (r > g * 1.08 and r > b * 1.15) else 0


def is_lamp_glass(rgb: tuple[int, int, int]) -> bool:
    r, g, b = rgb
    return r >= 215 and g >= 115 and b <= 100


def measure_role(role: str, glb_path: Path) -> dict[str, Any]:
    raw, gltf = read_glb(glb_path)
    prim = gltf['meshes'][0]['primitives'][0]
    attrs = prim['attributes']
    pos_acc = gltf['accessors'][attrs['POSITION']]
    nrm_acc = gltf['accessors'][attrs['NORMAL']]
    uv_acc = gltf['accessors'][attrs['TEXCOORD_0']]
    idx_acc = gltf['accessors'][prim['indices']]
    n = pos_acc['count']
    tri_count = idx_acc['count'] // 3

    # Find the BIN chunk by re-walking GLB. read_glb above only kept the JSON.
    # Re-open the file once for the BIN.
    data = glb_path.read_bytes()
    pos = 12
    bin_chunk = b''
    while pos < len(data):
        cl, ct = struct.unpack_from('<II', data, pos)
        payload = data[pos + 8:pos + 8 + cl]
        if ct == 0x004E4942:
            bin_chunk = payload
        pos += 8 + cl

    pos_blob = fetch_bv(bin_chunk, pos_acc['bufferView'], gltf)
    nrm_blob = fetch_bv(bin_chunk, nrm_acc['bufferView'], gltf)
    uv_blob = fetch_bv(bin_chunk, uv_acc['bufferView'], gltf)
    idx_blob = fetch_bv(bin_chunk, idx_acc['bufferView'], gltf)
    pos_off = pos_acc.get('byteOffset', 0)
    nrm_off = nrm_acc.get('byteOffset', 0)
    uv_off = uv_acc.get('byteOffset', 0)
    idx_off = idx_acc.get('byteOffset', 0)
    if nrm_acc.get('bufferView') == pos_acc.get('bufferView'):
        stride = gltf['bufferViews'][pos_acc['bufferView']].get('byteStride', 32)
        pos_stride = nrm_stride = uv_stride = stride
    else:
        pos_stride = nrm_stride = 12
        uv_stride = 8

    uvs: list[tuple[float, float]] = []
    positions: list[tuple[float, float, float]] = []
    normals: list[tuple[float, float, float]] = []
    for i in range(n):
        positions.append(struct.unpack_from('<3f', pos_blob, pos_off + i * pos_stride))
        normals.append(struct.unpack_from('<3f', nrm_blob, nrm_off + i * nrm_stride))
        uvs.append(struct.unpack_from('<2f', uv_blob, uv_off + i * uv_stride))
    indices = decode_indices(idx_blob[idx_off:], idx_acc['count'], idx_acc['componentType'])

    mat = gltf['materials'][0]
    pbr = mat.get('pbrMetallicRoughness', {})
    bcf = pbr.get('baseColorFactor', [1.0, 1.0, 1.0, 1.0])
    rf = float(pbr.get('roughnessFactor', 1.0))
    mf = float(pbr.get('metallicFactor', 1.0))
    bct_info = pbr.get('baseColorTexture', {})
    bct = gltf['textures'][bct_info['index']]
    base_image_index = bct['source']
    base_sampler_index = bct.get('sampler')
    samplers = gltf.get('samplers', [])
    base_sampler = samplers[base_sampler_index] if base_sampler_index is not None else {}
    wrap_s = base_sampler.get('wrapS', WRAP_REPEAT)
    wrap_t = base_sampler.get('wrapT', WRAP_REPEAT)
    bct_ext = bct_info.get('extensions', {}).get('KHR_texture_transform', {})
    base_tex_transform = {
        'offset': list(bct_ext.get('offset', [0.0, 0.0])),
        'scale': list(bct_ext.get('scale', [1.0, 1.0])),
        'rotation': float(bct_ext.get('rotation', 0.0)),
    }
    pixels = load_image(bin_chunk, gltf, base_image_index)

    def sample_uv(u: float, v: float) -> tuple[int, int, int]:
        u, v = transform_uv(u, v, base_tex_transform)
        return sample_nearest(pixels, u, v, wrap_s, wrap_t)

    # Per-vertex colour
    rs_vert: list[int] = []
    gs_vert: list[int] = []
    bs_vert: list[int] = []
    srgb_bytes = bytearray(n * 3)
    for i, (u, v) in enumerate(uvs):
        r, g, b = sample_uv(u, v)
        rs_vert.append(r); gs_vert.append(g); bs_vert.append(b)
        lr = srgb_to_linear(r / 255.0) * bcf[0]
        lg = srgb_to_linear(g / 255.0) * bcf[1]
        lb = srgb_to_linear(b / 255.0) * bcf[2]
        if lr > 1.0: lr = 1.0
        if lg > 1.0: lg = 1.0
        if lb > 1.0: lb = 1.0
        if lr < 0.0: lr = 0.0
        if lg < 0.0: lg = 0.0
        if lb < 0.0: lb = 0.0
        srgb_bytes[i * 3] = int(round(linear_to_srgb(lr) * 255.0))
        srgb_bytes[i * 3 + 1] = int(round(linear_to_srgb(lg) * 255.0))
        srgb_bytes[i * 3 + 2] = int(round(linear_to_srgb(lb) * 255.0))
    rs_vert.sort(); gs_vert.sort(); bs_vert.sort()
    def median(values: list[int]) -> int:
        return values[len(values) // 2] if values else 0
    median_base_color = [median(rs_vert), median(gs_vert), median(bs_vert)]

    # ORM median
    median_roughness = rf
    median_metalness = mf
    orm_info = pbr.get('metallicRoughnessTexture')
    if orm_info is not None:
        orm_tex = gltf['textures'][orm_info['index']]
        orm = load_image(bin_chunk, gltf, orm_tex['source'])
        rs: list[int] = []
        gs: list[int] = []
        for y in range(0, orm.size[1], 8):
            for x in range(0, orm.size[0], 8):
                _, g, b = orm.getpixel((x, y))
                gs.append(g)
                rs.append(b)
        if rs:
            rs.sort()
            median_metalness = (rs[len(rs) // 2] / 255.0) * mf
        if gs:
            gs.sort()
            median_roughness = (gs[len(gs) // 2] / 255.0) * rf

    # Triangle classes
    triangle_classes: bytearray | None = None
    if role in ('campfire', 'palm'):
        triangle_classes = bytearray(tri_count)
        classifier = classify_campfire if role == 'campfire' else classify_palm
        for t in range(tri_count):
            a = indices[t * 3]
            b = indices[t * 3 + 1]
            c = indices[t * 3 + 2]
            uc = (uvs[a][0] + uvs[b][0] + uvs[c][0]) / 3.0
            vc = (uvs[a][1] + uvs[b][1] + uvs[c][1]) / 3.0
            rgb = sample_uv(uc, vc)
            triangle_classes[t] = classifier(rgb)

    # Glass bounds
    glass_bounds: dict | None = None
    if role == 'lamp':
        gx: list[float] = []
        gy: list[float] = []
        gz: list[float] = []
        for i, (u, v) in enumerate(uvs):
            rgb = sample_uv(u, v)
            if is_lamp_glass(rgb):
                gx.append(positions[i][0]); gy.append(positions[i][1]); gz.append(positions[i][2])
        if gx:
            glass_bounds = {'min': [min(gx), min(gy), min(gz)], 'max': [max(gx), max(gy), max(gz)]}

    import hashlib
    out: dict[str, Any] = {
        'role': role,
        'vertexCount': n,
        'triangleCount': tri_count,
        'vertexColors': base64.b64encode(bytes(srgb_bytes)).decode('ascii'),
        'colourHash': hashlib.sha256(bytes(srgb_bytes)).hexdigest(),
        'medianBaseColor': median_base_color,
        'medianRoughness': median_roughness,
        'medianMetalness': median_metalness,
    }
    if triangle_classes is not None:
        out['triangleClasses'] = base64.b64encode(bytes(triangle_classes)).decode('ascii')
        out['triangleClassHash'] = hashlib.sha256(bytes(triangle_classes)).hexdigest()
    if glass_bounds is not None:
        out['glassBounds'] = glass_bounds
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-dir', type=Path, required=True)
    parser.add_argument('--role', required=True)
    parser.add_argument('--glb', required=True)
    args = parser.parse_args()
    out = measure_role(args.role, args.source_dir / args.glb)
    sys.stdout.write(json.dumps(out))
    return 0


if __name__ == '__main__':
    sys.exit(main())

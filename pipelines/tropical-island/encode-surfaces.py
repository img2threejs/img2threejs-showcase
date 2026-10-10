#!/usr/bin/env python3
"""
Force-measured encoder for the tropical-island props.

Reads ten GLBs from a reference archive, extracts source POSITION / NORMAL /
TEXCOORD_0 / indices verbatim, samples the base-color texture at every vertex UV
with the glTF / KHR_texture_transform / wrap / sampler conventions honored, and
emits TypeScript modules plus a measured-surfaces.json summary. No numpy
dependency; Pillow + stdlib only.

Quantization:
- position: u16 per axis over per-mesh origin / extent
- normal:   octahedral 8x8 with reserved (0,0) for the exact zero vector and
            (255,255) remap for any nonzero vector whose octahedral quantization
            would otherwise collapse to (0,0) (= -Z corner)
- color:    sRGB byte sampled at the vertex UV, multiplied by the linear material
            factor, converted back to sRGB, rounded to a byte
- index:    zigzag varint, lossless

PBR / map support:
- baseColorTexture, metallicRoughnessTexture, normalTexture, occlusionTexture,
  emissiveTexture are looked up via texture -> source -> image -> bufferView, and
  the matching samplers[i] is honored for wrapS / wrapT (REPEAT / CLAMP_TO_EDGE /
  MIRRORED_REPEAT) and minFilter / magFilter.
- The optional KHR_texture_transform is applied to the UV before sampling.
- alphaMode, doubleSided, baseColorFactor, roughnessFactor, metalnessFactor,
  emissiveFactor, alphaCutoff are recorded in the meta and applied to the runtime
  material. Median roughness / metalness come from a sampled median of the
  metallicRoughness map (every 8th texel per axis, upper-of-two for even counts),
  multiplied by the matching material factor.

Usage:
    python3 pipelines/tropical-island/encode-surfaces.py [--source-dir DIR]
                                                        [--out-dir DIR]
                                                        [--work-dir DIR]

The default source directory is `work/tropical-island/reference-models/` (the
gitignored final archive). The GLBs were moved there from the public tree by main
once the encoder was first stable; the encoder takes an explicit `--source-dir`
so the archive can be re-pointed at any directory.
"""

from __future__ import annotations

import argparse
import base64 as _b64lib
import hashlib
import io
import json
import math
import struct
import sys
import time
import zlib
from pathlib import Path
from typing import Any

from PIL import Image

# ----- roles ---------------------------------------------------------------------------------------

ROLES = (
    'house', 'palm', 'dock', 'boat', 'rocks',
    'redRock', 'crate', 'barrel', 'campfire', 'lamp',
)

GLB_NAMES = {
    'house': 'house.glb',
    'palm': 'palm.glb',
    'dock': 'dock.glb',
    'boat': 'boat.glb',
    'rocks': 'rocks.glb',
    'redRock': 'red-rock.glb',
    'crate': 'crate.glb',
    'barrel': 'barrel.glb',
    'campfire': 'campfire.glb',
    'lamp': 'lamp.glb',
}

FRIENDLY_NAME = {
    'house': 'Cabin',
    'palm': 'Palm',
    'dock': 'Dock',
    'boat': 'Boat',
    'rocks': 'Gray shoreline boulders',
    'redRock': 'Red rock island',
    'crate': 'Crate',
    'barrel': 'Barrel',
    'campfire': 'Campfire',
    'lamp': 'Lamp',
}

# Final source archive (gitignored). The encoder default points here so the
# runtime tree does not ship any GLB.
DEFAULT_SOURCE = Path('work/tropical-island/reference-models')
DEFAULT_OUT = Path('src/demos/tropical-island/measured')
DEFAULT_WORK = Path('work/tropical-island/force-measured')

# glTF component / pixel type IDs
GL_BYTE = 5120
GL_UBYTE = 5121
GL_SHORT = 5122
GL_USHORT = 5123
GL_UINT = 5125
GL_FLOAT = 5126

# glTF wrap / filter enum values
WRAP_REPEAT = 10497
WRAP_CLAMP_TO_EDGE = 33071
WRAP_MIRRORED_REPEAT = 33648
FILTER_NEAREST = 9728
FILTER_LINEAR = 9729
FILTER_NEAREST_MIPMAP_NEAREST = 9984
FILTER_LINEAR_MIPMAP_NEAREST = 9985
FILTER_NEAREST_MIPMAP_LINEAR = 9986
FILTER_LINEAR_MIPMAP_LINEAR = 9987

WRAP_NAMES = {
    WRAP_REPEAT: 'REPEAT',
    WRAP_CLAMP_TO_EDGE: 'CLAMP_TO_EDGE',
    WRAP_MIRRORED_REPEAT: 'MIRRORED_REPEAT',
}


# ----- minimal stdlib GLB / glTF reader ------------------------------------------------------------

def read_glb(path: Path) -> tuple[bytes, dict, bytes]:
    raw = path.read_bytes()
    if raw[:4] != b'glTF':
        raise SystemExit(f'{path}: not a GLB (missing glTF magic)')
    version = struct.unpack_from('<I', raw, 4)[0]
    if version != 2:
        raise SystemExit(f'{path}: only GLB 2 supported, got version {version}')
    pos = 12
    json_chunk = b''
    bin_chunk = b''
    while pos < len(raw):
        cl, ct = struct.unpack_from('<II', raw, pos)
        payload = raw[pos + 8 : pos + 8 + cl]
        if ct == 0x4E4F534A:  # JSON
            json_chunk = payload
        elif ct == 0x004E4942:  # BIN
            bin_chunk = payload
        pos += 8 + cl
    gltf = json.loads(json_chunk.decode('utf-8'))
    return raw, gltf, bin_chunk


def fetch_bv_view(bin_chunk: bytes, bv_index: int, gltf: dict) -> bytes:
    bv = gltf['bufferViews'][bv_index]
    return bin_chunk[bv['byteOffset'] : bv['byteOffset'] + bv['byteLength']]


def decode_indices(blob: bytes, count: int, ctype: int) -> list[int]:
    if ctype == GL_UBYTE:
        return list(blob[:count])
    if ctype == GL_USHORT:
        return list(struct.unpack_from(f'<{count}H', blob, 0))
    if ctype == GL_UINT:
        return list(struct.unpack_from(f'<{count}I', blob, 0))
    raise SystemExit(f'unsupported index componentType {ctype}')


# ----- texture loading / sampling ------------------------------------------------------------------

def load_image(bin_chunk: bytes, gltf: dict, image_index: int) -> tuple[Image.Image, int]:
    img_meta = gltf['images'][image_index]
    mime = img_meta.get('mimeType', 'image/jpeg')
    bv_index = img_meta['bufferView']
    blob = fetch_bv_view(bin_chunk, bv_index, gltf)
    if mime == 'image/jpeg':
        im = Image.open(io.BytesIO(blob))
        im.load()
        return im.convert('RGB'), bv_index
    if mime == 'image/png':
        im = Image.open(io.BytesIO(blob))
        im.load()
        return im.convert('RGB'), bv_index
    raise SystemExit(f'unsupported image mime {mime}')


def apply_wrap(u: float, wrap: int) -> float:
    if wrap == WRAP_CLAMP_TO_EDGE:
        return max(0.0, min(1.0, u))
    if wrap == WRAP_REPEAT:
        return u - math.floor(u)
    if wrap == WRAP_MIRRORED_REPEAT:
        f = math.floor(u)
        frac = u - f
        is_odd = int(f) & 1
        return 1.0 - frac if is_odd else frac
    raise SystemExit(f'unsupported wrap mode {wrap}')


def transform_uv(u: float, v: float, transform: dict) -> tuple[float, float]:
    """Three.js Matrix3.setUvTransform with the glTF loader's zero centre."""
    sx, sy = transform['scale']
    ox, oy = transform['offset']
    c, s = math.cos(transform['rotation']), math.sin(transform['rotation'])
    return sx * (c * u + s * v) + ox, sy * (-s * u + c * v) + oy


def sample_nearest(pixels: Image.Image, u: float, v: float, wrap_s: int, wrap_t: int) -> tuple[int, int, int]:
    w, h = pixels.size
    su = apply_wrap(u, wrap_s)
    sv = apply_wrap(v, wrap_t)
    # GLTFLoader applies map.flipY = false by default for GLTF textures; the
    # existing campfire / palm runtime samplers confirm this (no v-flip in their
    # expression). Match that convention here.
    x = max(0, min(w - 1, int(su * w)))
    y = max(0, min(h - 1, int(sv * h)))
    return pixels.getpixel((x, y))


# ----- quantization -------------------------------------------------------------------------------

def encode_position_u16(values: list[float], origin: list[float], extent: list[float]) -> bytes:
    out = bytearray()
    for v, o, e in zip(values, origin, extent):
        if e <= 0.0:
            q = 0
        else:
            t = (v - o) / e
            if t < 0.0: t = 0.0
            elif t > 1.0: t = 1.0
            q = int(round(t * 65535.0))
        out += struct.pack('<H', q)
    return bytes(out)


def encode_normal_oct8(normal: tuple[float, float, float]) -> bytes:
    """Octahedral 8x8. Conventions:
    - exact zero normal -> bytes (0, 0)
    - non-zero normal that quantizes to (0, 0) -> bytes (255, 255) (the -Z corner)
    - otherwise: standard octahedral encode, byte = round(oct * 127.5 + 127.5)
    """
    x, y, z = normal
    norm_sq = x * x + y * y + z * z
    if norm_sq < 1e-20:
        return bytes((0, 0))
    inv_len = 1.0 / math.sqrt(norm_sq)
    nx, ny, nz = x * inv_len, y * inv_len, z * inv_len
    denom = abs(nx) + abs(ny) + abs(nz)
    if denom < 1e-20:
        return bytes((0, 0))
    ox, oy = nx / denom, ny / denom
    if nz < 0:
        ox, oy = (1.0 - abs(oy)) * (1.0 if ox >= 0 else -1.0), (1.0 - abs(ox)) * (1.0 if oy >= 0 else -1.0)
    bx = int(round(ox * 127.5 + 127.5))
    by = int(round(oy * 127.5 + 127.5))
    if bx < 0: bx = 0
    elif bx > 255: bx = 255
    if by < 0: by = 0
    elif by > 255: by = 255
    if bx == 0 and by == 0:
        bx, by = 255, 255
    return bytes((bx, by))


def encode_index_varint(indices: list[int]) -> bytes:
    out = bytearray()
    prev = 0
    for idx in indices:
        delta = idx - prev
        if delta >= 0:
            zz = delta * 2
        else:
            zz = -delta * 2 - 1
        prev = idx
        v = zz
        while True:
            b = v & 0x7F
            v >>= 7
            if v:
                out.append(b | 0x80)
            else:
                out.append(b)
                break
    return bytes(out)


# ----- sRGB / linear -----------------------------------------------------------------------------

def srgb_to_linear(c: float) -> float:
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def linear_to_srgb(c: float) -> float:
    return c * 12.92 if c <= 0.0031308 else 1.055 * (c ** (1.0 / 2.4)) - 0.055


# ----- per-role semantic masks (shared contract) --------------------------------------------------

def classify_campfire_triangle(rgb: tuple[int, int, int]) -> int:
    r, g, b = rgb
    warm = r >= 160 and g >= 60 and r >= g * 0.95 and b < g * 0.8
    if warm:
        return 0x01
    dark_wood = r < 160 and g < 120 and r > g * 1.08
    if dark_wood:
        return 0x02
    return 0


def classify_palm_triangle(rgb: tuple[int, int, int]) -> int:
    r, g, b = rgb
    return 0x01 if not (r > g * 1.08 and r > b * 1.15) else 0


def is_lamp_glass_texel(rgb: tuple[int, int, int]) -> bool:
    r, g, b = rgb
    return r >= 215 and g >= 115 and b <= 100


# ----- mat4 helpers -------------------------------------------------------------------------------

IDENTITY_M4 = [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0]


def node_local_matrix(node: dict) -> list[float]:
    if 'matrix' in node:
        return list(node['matrix'])
    t = node.get('translation', [0.0, 0.0, 0.0])
    r = node.get('rotation', [0.0, 0.0, 0.0, 1.0])
    s = node.get('scale', [1.0, 1.0, 1.0])
    m = [0.0] * 16
    qx, qy, qz, qw = r
    xx = qx * qx; yy = qy * qy; zz = qz * qz
    xy = qx * qy; xz = qx * qz; yz = qy * qz
    wx = qw * qx; wy = qw * qy; wz = qw * qz
    m[0] = (1 - 2 * (yy + zz)) * s[0]
    m[1] = (2 * (xy + wz)) * s[0]
    m[2] = (2 * (xz - wy)) * s[0]
    m[3] = 0
    m[4] = (2 * (xy - wz)) * s[1]
    m[5] = (1 - 2 * (xx + zz)) * s[1]
    m[6] = (2 * (yz + wx)) * s[1]
    m[7] = 0
    m[8] = (2 * (xz + wy)) * s[2]
    m[9] = (2 * (yz - wx)) * s[2]
    m[10] = (1 - 2 * (xx + yy)) * s[2]
    m[11] = 0
    m[12] = t[0]; m[13] = t[1]; m[14] = t[2]; m[15] = 1
    return m


def mat_mul(a: list[float], b: list[float]) -> list[float]:
    out = [0.0] * 16
    for c in range(4):
        for r in range(4):
            s = 0.0
            for k in range(4):
                s += a[k * 4 + r] * b[c * 4 + k]
            out[c * 4 + r] = s
    return out


# ----- source probe + measurement -----------------------------------------------------------------

def unsupported_populated_fields(gltf: dict, role: str) -> list[str]:
    """Narrow fail-fast check: list any populated source feature the encoder does
    not handle. Currently the inputs are static, single-mesh, single-primitive,
    no skin / animation / morph / sparse accessor, so the list should be empty."""
    issues: list[str] = []
    if gltf.get('skins'):
        issues.append(f'skins populated ({len(gltf["skins"])})')
    if gltf.get('animations'):
        issues.append(f'animations populated ({len(gltf["animations"])})')
    if len(gltf.get('scenes', [])) != 1 or len(gltf['scenes'][0].get('nodes', [])) != 1:
        issues.append('source must have one scene with one root')
    for ni, node in enumerate(gltf.get('nodes', [])):
        if len(node.get('children', [])) > 1 or ('mesh' in node and node.get('children')):
            issues.append(f'nodes[{ni}] is not a static single-mesh chain')
    for mi, mat in enumerate(gltf.get('materials', [])):
        for k in ('extensions', 'emissiveTexture', 'occlusionTexture'):
            if mat.get(k):
                issues.append(f'materials[{mi}].{k} populated')
        for key in ('baseColorTexture', 'metallicRoughnessTexture'):
            info = mat.get('pbrMetallicRoughness', {}).get(key, {})
            transform = info.get('extensions', {}).get('KHR_texture_transform', {})
            if transform.get('texCoord', info.get('texCoord', 0)) != 0:
                issues.append(f'materials[{mi}].{key} requires a nonzero UV channel')
        if mat.get('alphaMode', 'OPAQUE') != 'OPAQUE':
            issues.append(f'materials[{mi}] has texture alpha not representable by RGB vertex colours')
    for mi, m in enumerate(gltf.get('meshes', [])):
        for pi, p in enumerate(m.get('primitives', [])):
            if 'targets' in p:
                issues.append(f'mesh[{mi}].primitives[{pi}].targets populated (morph)')
            for k in p.get('extensions', {}):
                issues.append(f'mesh[{mi}].primitives[{pi}].extensions.{k}')
            for k in p.get('attributes', {}):
                if k not in ('POSITION', 'NORMAL', 'TEXCOORD_0'):
                    issues.append(f'mesh[{mi}].primitives[{pi}].attributes.{k} populated')
            if p.get('mode') not in (None, 4):
                issues.append(f'mesh[{mi}].primitives[{pi}].mode={p.get("mode")} (not TRIANGLES)')
    for si, s in enumerate(gltf.get('samplers', [])):
        for k in ('minFilter', 'magFilter'):
            v = s.get(k)
            if v is not None and v not in (
                FILTER_NEAREST, FILTER_LINEAR,
                FILTER_NEAREST_MIPMAP_NEAREST, FILTER_LINEAR_MIPMAP_NEAREST,
                FILTER_NEAREST_MIPMAP_LINEAR, FILTER_LINEAR_MIPMAP_LINEAR,
            ):
                issues.append(f'samplers[{si}].{k}={v} unsupported')
    for ai, acc in enumerate(gltf.get('accessors', [])):
        if acc.get('sparse') is not None:
            issues.append(f'accessors[{ai}].sparse populated')
    return issues


def measure_role(role: str, glb_path: Path) -> dict[str, Any]:
    raw, gltf, bin_chunk = read_glb(glb_path)
    sha = hashlib.sha256(raw).hexdigest()

    issues = unsupported_populated_fields(gltf, role)
    if issues:
        raise SystemExit(f'{role}: unsupported populated source features: ' + '; '.join(issues))

    nodes = gltf.get('nodes', [])
    meshes = gltf.get('meshes', [])
    materials = gltf.get('materials', [])
    if len(meshes) != 1 or len(materials) != 1:
        raise SystemExit(f'{role}: expected 1 mesh/material, got {len(meshes)}/{len(materials)}')
    if meshes[0].get('primitives') is None or len(meshes[0]['primitives']) != 1:
        raise SystemExit(f'{role}: expected 1 primitive')
    prim = meshes[0]['primitives'][0]
    attrs = prim['attributes']
    for k in ('POSITION', 'NORMAL', 'TEXCOORD_0'):
        if k not in attrs:
            raise SystemExit(f'{role}: missing required attribute {k}')
    if 'indices' not in prim:
        raise SystemExit(f'{role}: missing indices (must be indexed)')

    # ----- Walk the node tree: collect the chain of nodes from the scene root
    # down to (and including) the mesh-bearing node, plus their cumulative world
    # matrices. The runtime factory rebuilds the same chain inside the wrapper
    # group so original hierarchy / transforms are preserved.
    scenes = gltf.get('scenes', [])
    if not scenes:
        raise SystemExit(f'{role}: no scene')

    node_chain: list[dict] = []  # [{name, localMatrix, worldMatrix, isMeshNode}]
    visited_mesh = False

    def walk(idx: int, parent_world: list[float]):
        nonlocal visited_mesh
        node = nodes[idx]
        local = node_local_matrix(node)
        world = mat_mul(parent_world, local)
        is_mesh = 'mesh' in node
        node_chain.append({
            'name': node.get('name'),
            'localMatrix': local,
            'worldMatrix': world,
            'isMeshNode': is_mesh,
        })
        if is_mesh:
            visited_mesh = True
            return  # don't descend below the mesh
        for child in node.get('children', []):
            if visited_mesh:
                return
            walk(child, world)

    for scene in scenes:
        for root in scene.get('nodes', []):
            walk(root, IDENTITY_M4)
        if visited_mesh:
            break

    if not visited_mesh or not node_chain:
        raise SystemExit(f'{role}: could not locate a mesh-bearing node')
    mesh_node_world = node_chain[-1]['worldMatrix']

    # ----- Decode vertex data -----
    idx_acc = gltf['accessors'][prim['indices']]
    pos_acc = gltf['accessors'][attrs['POSITION']]
    nrm_acc = gltf['accessors'][attrs['NORMAL']]
    uv_acc = gltf['accessors'][attrs['TEXCOORD_0']]
    n = pos_acc['count']
    tri_count = idx_acc['count'] // 3

    pos_blob = fetch_bv_view(bin_chunk, pos_acc['bufferView'], gltf)
    nrm_blob = fetch_bv_view(bin_chunk, nrm_acc['bufferView'], gltf)
    uv_blob = fetch_bv_view(bin_chunk, uv_acc['bufferView'], gltf)
    idx_blob = fetch_bv_view(bin_chunk, idx_acc['bufferView'], gltf)

    pos_off = pos_acc.get('byteOffset', 0)
    nrm_off = nrm_acc.get('byteOffset', 0)
    uv_off = uv_acc.get('byteOffset', 0)
    idx_off = idx_acc.get('byteOffset', 0)
    if nrm_acc.get('bufferView') == pos_acc.get('bufferView'):
        bv = gltf['bufferViews'][pos_acc['bufferView']]
        stride = bv.get('byteStride', 32)
        pos_stride = nrm_stride = uv_stride = stride
    else:
        pos_stride = 12
        nrm_stride = 12
        uv_stride = 8

    positions: list[tuple[float, float, float]] = []
    normals: list[tuple[float, float, float]] = []
    uvs: list[tuple[float, float]] = []
    for i in range(n):
        p = struct.unpack_from('<3f', pos_blob, pos_off + i * pos_stride)
        positions.append(p)
        nm = struct.unpack_from('<3f', nrm_blob, nrm_off + i * nrm_stride)
        normals.append(nm)
        uv = struct.unpack_from('<2f', uv_blob, uv_off + i * uv_stride)
        uvs.append(uv)
    indices = decode_indices(idx_blob[idx_off:], idx_acc['count'], idx_acc['componentType'])

    if 'min' in pos_acc and 'max' in pos_acc:
        bb_min = list(pos_acc['min'])
        bb_max = list(pos_acc['max'])
    else:
        bb_min = [min(p[i] for p in positions) for i in range(3)]
        bb_max = [max(p[i] for p in positions) for i in range(3)]
    extent = [bb_max[i] - bb_min[i] for i in range(3)]
    origin = bb_min

    # ----- material -----
    mat = materials[0]
    pbr = mat.get('pbrMetallicRoughness', {})
    base_color_factor = list(pbr.get('baseColorFactor', [1.0, 1.0, 1.0, 1.0]))
    roughness_factor = float(pbr.get('roughnessFactor', 1.0))
    metalness_factor = float(pbr.get('metallicFactor', 1.0))
    alpha_mode = mat.get('alphaMode', 'OPAQUE')
    double_sided = bool(mat.get('doubleSided', False))
    emissive_factor = list(mat.get('emissiveFactor', [0.0, 0.0, 0.0]))
    alpha_cutoff = float(mat.get('alphaCutoff', 0.5))

    # ----- texture pipeline -----
    # baseColor: image index + sampler.
    bct_info = pbr.get('baseColorTexture', {})
    bct_index = bct_info.get('index')
    if bct_index is None:
        raise SystemExit(f'{role}: baseColorTexture is required')
    bct = gltf['textures'][bct_index]
    base_image_index = bct['source']
    base_sampler_index = bct.get('sampler')
    samplers = gltf.get('samplers', [])
    base_sampler = samplers[base_sampler_index] if base_sampler_index is not None else {}
    wrap_s = base_sampler.get('wrapS', WRAP_REPEAT)
    wrap_t = base_sampler.get('wrapT', WRAP_REPEAT)
    min_filter = base_sampler.get('minFilter', FILTER_LINEAR_MIPMAP_LINEAR)
    mag_filter = base_sampler.get('magFilter', FILTER_LINEAR)
    # KHR_texture_transform
    bct_ext = bct_info.get('extensions', {}).get('KHR_texture_transform', {})
    base_tex_transform = {
        'offset': list(bct_ext.get('offset', [0.0, 0.0])),
        'scale': list(bct_ext.get('scale', [1.0, 1.0])),
        'rotation': float(bct_ext.get('rotation', 0.0)),
    }
    base_texcoord = bct_info.get('texCoord', 0)
    if base_texcoord != 0:
        raise SystemExit(f'{role}: baseColorTexture.texCoord != 0 ({base_texcoord})')

    pixels, _ = load_image(bin_chunk, gltf, base_image_index)
    if pixels.size[0] < 1 or pixels.size[1] < 1:
        raise SystemExit(f'{role}: base color image has zero dimension')

    def sample_uv(u: float, v: float) -> tuple[int, int, int]:
        u, v = transform_uv(u, v, base_tex_transform)
        return sample_nearest(pixels, u, v, wrap_s, wrap_t)

    # ----- ORM map (for median roughness / metalness) -----
    median_roughness = roughness_factor
    median_metalness = metalness_factor
    orm_info = pbr.get('metallicRoughnessTexture')
    orm_image_index = None
    if orm_info is not None:
        orm_tex = gltf['textures'][orm_info['index']]
        orm_image_index = orm_tex['source']
    if orm_image_index is not None:
        orm_pixels, _ = load_image(bin_chunk, gltf, orm_image_index)
        rs: list[int] = []
        gs: list[int] = []
        for y in range(0, orm_pixels.size[1], 8):
            for x in range(0, orm_pixels.size[0], 8):
                px, g, b = orm_pixels.getpixel((x, y))
                rs.append(b)
                gs.append(g)
        # Upper-of-two for an even count picks the right-of-centre value.
        if rs:
            rs.sort()
            idx = len(rs) // 2 if len(rs) % 2 == 1 else len(rs) // 2
            median_metalness = (rs[idx] / 255.0) * metalness_factor
        if gs:
            gs.sort()
            idx = len(gs) // 2 if len(gs) % 2 == 1 else len(gs) // 2
            median_roughness = (gs[idx] / 255.0) * roughness_factor

    # ----- per-vertex sRGB colour -----
    srgb_vertex = bytearray(n * 3)
    rs_vert: list[int] = []
    gs_vert: list[int] = []
    bs_vert: list[int] = []
    for i, (u, v) in enumerate(uvs):
        r, g, b = sample_uv(u, v)
        rs_vert.append(r); gs_vert.append(g); bs_vert.append(b)
        lr = srgb_to_linear(r / 255.0) * base_color_factor[0]
        lg = srgb_to_linear(g / 255.0) * base_color_factor[1]
        lb = srgb_to_linear(b / 255.0) * base_color_factor[2]
        if lr > 1.0: lr = 1.0
        if lg > 1.0: lg = 1.0
        if lb > 1.0: lb = 1.0
        if lr < 0.0: lr = 0.0
        if lg < 0.0: lg = 0.0
        if lb < 0.0: lb = 0.0
        sr = linear_to_srgb(lr)
        sg = linear_to_srgb(lg)
        sb = linear_to_srgb(lb)
        srgb_vertex[i * 3 + 0] = int(round(sr * 255.0))
        srgb_vertex[i * 3 + 1] = int(round(sg * 255.0))
        srgb_vertex[i * 3 + 2] = int(round(sb * 255.0))

    rs_vert.sort(); gs_vert.sort(); bs_vert.sort()
    def median(values: list[int]) -> int:
        if not values:
            return 0
        return values[len(values) // 2]
    median_base_color = [median(rs_vert), median(gs_vert), median(bs_vert)]

    # ----- per-original-triangle class masks -----
    triangle_classes = bytearray(tri_count)
    if role in ('campfire', 'palm'):
        classifier = classify_campfire_triangle if role == 'campfire' else classify_palm_triangle
        for t in range(tri_count):
            a = indices[t * 3]
            b = indices[t * 3 + 1]
            c = indices[t * 3 + 2]
            uc = (uvs[a][0] + uvs[b][0] + uvs[c][0]) / 3.0
            vc = (uvs[a][1] + uvs[b][1] + uvs[c][1]) / 3.0
            r, g, bl = sample_uv(uc, vc)
            triangle_classes[t] = classifier((r, g, bl))

    # ----- lamp glass bounds: all mesh-local vertices whose source diffuse texel
    # satisfies the test, with the texture's UV transform / wrapping honored.
    glass_bounds: dict | None = None
    if role == 'lamp':
        gx: list[float] = []
        gy: list[float] = []
        gz: list[float] = []
        for i, (u, v) in enumerate(uvs):
            r, g, b = sample_uv(u, v)
            if is_lamp_glass_texel((r, g, b)):
                gx.append(positions[i][0]); gy.append(positions[i][1]); gz.append(positions[i][2])
        if gx:
            glass_bounds = {
                'min': [min(gx), min(gy), min(gz)],
                'max': [max(gx), max(gy), max(gz)],
            }

    # ----- encode stream -----
    pos_stream = bytearray()
    for p in positions:
        pos_stream += encode_position_u16(p, origin, extent)
    nrm_stream = bytearray()
    for nm in normals:
        nrm_stream += encode_normal_oct8(nm)
    idx_stream = encode_index_varint(indices)
    stream = bytes(pos_stream) + bytes(nrm_stream) + bytes(srgb_vertex) + bytes(idx_stream)

    pos_hash = hashlib.sha256(bytes(pos_stream)).hexdigest()
    nrm_hash = hashlib.sha256(bytes(nrm_stream)).hexdigest()
    col_hash = hashlib.sha256(bytes(srgb_vertex)).hexdigest()
    idx_hash = hashlib.sha256(bytes(idx_stream)).hexdigest()
    stream_hash = hashlib.sha256(stream).hexdigest()

    b64 = _b64lib.b64encode(stream).decode('ascii')
    b64_hash = hashlib.sha256(b64.encode('ascii')).hexdigest()

    # Compress the canonical stream once, deterministically, with mtime=0 and
    # level 9. The compressed blob is what the runtime ships in chunks and
    # decompresses via DecompressionStream('gzip').
    compressed = gzip_m0_level9(stream)
    compressed_hash = hashlib.sha256(compressed).hexdigest()

    # ----- node chain: each entry becomes a TS array entry. The mesh-bearing
    # node is the LAST entry and contains the actual mesh. The factory wraps the
    # whole chain in an outer mutable identity group.
    node_chain_for_meta = [
        {
            'name': nd['name'],
            'matrix': nd['localMatrix'],
            'isMeshNode': nd['isMeshNode'],
        }
        for nd in node_chain
    ]

    surface_evidence: dict[str, Any] = {
        'sourceVertexCount': n,
        'sourceTriangleCount': tri_count,
    }
    if role in ('campfire', 'palm'):
        surface_evidence['triangleClasses'] = bytes(triangle_classes)
        surface_evidence['triangleClassHash'] = hashlib.sha256(bytes(triangle_classes)).hexdigest()
    if role == 'lamp' and glass_bounds is not None:
        surface_evidence['glassBounds'] = {
            'min': glass_bounds['min'],
            'max': glass_bounds['max'],
        }
    surface_evidence['sampleUVHash'] = hashlib.sha256(bytes(srgb_vertex)).hexdigest()

    # Per-vertex colour also recorded as a hash for the verifier.
    report: dict[str, Any] = {
        'role': role,
        'glbPath': str(glb_path),
        'sourceSha256': sha,
        'sourceBytes': len(raw),
        'sourceVertexCount': n,
        'sourceTriangleCount': tri_count,
        'sourceBounds': {'min': bb_min, 'max': bb_max, 'extent': extent},
        'sourceNodeChain': node_chain_for_meta,
        'meshNodeWorldMatrix': mesh_node_world,
        'sourceMeshName': meshes[0].get('name'),
        'sourceMaterialName': mat.get('name'),
        'material': {
            'baseColorFactor': base_color_factor,
            'roughnessFactor': roughness_factor,
            'metalnessFactor': metalness_factor,
            'alphaMode': alpha_mode,
            'alphaCutoff': alpha_cutoff,
            'doubleSided': double_sided,
            'emissiveFactor': emissive_factor,
            'maps': {
                'baseColorTexture': {
                    'image': base_image_index,
                    'sampler': base_sampler_index,
                    'width': pixels.size[0],
                    'height': pixels.size[1],
                    'mimeType': gltf['images'][base_image_index].get('mimeType'),
                },
                'hasMetallicRoughnessTexture': orm_image_index is not None,
                'hasNormalTexture': 'normalTexture' in mat,
                'hasOcclusionTexture': 'occlusionTexture' in mat,
                'hasEmissiveTexture': 'emissiveTexture' in mat,
            },
            'baseColorTextureTransform': base_tex_transform,
            'baseColorWrapS': wrap_s,
            'baseColorWrapT': wrap_t,
            'baseColorMinFilter': min_filter,
            'baseColorMagFilter': mag_filter,
            'samplerFlipY': False,
        },
        'measured': {
            'medianBaseColor': median_base_color,
            'medianRoughness': median_roughness,
            'medianMetalness': median_metalness,
            'medianMethod': 'upper median of every eighth ORM texel on each axis, multiplied by the linear material factor; base colour is the per-vertex texel median',
        },
        'codecHashes': {
            'position': pos_hash,
            'normal': nrm_hash,
            'colour': col_hash,
            'index': idx_hash,
            'stream': stream_hash,
            'base64': b64_hash,
            'compressed': compressed_hash,
        },
        'codecSizes': {
            'positions': len(pos_stream),
            'normals': len(nrm_stream),
            'colors': len(srgb_vertex),
            'indices': len(idx_stream),
            'total': len(stream),
            'base64': len(b64),
            'compressed': len(compressed),
        },
        'triangleClassSummary': None,
        'glassBounds': glass_bounds,
    }
    if role in ('campfire', 'palm'):
        warm_count = sum(1 for v in triangle_classes if v & 0x01)
        dark_count = sum(1 for v in triangle_classes if v & 0x02)
        report['triangleClassSummary'] = {
            'warmOrLeaf': warm_count,
            'darkWood': dark_count,
            'total': len(triangle_classes),
        }

    return {
        'role': role,
        'report': report,
        'meta': {
            'version': 1,
            'nodeChain': node_chain_for_meta,
            'meshNodeName': node_chain[-1].get('name'),
            'meshName': meshes[0].get('name'),
            'materialName': mat.get('name'),
            'meshNodeWorldMatrix': mesh_node_world,
            'vertexCount': n,
            'triangleCount': tri_count,
            'origin': origin,
            'extent': extent,
            'bounds': {'min': bb_min, 'max': bb_max, 'extent': extent},
            'bytes': [len(pos_stream), len(nrm_stream), len(srgb_vertex), len(idx_stream)],
            'baseColorFactor': base_color_factor,
            'roughnessFactor': roughness_factor,
            'metalnessFactor': metalness_factor,
            'alphaMode': alpha_mode,
            'alphaCutoff': alpha_cutoff,
            'doubleSided': double_sided,
            'emissiveFactor': emissive_factor,
            'medianBaseColor': median_base_color,
            'medianRoughness': median_roughness,
            'medianMetalness': median_metalness,
            'baseColorTextureTransform': base_tex_transform,
            'baseColorWrapS': wrap_s,
            'baseColorWrapT': wrap_t,
            'baseColorMinFilter': min_filter,
            'baseColorMagFilter': mag_filter,
            'samplerFlipY': False,
            'sourceSha256': sha,
            'sourceBytes': len(raw),
            'route': 'force-measured',
            'codecHashes': {
                'position': pos_hash,
                'normal': nrm_hash,
                'colour': col_hash,
                'index': idx_hash,
                'stream': stream_hash,
                'base64': b64_hash,
                'compressed': compressed_hash,
            },
            'compressedBytes': len(compressed),
        },
        'surfaceEvidence': surface_evidence,
        'base64': b64,
        'stream': stream,
        'compressed': compressed,
    }


# ----- code emission -------------------------------------------------------------------------------

def chunk_b64(s: str) -> str:
    """One literal avoids a deep concatenation AST; atob ignores line breaks."""
    return '`\n' + '\n'.join(s[i:i + 120] for i in range(0, len(s), 120)) + '\n`'


# ----- gzip + chunked payload (deterministic, level 9, mtime 0) ----------------

# Raw compressed bytes per chunk file. The runtime reads each segment
# independently through loadCompressedSurface -> DecompressionStream('gzip').
CHUNK_RAW_BYTES = 192 * 1024  # 192 KiB raw compressed bytes per chunk


def gzip_m0_level9(data: bytes) -> bytes:
    """Deterministic gzip: level 9, mtime 0, XFL=2 (matches the highest
    compression the encoder produces), no original name, no comment, no extra
    field. Header bytes are pinned to make the output byte-identical across
    runs, encoder versions, and platforms."""
    # CompressBody (raw deflate, level 9) via zlib; build a canonical gzip
    # container with mtime = 0 and XFL = 2.
    co = zlib.compressobj(level=9, wbits=-15)  # raw deflate, no header
    body = co.compress(data) + co.flush()
    crc = zlib.crc32(data) & 0xFFFFFFFF
    isize = len(data) & 0xFFFFFFFF
    header = bytes((0x1F, 0x8B, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0xFF))
    trailer = struct.pack('<II', crc, isize)
    return header + body + trailer


def split_compressed_segments(gz: bytes, seg_bytes: int = CHUNK_RAW_BYTES) -> list[bytes]:
    return [gz[off:off + seg_bytes] for off in range(0, len(gz), seg_bytes)]


def chunk_module_text(segment: bytes) -> str:
    """Render one segment as a TypeScript module that default-exports the
    base64 string of the segment. Each chunk is independently importable."""
    b64 = _b64lib.b64encode(segment).decode('ascii')
    lines = [b64[i:i + 120] for i in range(0, len(b64), 120)]
    return (
        '// Auto-generated chunk: gzip level 9, mtime 0, base64 segment.\n'
        'export default (\n'
        '`\n' + '\n'.join(lines) + '\n'
        '`\n);\n'
    )


def write_role_chunks(role: str, compressed: bytes, chunks_dir: Path) -> list[str]:
    """Write each compressed segment as its own chunk module under chunks/.
    Returns the list of chunk filenames (in load order) to be referenced by
    the data_ROLE module's CHUNK_LOADERS array."""
    chunks_dir.mkdir(parents=True, exist_ok=True)
    segs = split_compressed_segments(compressed)
    names: list[str] = []
    for i, seg in enumerate(segs):
        name = f'island-surface-{role}-{i}.ts'
        (chunks_dir / name).write_text(chunk_module_text(seg), encoding='utf-8')
        names.append(name)
    return names


def ts_float_list(values: list[float], indent: str = '  ') -> str:
    if not values:
        return '[]'
    out = ['[']
    line = '  '
    for v in values:
        piece = repr(v) + ','
        if len(line) + len(piece) + 2 > 110:
            out.append(line.rstrip())
            line = '  ' + piece
        else:
            line += piece
    if line.strip():
        out.append(line.rstrip(','))
    out.append(']')
    return ('\n' + indent).join(out)


def write_role_module(
    role: str,
    record: dict,
    out_dir: Path,
    chunk_names: list[str],
) -> None:
    """Emit the per-role data module in the chunked-payload contract:
    - surfaceMeta + surfaceEvidence retained verbatim.
    - No surfaceBase64 export.
    - prepareRole() loads the chunk modules dynamically, passes them to
      loadCompressedSurface, caches the decompressed Uint8Array in a
      module-scope slot. On failure, the pending promise is cleared so a
      later call retries.
    - loadRoleBytes() returns the cached buffer (after prepareRole resolves).
    - decodeRoleSurface() and buildRole() are synchronous and throw a clear
      error if the role has not been prepared.
    - The runtime decoder receives the decompressed Uint8Array; the
      base64 -> bytes boundary lives only in surfaceCodec's chunk decoder.
    """
    meta = record['meta']
    evidence = record['surfaceEvidence']
    friendly = FRIENDLY_NAME[role]

    parts: list[str] = []
    parts.append('  sourceVertexCount: ' + str(evidence['sourceVertexCount']) + ',')
    parts.append('  sourceTriangleCount: ' + str(evidence['sourceTriangleCount']) + ',')
    if 'triangleClasses' in evidence:
        tc_b64 = _b64lib.b64encode(evidence['triangleClasses']).decode('ascii')
        tc_chunked = chunk_b64(tc_b64)
        parts.append('  triangleClasses: bytesFromBase64(\n' + tc_chunked + '\n),')
    if 'glassBounds' in evidence:
        gb = evidence['glassBounds']
        parts.append('  glassBounds: { min: [' + ','.join(repr(v) for v in gb['min']) + '] as const, max: [' + ','.join(repr(v) for v in gb['max']) + '] as const },')
    evidence_str = '{\n' + '\n'.join(parts) + '\n}'

    def fmt_list(values):
        return ts_float_list(values, '    ')

    bmin = fmt_list(meta['bounds']['min'])
    bmax = fmt_list(meta['bounds']['max'])
    ext = fmt_list(meta['bounds']['extent'])
    origin = fmt_list(meta['origin'])
    extent = fmt_list(meta['extent'])
    bcf = fmt_list(meta['baseColorFactor'])
    rf = repr(meta['roughnessFactor'])
    mf = repr(meta['metalnessFactor'])
    alpha = json.dumps(meta['alphaMode'])
    cutoff = repr(meta['alphaCutoff'])
    double = 'true' if meta['doubleSided'] else 'false'
    emf = fmt_list(meta['emissiveFactor'])
    mbc = fmt_list(meta['medianBaseColor'])
    mrf = repr(meta['medianRoughness'])
    mmf = repr(meta['medianMetalness'])
    bt_offset = fmt_list(meta['baseColorTextureTransform']['offset'])
    bt_scale = fmt_list(meta['baseColorTextureTransform']['scale'])
    bt_rot = repr(meta['baseColorTextureTransform']['rotation'])
    wrap_s = repr(meta['baseColorWrapS'])
    wrap_t = repr(meta['baseColorWrapT'])
    min_f = repr(meta['baseColorMinFilter'])
    mag_f = repr(meta['baseColorMagFilter'])
    flip_y = 'true' if meta['samplerFlipY'] else 'false'
    sha = meta['sourceSha256']
    src_bytes = meta['sourceBytes']
    route = meta['route']
    bytes_arr = '[' + ','.join(str(b) for b in meta['bytes']) + ']'

    chain_parts = []
    for nd in meta['nodeChain']:
        chain_parts.append('    { name: ' + json.dumps(nd['name']) + ', matrix: ' + fmt_list(nd['matrix']) + ', isMeshNode: ' + ('true' if nd['isMeshNode'] else 'false') + ' },')
    chain_str = '[\n' + '\n'.join(chain_parts) + '\n  ]'
    world_m = fmt_list(meta['meshNodeWorldMatrix'])

    # Imported symbols: bytesFromBase64 is only needed for the triangleClasses
    # evidence path (campfire, palm). For the other eight roles we do not pull
    # it in.
    if 'triangleClasses' in evidence:
        import_block = (
            "import {\n"
            "  buildMeasuredSurface,\n"
            "  bytesFromBase64,\n"
            "  decodeSurface,\n"
            "  loadCompressedSurface,\n"
            "  type DecodedSurface,\n"
            "  type SurfaceEvidence,\n"
            "  type SurfaceMeta,\n"
            "} from './surfaceCodec';"
        )
    else:
        import_block = (
            "import {\n"
            "  buildMeasuredSurface,\n"
            "  decodeSurface,\n"
            "  loadCompressedSurface,\n"
            "  type DecodedSurface,\n"
            "  type SurfaceEvidence,\n"
            "  type SurfaceMeta,\n"
            "} from './surfaceCodec';"
        )

    loader_lines = '\n'.join(
        f"    () => import('./chunks/{n[:-3] if n.endswith('.ts') else n}')," for n in chunk_names
    )
    # The runtime guard checks `buf.byteLength !== STREAM_BYTES` against the
    # post-decompression buffer. The decompressed buffer is the canonical
    # stream (pos + nrm + srgb + idx), so its length is the stream length.
    stream_bytes = len(record['stream'])

    text = f"""// Auto-generated by pipelines/tropical-island/encode-surfaces.py
// Source: {GLB_NAMES[role]}  sha256={sha}  bytes={src_bytes}
import * as THREE from 'three';
{import_block}

export const surfaceMeta: SurfaceMeta = {{
  version: 1,
  nodeChain: {chain_str},
  meshNodeName: {json.dumps(meta['meshNodeName'])},
  meshName: {json.dumps(meta['meshName'])},
  materialName: {json.dumps(meta['materialName'])},
  meshNodeWorldMatrix: {world_m},
  vertexCount: {meta['vertexCount']},
  triangleCount: {meta['triangleCount']},
  origin: {origin},
  extent: {extent},
  bounds: {{ min: {bmin}, max: {bmax}, extent: {ext} }},
  bytes: {bytes_arr},
  baseColorFactor: {bcf},
  roughnessFactor: {rf},
  metalnessFactor: {mf},
  alphaMode: {alpha},
  alphaCutoff: {cutoff},
  doubleSided: {double},
  emissiveFactor: {emf},
  medianBaseColor: {mbc},
  medianRoughness: {mrf},
  medianMetalness: {mmf},
  baseColorTextureTransform: {{ offset: {bt_offset}, scale: {bt_scale}, rotation: {bt_rot} }},
  baseColorWrapS: {wrap_s},
  baseColorWrapT: {wrap_t},
  baseColorMinFilter: {min_f},
  baseColorMagFilter: {mag_f},
  samplerFlipY: {flip_y},
  sourceSha256: {json.dumps(sha)},
  sourceBytes: {src_bytes},
  route: {json.dumps(route)},
  codecHashes: {{
    position: {json.dumps(meta['codecHashes']['position'])},
    normal: {json.dumps(meta['codecHashes']['normal'])},
    colour: {json.dumps(meta['codecHashes']['colour'])},
    index: {json.dumps(meta['codecHashes']['index'])},
    stream: {json.dumps(meta['codecHashes']['stream'])},
    base64: {json.dumps(meta['codecHashes']['base64'])},
  }},
}};

export const surfaceEvidence: SurfaceEvidence = {evidence_str};

const STREAM_BYTES: number = {stream_bytes};

const CHUNK_LOADERS: ReadonlyArray<() => Promise<{{ default: string }}>> = [
{loader_lines}
];

let __bytes: Uint8Array | null = null;
let __prepare: Promise<void> | null = null;

export async function prepareRole(): Promise<void> {{
  if (__bytes) return;
  if (__prepare) return __prepare;
  const p = (async () => {{
    const buf = await loadCompressedSurface(CHUNK_LOADERS);
    if (buf.byteLength !== STREAM_BYTES) {{
      throw new Error(`tropical-island/measured/{role}: decompressed byteLength ${{buf.byteLength}} != expected ${{STREAM_BYTES}}`);
    }}
    __bytes = buf;
  }})();
  __prepare = p;
  try {{ await p; }}
  catch (e) {{ __prepare = null; throw e; }}
}}

export async function loadRoleBytes(): Promise<Uint8Array> {{
  await prepareRole();
  if (!__bytes) throw new Error('tropical-island/measured/{role}: bytes unavailable after prepare');
  return __bytes;
}}

export function decodeRoleSurface(): DecodedSurface {{
  if (!__bytes) throw new Error('tropical-island/measured/{role}: not prepared; call prepareRole() first');
  return decodeSurface(surfaceMeta, __bytes);
}}

export function buildRole(): THREE.Group {{
  if (!__bytes) throw new Error('tropical-island/measured/{role}: not prepared; call prepareRole() first');
  return buildMeasuredSurface(surfaceMeta, __bytes, surfaceEvidence, {json.dumps(friendly)});
}}
"""
    (out_dir / f'data_{role}.ts').write_text(text, encoding='utf-8')


# props.ts is hand-owned: it carries the async preloadMeasuredProps + the
# createMeasuredProp role->build table. The encoder does not emit it; main
# owns regeneration and the runtime contract is documented in props.ts.


def write_measured_surfaces_json(roles_data: list[dict], out_path: Path) -> None:
    summary = {
        'schemaVersion': 1,
        'kind': 'tropical-island-force-measured',
        'generatedAt': int(time.time() * 1000),
        'encoder': 'pipelines/tropical-island/encode-surfaces.py',
        'encoderVersion': 3,
        'quantization': {
            'position': 'u16 per axis over per-mesh origin/extent',
            'normal': 'octahedral 8x8 with reserved (0,0)=zero and (255,255)=-Z corner',
            'index': 'zigzag varint (lossless)',
            'color': 'sRGB byte sampled at the vertex UV with KHR_texture_transform + wrap honored, multiplied by the linear material factor and converted back to sRGB',
        },
        'roles': [r['report'] for r in roles_data],
    }
    out_path.write_text(json.dumps(summary, indent=2), encoding='utf-8')


# ----- main -----------------------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description='Force-measured tropical-island surface encoder')
    parser.add_argument('--source-dir', type=Path, default=DEFAULT_SOURCE)
    parser.add_argument('--out-dir', type=Path, default=DEFAULT_OUT)
    parser.add_argument('--work-dir', type=Path, default=DEFAULT_WORK)
    args = parser.parse_args()

    out_dir: Path = args.out_dir
    work_dir: Path = args.work_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    work_dir.mkdir(parents=True, exist_ok=True)
    if not args.source_dir.is_dir():
        print(f'source directory not found: {args.source_dir}', file=sys.stderr)
        return 1

    roles_data: list[dict] = []
    for role in ROLES:
        glb_path = args.source_dir / GLB_NAMES[role]
        if not glb_path.exists():
            print(f'missing GLB: {glb_path}', file=sys.stderr)
            return 1
        print(f'[encoder] {role}: {glb_path}', file=sys.stderr)
        record = measure_role(role, glb_path)
        roles_data.append(record)

    chunks_dir = out_dir / 'chunks'
    for r in roles_data:
        chunk_names = write_role_chunks(r['role'], r['compressed'], chunks_dir)
        r['_chunkNames'] = chunk_names
    for r in roles_data:
        write_role_module(r['role'], r, out_dir, r['_chunkNames'])
    # props.ts is hand-owned (chunks-aware preloadMeasuredProps + createMeasuredProp).
    # The encoder no longer emits it; the contract is documented in props.ts.

    summary_path = Path('pipelines/tropical-island/measured-surfaces.json')
    summary_path.parent.mkdir(parents=True, exist_ok=True)
    write_measured_surfaces_json(roles_data, summary_path)
    (work_dir / 'measured-surfaces.json').write_text(summary_path.read_text(encoding='utf-8'), encoding='utf-8')

    print('\n[encoder] generated byte counts:', file=sys.stderr)
    for r in roles_data:
        report = r['report']
        print(
            f"  {r['role']:<8s} "
            f"pos={report['codecSizes']['positions']:<7d} "
            f"nrm={report['codecSizes']['normals']:<7d} "
            f"col={report['codecSizes']['colors']:<7d} "
            f"idx={report['codecSizes']['indices']:<7d} "
            f"total={report['codecSizes']['total']:<7d} "
            f"b64={report['codecSizes']['base64']:<7d} "
            f"gz={report['codecSizes']['compressed']:<7d} "
            f"segs={len(r['_chunkNames']):<2d} "
            f"src={report['sourceBytes']}",
            file=sys.stderr,
        )
    return 0


if __name__ == '__main__':
    sys.exit(main())

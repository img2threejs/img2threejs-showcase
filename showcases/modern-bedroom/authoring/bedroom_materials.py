"""Reference-led bedroom PBR factory; importing this module authors nothing.

TEXTILES is the single source of UV0 metres-per-repeat (`uv_tile_metres`) for the generated fabric
textures; prepare_bedroom_fabrics.py reads the same table, build_scene.py reads it through
`m[key]['uv_tile_metres']`.
"""


def _linear(rgb):
    return tuple(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4
                 for v in (channel / 255 for channel in rgb))


# key: base colour (sRGB 0-255; the texture overrides it, kept equal to the texture mean), UV0 metres per
# repeat, normal-map strength, sheen (weight, linear tint, roughness). The exported glTF sheenColorFactor is
# tint x weight (pipeline.export_gltf) and must stay <= 0.15 (material-policy.json).
_DEFAULT_SHEEN = (0.12, (0.12, 0.11, 0.10), 0.8)  # weight, linear tint, roughness
_LINEN_SHEEN = (0.25, (0.55, 0.53, 0.50), 0.5)    # soft grazing sheen of crumpled linen: 0.25 x 0.55 = 0.1375
TEXTILES = {
    # Duvet / mattress linen: warm greige-ivory, crumple tile 0.32 m so the creases do not repeat visibly on the 2.7 m duvet.
    'linen': {'rgb': (211, 207, 199), 'tile': 0.32, 'strength': 1.0, 'sheen': _LINEN_SHEEN},
    # Rear pillows (cream) and fitted sheet (taupe): linen weave/crumple maps, own albedo.
    'linenrear': {'rgb': (214, 208, 197), 'tile': 0.32, 'strength': 1.0, 'maps_from': 'linen', 'sheen': _LINEN_SHEEN},
    'sheet': {'rgb': (190, 168, 150), 'tile': 0.32, 'strength': 1.0, 'maps_from': 'linen', 'sheen': _LINEN_SHEEN},
    # Front pillows: grey crumpled linen.
    'pillow': {'rgb': (162, 161, 156), 'tile': 0.28, 'strength': 1.0, 'sheen': _LINEN_SHEEN},
    # Headboard: teal woven/bouclé, 2.2 mm slubby weave (tile = 120 yarns).
    'petrol': {'rgb': (122, 132, 134), 'tile': 0.264, 'strength': 0.9, 'sheen': _LINEN_SHEEN},
    # Throw: vertical wale seed stitch (throwtex-r02): 36 wales x 32 lobe rows per 0.48 m tile -> wale 13.3 mm,
    # lobe row 15.0 mm, lobes 14.9 x 16.8 mm that fill their cell and touch (only a ~1 mm crease between
    # them); Fabric085 scan only supplies fibre micro-relief. Neutral charcoal. Sheen 0.30 x tint stays
    # within the 0.15 exported sheenColorFactor ceiling of material-policy.json.
    'throw': {'rgb': (68, 66, 65), 'tile': 0.48, 'strength': 1.0,
              'sheen': (0.30, _linear((184, 180, 176)), 0.35), 'specular': 0.22},
    # Rug: dense soft low-pile heather (fibre grain 0.4-4 mm, no grid / streaks).
    'rug': {'rgb': (150, 145, 136), 'tile': 0.48, 'strength': 0.9},
    # Drape (155,147,135) -> (143,139,134): under the final fill lighting the drape rendered L* 35/38, a* 5.4/4.4, b* 2.0/2.2
    # vs reference 29.8/35.3, 3.0/3.1, 7.4/7.4 (GeoLight): Y x0.84, a* 0.8->0.5, b* 7.4->3.0 (B x1.12 of the audit over-corrected).
    'drape': {'rgb': (143, 139, 134), 'tile': 0.18, 'strength': 0.24},
    'sheer': {'rgb': (235, 232, 222), 'tile': 0.14, 'strength': 0.12},
}
SHEER_ALPHA = 0.70
_NAMES = {'walnutdark': 'WalnutDark', 'walnutwarm': 'WalnutWarm', 'linenrear': 'LinenRear'}


def build_materials(context):
    """Create materials once in a blank scene, using explicit UV0 source maps."""
    h = context.helpers
    materials = {}

    def make(key, rgb, roughness, tile=1.0, maps=None, strength=0.2, metallic=0.0):
        mat = h.material('Bedroom.' + _NAMES.get(key, key.capitalize()), _linear(rgb),
                         roughness=roughness, metallic=metallic, maps=maps,
                         normal_strength=strength)
        mat['uv_tile_metres'] = tile
        nodes, links = mat.node_tree.nodes, mat.node_tree.links
        shader = next(node for node in nodes if node.type == 'BSDF_PRINCIPLED')
        shader.inputs['Specular IOR Level'].default_value = 0.3
        if maps:
            # Never let a subsequent bake's active UV1 redirect the source images.
            uv = nodes.new('ShaderNodeUVMap')
            uv.uv_map = 'UV0'
            uv.label = 'Physical material UV0, independent of lightmap UV1'
            for node in nodes:
                if node.type == 'TEX_IMAGE':
                    links.new(uv.outputs['UV'], node.inputs['Vector'])
                    node.extension = 'REPEAT'
        materials[key] = mat
        return mat, shader

    make('plaster', (218, 211, 195), 0.89)
    walnut_normal = 'resources/polyhaven/black_walnut_veneer_02/black_walnut_veneer_02_nor_gl_2k.jpg'
    # Satin veneer: roughness image median 0.48 (was 0.56) and specular level 0.4 (was 0.3) for a soft broad sheen.
    _, walnut_shader = make('walnut', (115, 90, 78), 1.0, tile=1.0, strength=0.16, maps={
        'color': 'public/assets/interior/bedroom-walnut-basecolor.png',
        'normal': walnut_normal,
        'roughness': 'public/assets/interior/bedroom-walnut-roughness.png',
    })
    walnut_shader.inputs['Specular IOR Level'].default_value = 0.4
    # Near wardrobe (lit, orange): same veneer maps, warmer/lighter albedo.
    _, warm_shader = make('walnutwarm', (149, 106, 77), 1.0, tile=1.0, strength=0.16, maps={
        'color': 'public/assets/interior/bedroom-walnutwarm-basecolor.png',
        'normal': walnut_normal,
        'roughness': 'public/assets/interior/bedroom-walnut-roughness.png',
    })
    warm_shader.inputs['Specular IOR Level'].default_value = 0.4
    # Dedicated dark walnut for the shaded dresser niche (reference (63,39,25), authored albedo (72,45,29)).
    _, dark_shader = make('walnutdark', (72, 45, 29), 1.0, tile=1.0, strength=0.16, maps={
        'color': 'public/assets/interior/bedroom-walnutdark-basecolor.png',
        'normal': walnut_normal,
        'roughness': 'public/assets/interior/bedroom-walnut-roughness.png',
    })
    dark_shader.inputs['Specular IOR Level'].default_value = 0.4
    # Deep walnut, satin lacquer: roughness image median 0.30 (surfaces.json floor-satin), spec level 0.5
    # (was 0.3) so the sky/window reflection appears at grazing view; chroma stays in the diffuse map.
    _, floor_shader = make('floorwood', (115, 90, 80), 1.0, tile=1.47, strength=0.24, maps={
        'color': 'public/assets/interior/bedroom-floorwood-basecolor.png',
        'normal': 'public/assets/interior/bedroom-floorwood-normal.png',
        'roughness': 'public/assets/interior/bedroom-floorwood-roughness.png',
    })
    floor_shader.inputs['Specular IOR Level'].default_value = 0.5
    for key, spec in TEXTILES.items():
        source = spec.get('maps_from', key)
        prefix = 'public/assets/interior/bedroom-' + source
        mat, shader = make(key, spec['rgb'], 1.0, spec['tile'], {
            'color': 'public/assets/interior/bedroom-' + key + '-basecolor.png',
            'normal': prefix + '-normal.png',
            'roughness': prefix + '-roughness.png',
        }, spec['strength'])
        weight, tint, sheen_roughness = spec.get('sheen', _DEFAULT_SHEEN)
        # Tinted sheen even before the pipeline's export weight correction (tint * weight -> sheenColorFactor).
        shader.inputs['Sheen Weight'].default_value = weight
        shader.inputs['Sheen Tint'].default_value = (*tint, 1.0)
        shader.inputs['Sheen Roughness'].default_value = sheen_roughness
        shader.inputs['Specular IOR Level'].default_value = spec.get('specular', 0.22)
        if key == 'sheer':
            # Alpha is a portable coverage approximation, not opaque transmission.
            # 0.32 -> 0.70: reference sheer reads L* 91-92 (its own albedo); at 0.32 the glass sky behind it dominated
            # (ours L* 96-98, mullions/see-through hp 5.0 vs 1.0).
            shader.inputs['Alpha'].default_value = SHEER_ALPHA
            mat.diffuse_color = (*_linear(spec['rgb']), SHEER_ALPHA)
            mat.surface_render_method = 'DITHERED'
            mat.use_transparent_shadow = True
            mat.use_backface_culling = False
    # Window frame / rails / hardware: reference mullion reads dark grey (L* ~40-50, sRGB ~93-120), never black. A mostly
    # dielectric finish (metallic 0.1) keeps it from mirroring a dark room (old metallic 0.75 rendered L* 2-16).
    make('metal', (100, 100, 98), 0.5, metallic=0.10)
    # Pendant shell / canopy / cable: reference (54,52,48) L* 22.
    make('metaldark', (70, 67, 62), 0.5, metallic=0.10)
    make('stone', (207, 194, 171), 0.68)
    glass, shader = make('glass', (243, 249, 248), 0.08)
    shader.inputs['Transmission Weight'].default_value = 1.0
    shader.inputs['IOR'].default_value = 1.45
    # Thin glazing: mostly uncovered surface keeps daylight shadow transport open
    # in Cycles and alpha-capable glTF consumers without an opaque shadow blocker.
    shader.inputs['Alpha'].default_value = 0.10
    glass.diffuse_color = (*_linear((243, 249, 248)), 0.10)
    glass.surface_render_method = 'DITHERED'
    glass.use_transparent_shadow = True
    glass.use_backface_culling = False
    make('ceramic', (179, 168, 145), 0.76)
    # Art backing/books: reference art_frame region is 2.26x too bright at ours (208,201,184); albedo to (168,161,146).
    make('art', (168, 161, 146), 0.94)
    make('exterior', (190, 194, 189), 0.92)
    return materials

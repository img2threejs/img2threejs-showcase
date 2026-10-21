"""Authored visual daylight sky, separate from diffuse illumination.

Camera-ray world branch only: diffuse/glossy GI continues to use the original
constant world. This is not source-measured radiance or an outdoor HDR capture.
"""
from pathlib import Path
import hashlib
import json
import math
import uuid
import bpy

ROOT = Path(__file__).resolve().parent
SKY = ROOT / 'public/assets/interior/bedroom-sky.exr'

def build():
    width, height = 256, 128
    image = bpy.data.images.new('Bedroom.authored-daylight-sky', width=width,
                               height=height, float_buffer=True, alpha=True)
    pixels = []
    for row in range(height):
        elevation = -math.cos(math.pi * (row + .5) / height)
        if elevation >= 0:
            t = elevation ** .6
            color = tuple(a*(1-t)+b*t for a,b in zip((2.3,2.4,2.5),(1.4,1.65,2.0)))
        else:
            t = min(1, -elevation*3)
            color = tuple(a*(1-t)+b*t for a,b in zip((2.3,2.4,2.5),(.5,.48,.43)))
        pixels.extend((*color, 1.0) * width)
    image.pixels.foreach_set(pixels)
    settings = bpy.context.scene.render.image_settings
    settings.file_format, settings.color_mode = 'OPEN_EXR', 'RGB'
    settings.color_depth, settings.exr_codec = '32', 'ZIP'
    image.save_render(str(SKY), scene=bpy.context.scene)
    return image

def apply_world(world):
    tree = world.node_tree
    base = tree.nodes['Background']
    output = next(n for n in tree.nodes if n.type == 'OUTPUT_WORLD')
    environment = tree.nodes.new('ShaderNodeTexEnvironment')
    environment.image = bpy.data.images.load(str(SKY), check_existing=False)
    environment.image.pack()
    environment.label = 'Authored visual sky, not diffuse illumination'
    sky = tree.nodes.new('ShaderNodeBackground')
    sky.inputs['Strength'].default_value = 1.0
    camera = tree.nodes.new('ShaderNodeLightPath')
    mix = tree.nodes.new('ShaderNodeMixShader')
    tree.links.new(environment.outputs['Color'], sky.inputs['Color'])
    tree.links.new(camera.outputs['Is Camera Ray'], mix.inputs[0])
    tree.links.new(base.outputs[0], mix.inputs[1])
    tree.links.new(sky.outputs[0], mix.inputs[2])
    tree.links.new(mix.outputs[0], output.inputs['Surface'])

if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply-master', action='store_true')
    parser.add_argument('--run-id', required=True, help='Fresh evidence directory; existing rounds are never overwritten.')
    args = parser.parse_args()
    if not args.run_id or Path(args.run_id).name != args.run_id or args.run_id in ('.', '..'):
        raise ValueError('run-id must be a single directory name')
    output = ROOT / '.img2/artifacts/interior/production' / args.run_id
    if output.exists():
        raise FileExistsError(f'Refuse to overwrite evidence: {output}')
    master = ROOT / 'public/assets/interior/room-master.blend'
    if args.apply_master:
        bpy.ops.wm.open_mainfile(filepath=str(master))
        if any(n.type == 'TEX_ENVIRONMENT' for n in bpy.context.scene.world.node_tree.nodes):
            raise RuntimeError('Refuse duplicate sky branch on already modified master')
    output.mkdir(parents=True, exist_ok=False)
    build()
    receipt = {'origin':'authored-local-gradient', 'purpose':'camera-ray visual background; not diffuse/glossy GI',
               'linearZenith':[1.4,1.65,2.0], 'linearHorizon':[2.3,2.4,2.5],
               'path':str(SKY.relative_to(ROOT)), 'size':[256,128],
               'sha256':hashlib.sha256(SKY.read_bytes()).hexdigest(), 'bytes':SKY.stat().st_size,
               'sourceMeasuredRadiance':False}
    if args.apply_master:
        scene = bpy.context.scene
        receipt['previousRevision'] = scene['authoring_revision']
        apply_world(scene.world)
        summary = json.loads(scene['authoring_summary_json'])
        summary['assumptions'].append('Authored camera-ray sky is visual-only; original constant diffuse/glossy world remains unchanged.')
        scene['authoring_summary_json'] = scene['interior_metadata'] = json.dumps(summary)
        # Diffuse path is unchanged; retain atlases, require a fresh camera probe.
        scene['authoring_revision'] = uuid.uuid4().hex
        receipt['revision'] = scene['authoring_revision']
        bpy.ops.file.pack_all()
        bpy.context.preferences.filepaths.save_version = 0
        bpy.ops.wm.save_as_mainfile(filepath=str(master), compress=True)
    (output/'background.json').write_text(json.dumps(receipt,indent=2)+'\n')
    print(json.dumps(receipt))

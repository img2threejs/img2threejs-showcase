#!/usr/bin/env python3
"""Import an exported GLB/glTF/OBJ/STL/PLY with Blender and verify DCC data."""

import argparse
import bpy
import json
from pathlib import Path
import sys


def arguments() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("asset")
    parser.add_argument("--min-meshes", type=int, default=1)
    parser.add_argument("--min-bones", type=int, default=0)
    parser.add_argument("--min-weighted-meshes", type=int, default=0)
    parser.add_argument("--min-actions", type=int, default=0)
    parser.add_argument("--min-images", type=int, default=0)
    parser.add_argument("--min-textured-materials", type=int, default=0)
    parser.add_argument("--min-color-attributes", type=int, default=0)
    parser.add_argument("--summary-only", action="store_true")
    return parser.parse_args(argv)


args = arguments()
bpy.ops.wm.read_factory_settings(use_empty=True)
extension = Path(args.asset).suffix.lower()
importers = {
    ".glb": bpy.ops.import_scene.gltf,
    ".gltf": bpy.ops.import_scene.gltf,
    ".obj": bpy.ops.wm.obj_import,
    ".stl": bpy.ops.wm.stl_import,
    ".ply": bpy.ops.wm.ply_import,
}
if extension not in importers:
    raise SystemExit(f"unsupported Blender validation format: {extension}")
import_result = importers[extension](filepath=args.asset)

mesh_objects = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
armatures = [obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE"]
materials = list(bpy.data.materials)
images = [image for image in bpy.data.images if image.source != "VIEWER"]
actions = list(bpy.data.actions)
textured_materials = sum(
    1
    for material in materials
    if material.node_tree
    and any(
        node.type == "TEX_IMAGE" and getattr(node, "image", None) is not None
        for node in material.node_tree.nodes
    )
)
weighted_meshes = sum(1 for obj in mesh_objects if len(obj.vertex_groups) > 0)
armature_modifiers = sum(
    1
    for obj in mesh_objects
    for modifier in obj.modifiers
    if modifier.type == "ARMATURE"
)
color_attributes = sum(len(obj.data.color_attributes) for obj in mesh_objects)

summary = {
    "asset": args.asset,
    "format": extension.removeprefix("."),
    "importResult": sorted(import_result),
    "objects": len(bpy.context.scene.objects),
    "meshObjects": len(mesh_objects),
    "namedMeshObjects": sum(1 for obj in mesh_objects if bool(obj.name)),
    "armatures": len(armatures),
    "bones": sum(len(obj.data.bones) for obj in armatures),
    "weightedMeshes": weighted_meshes,
    "armatureModifiers": armature_modifiers,
    "materials": len(materials),
    "texturedMaterials": textured_materials,
    "images": len(images),
    "packedImages": sum(1 for image in images if image.packed_file is not None),
    "colorAttributes": color_attributes,
    "actions": len(actions),
    "actionSlots": sum(len(action.slots) for action in actions),
    "actionNames": [action.name for action in actions],
}
if not args.summary_only:
    summary["meshNames"] = [obj.name for obj in mesh_objects]

requirements = {
    "meshObjects": args.min_meshes,
    "bones": args.min_bones,
    "weightedMeshes": args.min_weighted_meshes,
    "actions": args.min_actions,
    "images": args.min_images,
    "texturedMaterials": args.min_textured_materials,
    "colorAttributes": args.min_color_attributes,
}
failures = [
    f"{field}: expected >= {minimum}, found {summary[field]}"
    for field, minimum in requirements.items()
    if summary[field] < minimum
]
summary["requirements"] = requirements
summary["failures"] = failures
summary["passed"] = not failures and "FINISHED" in import_result
print("IMG2THREEJS_BLENDER " + json.dumps(summary, ensure_ascii=False, sort_keys=True))
if not summary["passed"]:
    raise SystemExit(1)

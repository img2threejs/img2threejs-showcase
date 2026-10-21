"""Reference-specific bedroom, authored in metres / Blender Z-up.

No imported room assets or photographic planes. Native cloth interactions use the
unmodified helper lattice; bedding is separately authored closed geometry.
"""
import importlib.util
import json
import math

import bmesh
import numpy as np
import bpy
from mathutils import Vector


def build_scene(context):
    h = context.helpers
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = 'METRIC'
    scene.unit_settings.scale_length = 1.0
    module_spec = importlib.util.spec_from_file_location(
        'bedroom_workspace_materials', context.workspace / 'bedroom_materials.py')
    materials_module = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(materials_module)
    m = materials_module.build_materials(context)

    def tile(key, default=1.0):
        return float(m[key].get('uv_tile_metres', default))

    def box(name, position, size, key, component, bevel=0.0):
        obj = h.box(name, position, size, m[key], component,
                    bevel=bevel, tile=tile(key))
        if key in {'walnut', 'walnutdark', 'walnutwarm'} and component in {'floor', 'wardrobe'}:
            # Material image grain is U: floor length is Y, wardrobe height is Z.
            for uv in obj.data.uv_layers['UV0'].data:
                u, v = uv.uv
                uv.uv = (v, -u)
        return obj

    def tube(name, points, radius, key, component, cyclic=False):
        obj = h.tube(name, points, radius, m[key], component, cyclic=cyclic)
        h.project_uv(obj, metres=tile(key))
        return obj

    def soft(name, position, size, key, component, **kwargs):
        obj = h.cushion(name, position, size, m[key], component=component,
                        finish=None, tile=tile(key, 0.75), **kwargs)
        seam = bpy.data.objects.get(name + '.welt.0')
        if seam is not None:
            h.project_uv(seam, metres=tile(key, 0.75))
        return obj

    def cloth_volume(name, nx, ny, sample, key, thickness, uv_span):
        # Two corresponding grids and stitched perimeter: closed, including underside.
        top = [sample(i / nx, j / ny) for j in range(ny + 1) for i in range(nx + 1)]
        count = len(top)
        # Offset along the surface normal: a Z-only offset overlaps vertical drapes.
        normals = []
        for j in range(ny + 1):
            for i in range(nx + 1):
                left = Vector(top[j*(nx+1)+max(0,i-1)])
                right = Vector(top[j*(nx+1)+min(nx,i+1)])
                before = Vector(top[max(0,j-1)*(nx+1)+i])
                after = Vector(top[min(ny,j+1)*(nx+1)+i])
                normals.append((right-left).cross(after-before).normalized())
        orientation = 1 if normals[0].z >= 0 else -1
        vertices = top + [tuple(Vector(p)-n*(thickness*orientation))
                          for p,n in zip(top,normals)]
        faces = []
        for j in range(ny):
            for i in range(nx):
                a = j * (nx + 1) + i
                q = (a, a + 1, a + nx + 2, a + nx + 1)
                outward = q if orientation > 0 else tuple(reversed(q))
                faces.append(outward)
                faces.append(tuple(v + count for v in reversed(outward)))
        edge = (list(range(nx + 1)) + [j * (nx + 1) + nx for j in range(1, ny + 1)]
                + [ny * (nx + 1) + i for i in range(nx - 1, -1, -1)]
                + [j * (nx + 1) for j in range(ny - 1, 0, -1)])
        for a, b in zip(edge, edge[1:] + edge[:1]):
            side = (a, a + count, b + count, b)
            faces.append(side if orientation > 0 else tuple(reversed(side)))
        obj = h.mesh(name, vertices, faces, m[key], 'bedding', tile=tile(key, 0.75))
        # Cloth is a continuous sheet, not per-face box projection: preserve yarn
        # direction and scale across folds and the vertical hanging skirt.
        uv = obj.data.uv_layers['UV0']
        for loop in obj.data.loops:
            index = loop.vertex_index % count
            uv.data[loop.index].uv = ((index % (nx+1))/nx*uv_span[0]/tile(key),
                                      (index // (nx+1))/ny*uv_span[1]/tile(key))
        for face in obj.data.polygons:
            face.use_smooth = True
        return obj, [top[i] for i in edge]

    # Interior faces define exactly the declared room bounds. Wall thickness is outside.
    box('shell.floor.substrate', (0, -0.2, -0.08), (6.4, 5.8, 0.12), 'floorwood', 'floor')
    # Staggered real plank joints; grain follows the long local Y axis.
    for row in range(23):
        x0, x1 = -3.2 + row * (6.4 / 23), -3.2 + (row + 1) * (6.4 / 23)
        cuts = [-3.1] + [v for v in (-3.1 + (row % 3) * 0.49 + k * 1.47 for k in range(5))
                         if -3.095 < v < 2.695] + [2.7]
        for index, (a, b) in enumerate(zip(cuts, cuts[1:])):
            board = box(f'floor.plank.{row:02d}.{index}', ((x0+x1)/2, (a+b)/2, -0.01),
                        (x1-x0-0.0015, b-a-0.0015, 0.02), 'floorwood', 'floor', 0.0007)
            # One cropped real board (without photographed joints) spans each
            # editable plank; grain runs along Y, never stretched across the room.
            for loop in board.data.loops:
                point = board.data.vertices[loop.vertex_index].co
                # Texture is 5 stacked board strips (per-plank tone jitter); v stays inside one strip.
                strip = (row*2 + index*3) % 5
                board.data.uv_layers['UV0'].data[loop.index].uv = (
                    point.y/1.47 + row*.371 + index*.623,
                    (strip + .03 + .94*(.5 + point.x/(x1-x0)))/5)
    box('shell.back', (0, 2.79, 1.45), (6.58, 0.18, 2.9), 'plaster', 'walls')
    box('shell.left', (-3.29, -0.2, 1.45), (0.18, 5.8, 2.9), 'plaster', 'walls')
    box('shell.front.hidden', (0, -3.19, 1.45), (6.58, 0.18, 2.9), 'plaster', 'walls')
    box('shell.ceiling', (0, -0.2, 2.98), (6.58, 5.98, 0.16), 'plaster', 'ceiling')
    box('wall.central.feature', (-0.05, 2.46, 1.45), (3.65, 0.48, 2.9), 'plaster', 'walls', 0.006)
    box('wall.central.skirt', (-0.05, 2.206, 0.055), (3.65, 0.028, 0.11), 'plaster', 'walls', 0.002)
    for y, length in ((-2.15, 1.90), (2.51, 0.38)):
        box(f'window.wall.return.{y}', (3.29, y, 1.45), (0.18, length, 2.9), 'plaster', 'walls')
    box('window.wall.header', (3.29, 0.55, 2.82), (0.18, 3.54, 0.16), 'plaster', 'walls')
    box('window.wall.threshold', (3.29, 0.55, 0.035), (0.18, 3.54, 0.07), 'stone', 'windows')

    # Full-height joinery, both its observed back recess and the near left return.
    box('wardrobe.back.carcass', (-2.52, 2.545, 1.43), (1.32, 0.31, 2.86), 'walnutdark', 'wardrobe', 0.005)
    # Reference back wardrobe: 2 tall doors (door w/h 0.224 -> ~0.58 m) in a ~1.17 m recess.
    for i in range(2):
        x = -2.74 + i * 0.58
        box(f'wardrobe.back.door.{i}', (x, 2.373, 1.47), (0.578, 0.035, 2.80), 'walnutdark', 'wardrobe', 0.002)
        # Flush finger-pull slit beside the centre seam (ref: thin dark vertical grooves, no handles).
        box(f'wardrobe.back.handle.{i}', (x+(0.275 if i == 0 else -0.275), 2.3545, 0.78), (0.006, 0.004, 0.95),
            'metaldark', 'wardrobe')
    box('wardrobe.left.carcass', (-2.94, -0.38, 1.43), (0.52, 4.66, 2.86), 'walnutwarm', 'wardrobe', 0.004)
    for i in range(7):
        y = -2.37 + i * 0.66
        box(f'wardrobe.left.door.{i}', (-2.662, y, 1.47), (0.035, 0.653, 2.80), 'walnutwarm', 'wardrobe', 0.002)
        # Flush finger-pull slit in the lower door half (ref: thin dark grooves, z .08-1.22, no handles).
        box(f'wardrobe.left.handle.{i}', (-2.6445, y-0.30, 0.65), (0.004, 0.006, 1.14), 'metaldark', 'wardrobe')

    # Frame: foot rail flush with the legs (outer width 2.07, ref 2.03-2.08), 2.15 long
    # (ref visible rail 1.92-2.02 + <=0.2 hidden). Frame top .34, mattress .24 thick (top .58;
    # with duvet loft the foot-corner top is ~.61, ref .59-.63).
    # The head of the bed runs tight against the upholstered headboard front face (hb_front: flush with
    # the nightstand backs 1.94 + 5 mm). The foot end (y -0.29, legs, rail, duvet foot) is unchanged,
    # so the source-camera landmarks do not move; only the head end of frame and mattress is longer.
    hb_front = 1.95
    frame_back = hb_front-0.005
    box('bed.frame.deck', (0, (-0.29+frame_back)/2, 0.30), (2.03, frame_back+0.29, 0.08), 'walnut', 'bed', 0.016)
    for x in (-1.005, 1.005):
        # Rails start 1 cm behind the foot-beam front face and the deck/beam ends sit inside the rail
        # volume: no coplanar faces (they z-fought into a black stripe on the rail face).
        box(f'bed.frame.side.{x}', (x, (-0.3175+frame_back)/2, 0.28), (0.06, frame_back+0.3175, 0.19), 'walnut', 'bed', 0.012)
    box('bed.frame.foot', (0, -0.29, 0.28), (2.05, 0.075, 0.19), 'walnut', 'bed', 0.012)
    # Rounded corner posts (ref rug/throw crops: a rounded post stands slightly proud of the rails and
    # tapers into the leg). Post cap 7 mm above the rail top, outer faces 5 mm proud of the rails.
    for x in (-1.0, 1.0):
        for y in (-0.29, 1.9):      # rear posts sit under the frame head end (rail back 1.945)
            rings = ((0.0, 0.022), (0.185, 0.033), (0.382, 0.040))
            vertices = [(x+sx*w, y+sy*w, z) for z, w in rings for sx, sy in ((-1,-1),(1,-1),(1,1),(-1,1))]
            faces = [(3,2,1,0), (8,9,10,11)]
            for r in range(len(rings)-1):
                for k in range(4):
                    faces.append((4*r+k, 4*r+(k+1) % 4, 4*(r+1)+(k+1) % 4, 4*(r+1)+k))
            post = bmesh.new()
            pv = [post.verts.new(p) for p in vertices]
            for f in faces:
                post.faces.new([pv[i] for i in f])
            bmesh.ops.recalc_face_normals(post, faces=post.faces[:])
            bmesh.ops.bevel(post, geom=post.edges[:], offset=.007, offset_type='OFFSET', segments=3, affect='EDGES')
            post.verts.index_update()
            post_vertices = [tuple(v.co) for v in post.verts]
            post_faces = [[v.index for v in f.verts] for f in post.faces]
            post.free()
            h.mesh(f'bed.leg.{x}.{y}', post_vertices, post_faces, m['walnut'], 'bed', tile=tile('walnut'))
    mattress_foot = -0.2
    mattress_back = hb_front-0.003
    soft('bed.mattress.king', (0, (mattress_foot+mattress_back)/2, 0.46), (1.96, mattress_back-mattress_foot, 0.24), 'sheet', 'bed',
         exponent=10, seams=True, resolution=18)
    # Headboard: top 1.18 (ref 1.12-1.19), right wing .48 (ref wing/centre .20 vs ours .26).
    for name, x, width in (('left',-1.26,0.60), ('center',0,1.90), ('right',1.19,0.48)):
        soft('headboard.'+name, (x, hb_front+0.065, 0.625), (width, 0.13, 1.11), 'petrol', 'headboard',
             exponent=16, seams=False, resolution=24)

    def sstep(a, b, x):
        s = min(1.0, max(0.0, (x-a)/(b-a)))
        return s*s*(3-2*s)

    # Duvet (ref crops): soft ivory linen, a few broad irregular folds, clusters of diagonal pressure
    # wrinkles and fine random crumples on top, a turned-back band at the head, a smooth short side drop
    # that ends just at the frame top (no periodic pleats), a soft-gathered foot corner and a rolled-in
    # left edge near the head that shows the fitted sheet. The top-surface height field is built once on a
    # 4 mm numpy grid, every cloth_volume sample is then a bilinear lookup. Lattice is unchanged (256 x 224).
    drng = np.random.default_rng(20241019)
    DG = .004
    dgx = np.arange(-1.36, 1.36+DG/2, DG)
    dgy = np.arange(-.60, 1.51+DG/2, DG)
    DX, DY = np.meshgrid(dgx, dgy)
    top_weight = np.exp(-6*(np.maximum(np.abs(DX)-.98, 0)+np.maximum(-.17-DY, 0)))
    dfield = np.zeros_like(DX)

    def ridge(cx, cy, ang, length, width, amp):
        ca, sa = math.cos(ang), math.sin(ang)
        r = max(length*1.9, width*4.5)
        i0, i1 = max(0, int((cx-r+1.36)/DG)), min(len(dgx), int((cx+r+1.36)/DG)+2)
        j0, j1 = max(0, int((cy-r+.60)/DG)), min(len(dgy), int((cy+r+.60)/DG)+2)
        px, py = DX[j0:j1, i0:i1]-cx, DY[j0:j1, i0:i1]-cy
        q = (-px*sa+py*ca)/width
        dfield[j0:j1, i0:i1] += amp*(1-q*q)*np.exp(-q*q/2-((px*ca+py*sa)/length)**2)

    for _ in range(10):      # broad soft folds
        ridge(drng.uniform(-.75, .75), drng.uniform(.05, 1.2),
              math.radians(drng.uniform(15, 75)*drng.choice((-1, 1))),
              drng.uniform(.45, .9), drng.uniform(.055, .10), drng.uniform(.008, .016)*drng.choice((-1, 1)))
    for cx, cy, a0 in ((-.30, .12, 28), (.34, .72, 52), (-.45, .95, -35), (.55, .10, -25)):
        for _ in range(9):   # diagonal pressure-wrinkle clusters
            ridge(cx+drng.normal(0, .12), cy+drng.normal(0, .10), math.radians(a0+drng.normal(0, 11)),
                  drng.uniform(.08, .20), drng.uniform(.013, .022), drng.uniform(.0035, .0075))
    for _ in range(110):     # fine random crumples
        ridge(drng.uniform(-.95, .95), drng.uniform(-.14, 1.40), drng.uniform(0, math.pi),
              drng.uniform(.035, .10), drng.uniform(.009, .015), drng.uniform(.0014, .0034)*drng.choice((-1, 1)))
    for k in range(7):       # fold line of the turned-back head band
        ridge(-.9+k*.30+drng.normal(0, .03), 1.30+.012*math.sin(k*2.1), math.radians(drng.normal(0, 5)),
              .2, .017, -.006)
    dfield *= top_weight

    def dfield_at(rx, ry):
        fx, fy = (rx+1.36)/DG, (ry+.60)/DG
        i, j = min(max(int(fx), 0), len(dgx)-2), min(max(int(fy), 0), len(dgy)-2)
        tx, ty = fx-i, fy-j
        return float((dfield[j, i]*(1-tx)+dfield[j, i+1]*tx)*(1-ty)+(dfield[j+1, i]*(1-tx)+dfield[j+1, i+1]*tx)*ty)

    def wave_set(seed):
        r = np.random.default_rng(seed)
        ws = [(math.tau/r.uniform(.14, .70), r.uniform(0, math.tau), r.uniform(.4, 1.0)) for _ in range(6)]
        return ws, sum(a for _, _, a in ws)

    side_waves = {1: wave_set(11), -1: wave_set(12)}
    foot_waves = wave_set(13)

    def wave(ws, s):
        return sum(a*math.sin(k*s+ph) for k, ph, a in ws[0])/ws[1]

    def duvet(u, v):
        raw_x, raw_y = (u*2-1)*1.36, -0.60 + v*2.11
        side = 1 if raw_x >= 0 else -1
        a = abs(raw_x)
        reveal = .20*sstep(.80, 1.30, raw_y) if side < 0 else .03*sstep(.90, 1.35, raw_y)
        hw = .98-reveal
        rolled = min(1.0, reveal/.06)
        dx, dy = max(a-.98, 0), max(-.17-raw_y, 0)
        # Side skirt hangs 3.5 cm outside the mattress, inside the rail face (x 1.035).
        x = side*(min(a, .98)*hw/.98 + .035*(1-math.exp(-dx/.055)))
        y = raw_y if dy == 0 else -.17-.075*(1-math.exp(-dy/.055))
        drop = (dx**4+dy**4)**.25            # rounded foot corners instead of a mitred roof ridge
        z = .615 - drop*.60*(1-rolled) + rolled*.026*(1-math.exp(-dx/.04))
        z += .025*math.exp(-((raw_x+.10)/.85)**2-((raw_y-.65)/.75)**2)
        z += dfield_at(raw_x, raw_y)
        # Turned-back band at the head: ramp onto the band, rolled free edge.
        band = .030*sstep(1.25, 1.36, raw_y)*(1-.75*sstep(1.44, 1.51, raw_y))+.010*math.exp(-((raw_y-1.455)/.025)**2)
        z += band*math.exp(-8*dx)*(1-.6*rolled)
        if reveal > 0:                       # rolled-in flap along the left edge near the head
            z += .04*reveal*math.exp(-((raw_x+.88)/.07)**2)*sstep(.85, 1.25, raw_y)
        if dx > 0:                           # soft irregular vertical folds on the side drop
            x += side*sstep(0, .14, dx)*.014*wave(side_waves[side], raw_y)
        if dy > 0:                           # and on the foot drop
            y -= sstep(0, .14, dy)*.014*wave(foot_waves, raw_x)
        if dx > 0 and dy > 0:                # gathered foot corner
            theta = math.atan2(dy, dx)
            g = sstep(0, .07, min(dx, dy))*(.013*math.sin(theta*7.0+1.1)+.008*math.sin(theta*13.0+.4))
            x += side*g*math.cos(theta)
            y -= g*math.sin(theta)
        return x, y, z
    _, duvet_edge = cloth_volume('bedding.duvet.closed', 256, 224, duvet, 'linen', 0.018, (2.72, 2.11))
    tube('bedding.duvet.sewn-edge', duvet_edge, 0.0015, 'linen', 'bedding', cyclic=True)
    def crumple(obj, size, seed, lift=1.0):
        """Plump linen pillow: corner puff, diagonal corner wrinkles, soft folds, fine crumples.
        Displacement is along the thickness axis and fades to zero at the seam ring (z = 0)."""
        rng = np.random.default_rng(seed)
        count = len(obj.data.vertices)
        co = np.empty(count*3, np.float32)
        obj.data.vertices.foreach_get('co', co)
        co = co.reshape(-1, 3).astype(np.float64)
        hx, hy, hz = size[0]/2, size[1]/2, size[2]/2
        X, Y, Z = co[:, 0]/hx, co[:, 1]/hy, co[:, 2]/hz
        weight = np.clip(np.abs(Z)/.55, 0, 1)**1.3*np.clip(1-np.maximum(np.abs(X), np.abs(Y))**8, 0, 1)
        faces_field = {}
        for face in (1, -1):
            f = np.zeros(count)
            gain = 1.0 if face > 0 else .35

            def add(cx, cy, ang, length, width, amp):
                px, py = co[:, 0]-cx, co[:, 1]-cy
                ca, sa = math.cos(ang), math.sin(ang)
                q = (-px*sa+py*ca)/width
                f[:] += gain*lift*amp*(1-q*q)*np.exp(-q*q/2-((px*ca+py*sa)/length)**2)
            for sx in (-1, 1):
                for sy in (-1, 1):
                    for _ in range(2):    # diagonal corner wrinkles pointing at the centre
                        cx, cy = sx*hx*(.70+.12*rng.random()), sy*hy*(.68+.12*rng.random())
                        add(cx, cy, math.atan2(-sy*hy, -sx*hx)+rng.normal(0, .28),
                            rng.uniform(.10, .16), rng.uniform(.013, .019), rng.uniform(.006, .010))
                    f[:] += gain*lift*.011*np.exp(-((np.abs(X)-.88)/.16)**2-((np.abs(Y)-.86)/.18)**2)*(sx*X > 0)*(sy*Y > 0)
            for _ in range(3):            # long soft diagonal folds
                add(rng.uniform(-.4, .4)*hx, rng.uniform(-.4, .4)*hy, math.radians(rng.uniform(25, 55)*rng.choice((-1, 1))),
                    .20, .03, rng.uniform(.006, .011))
            for _ in range(2):            # broad lumps
                add(rng.uniform(-.5, .5)*hx, rng.uniform(-.5, .5)*hy, rng.uniform(0, math.pi), .15, .08,
                    rng.uniform(.005, .009)*rng.choice((-1, 1)))
            for _ in range(22):           # fine crumples
                add(rng.uniform(-.8, .8)*hx, rng.uniform(-.8, .8)*hy, rng.uniform(0, math.pi),
                    rng.uniform(.03, .06), rng.uniform(.008, .012), rng.uniform(.0012, .0025)*rng.choice((-1, 1)))
            faces_field[face] = f
        for face in (1, -1):
            mask = np.sign(co[:, 2]) == face
            co[mask, 2] += face*(faces_field[face]*weight)[mask]
        obj.data.vertices.foreach_set('co', co.astype(np.float32).ravel())
        obj.data.update()

    # Rear pillows (back edge 0.5-1 mm off the headboard front face, hb_front 1.95) lean on the headboard;
    # front pillows lean on the rear pillows (2 mm gap, no BVH overlap). Centre y measured on the drafted
    # master with gapfix-r01/measure.py and contact_search.py.
    pillow_y = {'rear': (1.785, 1.785), 'front': (1.5105, 1.5055)}
    for i, (rear_x, front_x) in enumerate(((-0.36, -0.38), (0.36, 0.38))):
        rear = soft(f'pillow.ivory.rear.{i}', (rear_x, pillow_y['rear'][i], 0.765), (0.70, 0.60, 0.22), 'linenrear', 'bedding',
                    rotation=(math.radians(66), 0, math.radians((-1 if i else 1)*3)),
                    loose=True, seams=True, phase=1.7+i, resolution=48)
        crumple(rear, (0.70, 0.60, 0.22), 100+i)
        front = soft(f'pillow.grey.front.{i}', (front_x+0.03, pillow_y['front'][i], 0.728), (0.74, 0.52, 0.23), 'pillow', 'bedding',
                     rotation=(math.radians(58), 0, math.radians(4 if i else -5)),
                     loose=True, seams=True, phase=3.1+i, resolution=48)
        crumple(front, (0.74, 0.52, 0.23), 200+i)

    # Charcoal knit throw (ref crops): a gathered top fold lying on the mattress with a diagonal free end,
    # three-four broad soft rounded gathers over the foot edge, slightly twisted, the hem hanging just
    # above the rug and ending in separate fringe clumps that splay onto it. Flat cloth 0.74 m wide
    # (UV0 lattice metres == flat cloth metres): every cross section is an arc-length-exact gathered
    # profile, so the knit is never stretched; chord .65 on the mattress -> .55 over the rail
    # (three broad soft gathers ~8 cm peak-to-valley plus small folds; ref: 3-4 large + 8-10 small).
    throw_w = 0.74

    def make_path(points, radii):
        """Filleted (y, z) polyline -> list of primitives; the last line extends past its end."""
        prims, cursor = [], points[0]
        for i in range(1, len(points)-1):
            p, q, r = points[i-1], points[i], points[i+1]
            d_in = (q[0]-p[0], q[1]-p[1])
            d_out = (r[0]-q[0], r[1]-q[1])
            n_in, n_out = math.hypot(*d_in), math.hypot(*d_out)
            d_in, d_out = (d_in[0]/n_in, d_in[1]/n_in), (d_out[0]/n_out, d_out[1]/n_out)
            cross = d_in[0]*d_out[1]-d_in[1]*d_out[0]
            turn = math.acos(max(-1.0, min(1.0, d_in[0]*d_out[0]+d_in[1]*d_out[1])))
            side = 1 if cross > 0 else -1
            tangent_len = radii[i]*math.tan(turn/2)
            a = (q[0]-d_in[0]*tangent_len, q[1]-d_in[1]*tangent_len)
            centre = (a[0]-side*d_in[1]*radii[i], a[1]+side*d_in[0]*radii[i])
            prims.append(('line', cursor, a, math.dist(cursor, a)))
            prims.append(('arc', centre, radii[i], math.atan2(a[1]-centre[1], a[0]-centre[0]),
                          side*turn, radii[i]*turn))
            cursor = (q[0]+d_out[0]*tangent_len, q[1]+d_out[1]*tangent_len)
        prims.append(('line', cursor, points[-1], math.dist(cursor, points[-1])))
        return prims

    # y, z waypoints. The path starts/ends .15 m outside the cloth (travel offset .15) so skewed free
    # end and hem never clamp: free end avg y .135, hem avg z .095 (hangs just above the rug; the
    # hem is sheared +-.075 so its left end hangs higher and its right end lies on the rug).
    throw_off = .15
    throw_prims = make_path([(0.285, 0.648), (-0.265, 0.648), (-0.265, 0.398), (-0.35, 0.398),
                             (-0.35, -0.055)], [0, .06, .04, .04, 0])
    throw_l = sum(prim[-1] for prim in throw_prims)-2*throw_off      # cloth length (flat metres)
    t_hang = sum(prim[-1] for prim in throw_prims[:6])-throw_off     # start of the rail-face drop

    def throw_path(t):
        """Centreline y, z and outward normal (ny, nz) at path travel t."""
        t = max(0.0, t)
        for prim in throw_prims:
            if t <= prim[-1] or prim is throw_prims[-1]:
                if prim[0] == 'line':
                    _, a, b, length = prim
                    d = ((b[0]-a[0])/length, (b[1]-a[1])/length)
                    y, z = a[0]+d[0]*t, a[1]+d[1]*t
                else:
                    _, centre, radius, start, sweep, length = prim
                    angle = start+sweep*t/length
                    y, z = centre[0]+radius*math.cos(angle), centre[1]+radius*math.sin(angle)
                    sign = 1 if sweep > 0 else -1
                    d = (-sign*math.sin(angle), sign*math.cos(angle))
                return y, z, d[1], -d[0]
            t -= prim[-1]

    throw_rows = {}

    def throw_row(v):
        key = round(v, 6)
        if key in throw_rows:
            return throw_rows[key]
        t = throw_l*v
        gather = .50*sstep(.0, .20, t)+.50*sstep(.20, t_hang+.05, t)
        t_step = sum(prim[-1] for prim in throw_prims[:4])+throw_prims[4][-1]/2-throw_off
        chord = (throw_w-(throw_w-.55)*gather+.11*sstep(t_hang+.02, throw_l, t)
                 +.06*math.exp(-((t-t_step)/.09)**2))   # folds relax (wider chord) toward the hem; flatter over the rail
        centre = .40-.30*sstep(.10, t_hang, t)
        sigma = np.linspace(-.5, .5, 1025)
        shape = np.zeros_like(sigma)
        decay = 1-.45*sstep(t_hang*.5, throw_l, t)       # amplitude tapers with hang distance
        # (centre, sigma-width, height, diagonal drift): 3 broad gathers of different width/depth, one
        # narrow diagonal tuck on the left and one low one on the right, smooth cloth between (ref).
        for k, (p0, w0, h0, drift) in enumerate(((-.29, .085, .75, .16), (.01, .150, 1.0, .09),
                                                 (.30, .105, .55, -.12), (-.10, .035, .40, .30),
                                                 (.19, .040, .28, -.22))):
            p = p0+.035*math.sin(2.3*v+k*1.7)+drift*(v-.3)
            w = w0*(1+.18*math.sin(3.1*v+k*2.3))
            shape += h0*(1+.20*math.sin(3.3*v+k))*np.exp(-((sigma-p)/w)**2)*(decay if k < 3 else 1.0)
        shape /= shape.max()
        shape *= 1-.8*(2*np.abs(sigma))**8   # flat selvages: no dog-eared flaps
        lateral = sigma*chord

        def arc(amplitude):
            return float(np.hypot(np.diff(lateral), np.diff(amplitude*shape)).sum())
        lo, hi = 0.0, 0.40
        for _ in range(48):
            mid = (lo+hi)/2
            lo, hi = (mid, hi) if arc(mid) < throw_w else (lo, mid)
        depth = (lo+hi)/2*shape
        along = np.concatenate(([0.0], np.cumsum(np.hypot(np.diff(lateral), np.diff(depth)))))
        if abs(along[-1]-throw_w) > 2e-3:
            raise ValueError(f'Throw gather cannot absorb the flat width at v={v}: arc {along[-1]:.4f}')
        # Slight twist of the hanging section (isometry, arc lengths unchanged).
        phi = .22*math.sin(2.1*v+.6)*sstep(.35, .6, v)
        lat2 = lateral*math.cos(phi)-depth*math.sin(phi)
        dep2 = lateral*math.sin(phi)+depth*math.cos(phi)
        dep2 = dep2-dep2.min()
        throw_rows[key] = (centre, lat2, dep2, along)
        return throw_rows[key]

    def throw(u, v):
        centre, lat2, dep2, along = throw_row(v)
        arc_pos = u*throw_w
        x = centre+float(np.interp(arc_pos, along, lat2))
        fold = float(np.interp(arc_pos, along, dep2))
        # Diagonal, ragged free end on the mattress; the hem is sheared so the right side reaches lower
        # and the fold lines run diagonally (ref).
        skew = ((.12*(u-.5)+.05*math.sin(5.1*u+.8)+.025*math.sin(13.0*u))*(1-sstep(0, .22, v))
                +.15*(u-.5)*sstep(.30, 1.0, v))
        y, z, ny, nz = throw_path(throw_off+throw_l*v+skew)
        y += fold*ny
        z = max(.024, z+fold*nz)
        # Seat the closed throw above the sampled duvet, including its underside.
        if y > -0.18:
            support = duvet((x/1.36+1)/2,(y+.60)/2.11)[2]
            z = max(z, support+.018)
        return x, y, z
    # The cloth is isometric along v only if the lattice rows are equally spaced in 3-D arc length: the
    # fold offset along the path normal stretches the rounded rail corners (up to 3x), which showed up as
    # elongated stitch rings. Every lattice column is resampled by arc length of the raw surface, so the
    # UV0 v-parameter (grid index / ny) equals flat-cloth distance up to the per-column length ratio.
    throw_nx, throw_ny, throw_steps = 128, 132, 800
    throw_vs = np.linspace(0.0, 1.0, throw_steps+1)
    throw_cols = []
    for ci in range(throw_nx+1):
        pts = np.array([throw(ci/throw_nx, float(v)) for v in throw_vs])
        cum = np.concatenate(([0.0], np.cumsum(np.linalg.norm(np.diff(pts, axis=0), axis=1))))
        throw_cols.append((pts, cum))
    throw_len = float(np.mean([cum[-1] for _, cum in throw_cols]))

    def throw_even(u, v):
        pts, cum = throw_cols[int(round(u*throw_nx))]
        s = v*cum[-1]
        return tuple(float(np.interp(s, cum, pts[:, k])) for k in range(3))
    throw_cloth, throw_edge = cloth_volume('bedding.throw.knitted-drape', throw_nx, throw_ny, throw_even, 'throw', 0.004,
                                           (throw_w, throw_len))
    throw_bound = tube('bedding.throw.bound-edge', throw_edge, 0.0014, 'throw', 'bedding', cyclic=True)
    # The throw is dragged by runtime cloth physics: its contact occlusion must never be baked onto
    # the duvet/mattress/frame lightmaps (stage_bake bakes receivers with occluders hidden).
    throw_cloth['bake_occluder'] = throw_bound['bake_occluder'] = True

    def ring_tube(points, radius, sides, verts, faces):
        first, count = len(verts), len(points)
        for i, p in enumerate(points):
            tangent = (points[min(i+1, count-1)]-points[max(i-1, 0)]).normalized()
            ref = Vector((1, 0, 0)) if abs(tangent.x) < .9 else Vector((0, 1, 0))
            n1 = (ref-tangent*ref.dot(tangent)).normalized()
            n2 = tangent.cross(n1)
            for k in range(sides):
                a = k*math.tau/sides
                verts.append(tuple(p+(n1*math.cos(a)+n2*math.sin(a))*radius))
        for i in range(count-1):
            for k in range(sides):
                a = first+i*sides+k
                b = first+i*sides+(k+1) % sides
                faces.append((a, b, b+sides, a+sides))
        faces.append(tuple(first+k for k in reversed(range(sides))))
        faces.append(tuple(first+(count-1)*sides+k for k in range(sides)))

    # Fringe: 14 separate clumps x 8 strands, 6-8 cm, strand diameter 3 mm. Each strand hangs from the hem
    # with its own random splay/sway and lies on the rug once it reaches it (ref: clumps every ~4 cm,
    # 6-10 ends each, splaying onto the rug). One mesh per clump.
    frng = np.random.default_rng(31)
    clumps, strands = 14, 12
    for index in range(clumps):
        u = (index+.5)/clumps
        base = Vector(throw(u, 1.0))+Vector((0, 0, .005))
        clump_len = .078*(.85+.30*frng.random())      # 6.6-9.0 cm clump length (ref ~7-8 cm, dense)
        verts, faces = [], []
        for j in range(strands):
            length = clump_len*(.86+.28*frng.random())
            sx, sy = (frng.random()-.5)*.012, (frng.random()-.5)*.004
            splay_x, splay_y = (frng.random()-.5)*.05, -(.008+.032*frng.random())
            ph = frng.random()*math.tau
            points = []
            for step in range(10):
                s = step/9
                p = base+Vector((sx+splay_x*s**1.4+.0035*math.sin(ph+7*s)*s,
                                 sy+splay_y*s**1.5+.0025*math.cos(1.3*ph+6*s)*s, -length*s))
                p.z = max(p.z, .0158)
                points.append(p)
            ring_tube(points, .0015, 6, verts, faces)
        clump = h.mesh(f'bedding.throw.fringe.{index:02d}', verts, faces, m['throw'], 'bedding',
                       tile=tile('throw'))
        clump['bake_detail'] = clump['bake_occluder'] = True
        mesh_bm = bmesh.new()
        mesh_bm.from_mesh(clump.data)
        bmesh.ops.recalc_face_normals(mesh_bm, faces=mesh_bm.faces)
        mesh_bm.to_mesh(clump.data)
        mesh_bm.free()
        for face in clump.data.polygons:
            face.use_smooth = True
    # Rug: ref depth y -0.83..1.49 (2.32 m, ours was 3.25 with the front edge .63 m too near the foot).
    box('rug.low-pile', (0.08, 0.33, 0.006), (3.34, 2.32, 0.012), 'rug', 'rug', 0.005)
    rug_edge = [(-1.582,-0.83,.009),(1.742,-0.83,.009),
                (1.742,1.49,.009),(-1.582,1.49,.009)]
    tube('rug.bound-fabric-edge', rug_edge, .002, 'rug', 'rug', cyclic=True)

    bulb_material = h.material('Bedroom.PendantBulb', (1,.66,.32), roughness=.55)
    bulb_shader = next(node for node in bulb_material.node_tree.nodes if node.type == 'BSDF_PRINCIPLED')
    bulb_shader.inputs['Emission Color'].default_value = (1,.43,.12,1)
    bulb_shader.inputs['Emission Strength'].default_value = 2

    for side, x in (('left',-1.39),('right',1.39)):
        # Camera-fit (render camera): top z .62 (was .678), bottom .30 (was .33), width .56 (was .64; ref .54 at y 1.455).
        box(f'nightstand.{side}.body', (x, 1.70, 0.446), (0.56, 0.48, 0.292), 'walnut', 'nightstands', 0.006)
        box(f'nightstand.{side}.drawer', (x, 1.452, 0.446), (0.542, 0.018, 0.252), 'walnut', 'nightstands', 0.002)
        box(f'nightstand.{side}.travertine', (x, 1.69, 0.606), (0.59, 0.51, 0.028), 'stone', 'nightstands', 0.004)
        tube(f'pendant.{side}.cable', [(x,1.68,2.88),(x,1.68,1.64)], 0.0022, 'metaldark', 'pendants')
        box(f'pendant.{side}.canopy', (x,1.68,2.889), (0.10,0.10,0.026), 'metaldark', 'pendants', 0.012)
        profile = [(0,0),(0.015,0),(0.016,.12),(.026,.18),(.049,.245),(.038,.30),
                   (.022,.35),(.012,.44),(.010,.63),(0,.63)]
        body = h.lathe(f'pendant.{side}.sculpted-shell', profile, m['metaldark'], 'pendants',
                       (x,1.68,1.02), segments=32)
        h.project_uv(body, metres=tile('metaldark'))
        bulb = h.lathe(f'pendant.{side}.bulb', [(0,0),(.013,0),(.013,.006),(0,.006)],
                       bulb_material, 'pendants', (x,1.68,1.014), segments=24)
        bulb['runtime_switchable'], bulb['pendant_id'] = True, side
        # Pool aim/cone/power fitted on the linear light-group model (ns_top dE00 46.8 -> ~10, wing_L 23.4 -> ~7):
        # 8.5 W, 150 deg soft cone (blend 1) aimed near-vertically so nightstand top AND wing get a warm pool.
        lamp = h.light(f'pendant.{side}.warm-downlight', 'SPOT', (x,1.68,1.012), (x,1.83,.112),
                       8.5, (1.0,0.67,0.36))
        lamp.data.spot_size, lamp.data.spot_blend = math.radians(150), 1.0
        lamp.data.shadow_soft_size = .012
        lamp['runtime_switchable'], lamp['pendant_id'] = True, side
        lamp['runtime_intensity'] = 2.4   # keeps the previous runtime/native ratio 1.4/5 W
    for i in range(2):
        box(f'nightstand.book.{i}.pages', (1.41,1.65,.639+i*.026), (.27,.18,.023), 'linen', 'decor', .002)
        box(f'nightstand.book.{i}.cover', (1.41,1.65,.653+i*.026), (.28,.19,.004), 'art', 'decor', .001)

    # Right niche dresser: ref h .71-.75 (ours was .97), 2 drawer rows, dark walnut (63,39,25).
    # Width is limited to the niche: left end clears the feature wall (x 1.775), right end the rear
    # curtain stack (x 2.85); the ref's 1.3 m would need a wall edge of 1.50, which contradicts the
    # camera-fit wall-edge landmark (render px 700 vs ref 739), so the 1.03 m niche width is kept.
    dresser_x0, dresser_x1 = 1.80, 2.83
    dcx, dw = (dresser_x0+dresser_x1)/2, dresser_x1-dresser_x0
    box('dresser.carcass', (dcx,2.36,.3825), (dw-.04,.61,.645), 'walnutdark', 'dresser', .006)
    box('dresser.plinth', (dcx,2.40,.03), (dw-.15,.48,.06), 'walnutdark', 'dresser', .003)
    for i in range(2):
        box(f'dresser.drawer.{i}', (dcx,2.043,.235+i*.31), (dw-.07,.025,.29), 'walnutdark', 'dresser', .003)
    box('dresser.top', (dcx,2.35,.7225), (dw,.64,.035), 'walnutdark', 'dresser', .006)
    box('art.backing', (2.32,2.654,1.79), (.68,.025,.88), 'art', 'art', .002)
    for x in (1.963,2.677):
        box(f'art.frame.vertical.{x}', (x,2.63,1.79), (.026,.04,.93), 'walnut', 'art', .002)
    for z in (1.338,2.242):
        box(f'art.frame.horizontal.{z}', (2.32,2.63,z), (.74,.04,.026), 'walnut', 'art', .002)
    box('art.abstract.dark-band', (2.21,2.636,1.72), (.43,.009,.14), 'throw', 'art')
    box('art.abstract.pale-block', (2.45,2.628,1.97), (.18,.013,.36), 'stone', 'art')
    box('art.abstract.fine-line', (2.49,2.617,1.79), (.008,.008,.33), 'walnut', 'art')
    vase = h.lathe('decor.vase', [(0,0),(.06,0),(.085,.07),(.065,.13),(.029,.16),
                               (.028,.21),(.021,.21),(.020,.16),(.055,.11),(.064,.06),(0,.014)],
                   m['ceramic'], 'decor', (2.07,2.32,.741), segments=40)
    h.project_uv(vase, metres=tile('ceramic'))
    tube('decor.dry-stem', [(2.07,2.32,.886),(2.08,2.32,1.036),(2.01,2.31,1.126)], .002, 'walnut', 'decor')
    for i in range(3):
        soft(f'decor.leaf.{i}', (2.015+i*.018,2.31,1.086+i*.018), (.045,.018,.006), 'walnut', 'decor',
             seams=False, resolution=4, rotation=(0,.3,i*.5))

    # Actual framed aperture, clear panes, exterior balcony and abstracted distant city.
    for y in (-1.20,-.03,1.13,2.30):
        box(f'window.mullion.{y}', (3.205,y,1.42), (.14,.07,2.70), 'metal', 'windows', .003)
    for z in (.085,1.02,2.75):
        box(f'window.transom.{z}', (3.19,.55,z), (.095,3.55,.045), 'metal', 'windows', .003)
    for i,(a,b) in enumerate(zip((-1.20,-.03,1.13),(-.03,1.13,2.30))):
        pane = box(f'window.glass.{i}', (3.215,(a+b)/2,1.42), (.009,b-a-.07,2.62), 'glass', 'glazing')
        pane['transmission_approximation'] = 'Thin architectural glazing; shadow transmission set by material policy.'
    box('balcony.slab', (3.93,.55,-.10), (1.45,3.58,.20), 'stone', 'exterior')
    box('balcony.parapet', (4.62,.55,.48), (.10,3.58,.96), 'plaster', 'exterior', .008)
    tube('balcony.handrail', [(4.62,-1.24,1.02),(4.62,2.34,1.02)], .025, 'metal', 'exterior')
    for i in range(11):
        y = -10+i*2.0
        height = 2.3 + (i*7 % 5)*.71
        box(f'exterior.city.building.{i}', (12+(i%3)*1.8,y,height/2-1.2),
            (1.3+(i%2)*.5,1.4,height), 'exterior', 'exterior', .018)
        for level in range(2, int(height/.36)):
            box(f'exterior.city.band.{i}.{level}', (11.33+(i%3)*1.8-(i%2)*.25,y,level*.36-1.2),
                (.015,1.25,.035), 'glass', 'exterior')

    # Two independent full-height tracks. Signed rails point inward from either end.
    # Each pair closes the 3.5m aperture without out-of-bounds header endpoints.
    for layer, x, key, open_width in (('drape',2.91,'drape',.66), ('sheer',3.075,'sheer',1.05)):
        box(f'curtain.{layer}.ceiling-track', (x,.55,2.868), (.028,3.52,.028), 'metal', 'curtain-rails', .003)
        for mount_y in (-1.10, .55, 2.20):
            box(f'curtain.{layer}.ceiling-mount.{mount_y}', (x,mount_y,2.889),
                (.05,.07,.022), 'metal', 'curtain-rails', .002)
        for end,y,direction in (('front',-1.20,1),('rear',2.30,-1)):
            h.curtain(f'curtain.{layer}.{end}', (x,y,0), (0,direction,0), (-1,0,0),
                      open_width, 1.75, 2.80, m[key], panel_id=f'{layer}-{end}',
                      floor=.03, folds=3 if layer == 'drape' else 6, fabric_width=3.0, tile=tile(key,.65))

    world = bpy.data.worlds.new('Bedroom.DaylightSky')
    world.use_nodes = True
    # Daylight rig re-fitted jointly with the fill rig (window/sun/world scaled x0.72, colours trimmed
    # to a* +2 / b* -3 on neutrals); highlights unchanged (duvet p95 L* 89-92 vs ref 89).
    world.node_tree.nodes['Background'].inputs['Color'].default_value = (.688,.778,1.0,1)
    world.node_tree.nodes['Background'].inputs['Strength'].default_value = .268
    scene.world = world
    sky_spec = importlib.util.spec_from_file_location(
        'bedroom_workspace_background', context.workspace / 'build_background.py')
    sky_module = importlib.util.module_from_spec(sky_spec)
    sky_spec.loader.exec_module(sky_module)
    sky_module.apply_world(world)
    daylight = h.light('Daylight.WindowArea', 'AREA', (3.65,.55,2.2), (0,.9,.8), 321.5, (.839,.903,1.0))
    daylight.data.shape = 'RECTANGLE'
    daylight.data.size, daylight.data.size_y = 3.1, 2.3
    sun = h.light('Daylight.Sun', 'SUN', (9,-3,8), (0,1,0), 1.082, (1.0,.958,.891))
    sun.data.angle = math.radians(5)
    # Hidden soft fill rig: stands in for the bounce from the unseen camera-side room. Plain AREA lights
    # (not runtime_switchable, not SUN) so the ambient atlases bake them; invisible to camera/glossy rays.
    for name, position, target, size, watts in (
            ('Fill.FrontWall', (-0.4,-3.0,1.3), (0.2,1.2,0.8), (5.4,2.4), 34.4),
            ('Fill.CeilingDown', (0.2,0.6,2.78), (0.2,0.6,0.0), (4.2,3.6), 27.6),
            ('Fill.LeftWardrobe', (-0.9,-1.5,1.7), (-2.65,-0.8,1.2), (2.4,2.4), 34.2),
            ('Fill.LowFront', (-1.2,-2.6,0.35), (0.3,0.3,0.4), (3.0,0.8), 39.5),
            ('Fill.MidFront', (-1.0,-2.7,0.95), (0.0,1.6,0.8), (2.4,1.0), 19.5)):
        fill = h.light(name, 'AREA', position, target, watts, (.934,.934,1.0))
        fill.data.shape = 'RECTANGLE'
        fill.data.size, fill.data.size_y = size
        fill.visible_camera = False
        fill.visible_glossy = False
    # No exposure compensation; restrained highlights for the neutral runtime pipeline.
    scene.view_settings.view_transform = 'AgX'
    scene.view_settings.look = 'None'
    scene.view_settings.exposure = 0
    scene.view_settings.gamma = 1
    pose = context.spec['authoring']['cameraEstimate']
    data = bpy.data.cameras.new('Bedroom.SourceCamera')
    camera = bpy.data.objects.new('Bedroom.SourceCamera', data)
    scene.collection.objects.link(camera)
    camera.location = pose['position']
    camera.rotation_euler = (Vector(pose['target'])-camera.location).to_track_quat('-Z','Y').to_euler()
    data.lens, data.sensor_width = pose['lensMm'], pose['sensorWidthMm']
    data.sensor_fit = 'HORIZONTAL'
    data.clip_start, data.clip_end = .03, 150
    scene.camera = camera
    bpy.context.view_layer.update()
    components = {}
    for obj in scene.objects:
        if obj.type == 'MESH':
            components.setdefault(obj['component'], []).append(obj.name)
    summary = {'schemaVersion':1,
               'roomBounds':{'min':[-3.2,-3.1,0], 'max':[3.2,2.7,2.9]},
               'camera':pose, 'views':context.spec['authoring']['inspectionViews'],
               'components':components, 'assumptions':context.spec['assumptions'] + [
                   'Room bounds are actual interior shell faces, excluding exterior wall thickness and balcony/city.',
                   'Hidden front wall, cabinet interiors, bed underside and city are authored, not recovered.',
                   'Duvet and throw are closed geometric drapes; only helper curtain panels are runtime cloth.',
                   'Lighting powers and source camera require main-session visual calibration; no exposure lift.']}
    scene['interior_metadata'] = json.dumps(summary)
    return summary

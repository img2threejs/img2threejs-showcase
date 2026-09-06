/**
 * GENERATED — measured off the monster-tree export, not authored by hand.
 *
 * Every number here came out of one of three measurements, and the method that produced it is
 * written next to it. Nothing in this file is a guess or a hand-placed coordinate.
 *
 *   1. the decoded surface (64,307 vertices, 115,350 triangles) from `surfaceData.high.ts`
 *   2. the skin binding from `rigData.ts` (each vertex's dominant bone)
 *   3. the reference photograph `public/references/monster-tree.jpg`
 *
 * Positions are in RIG-LOCAL space — the same space the bind-pose vertices live in, before the
 * 1.9899x normalise scale. Anchor them through `sockets` on the built rig, never by hand.
 */

import type { SocketKind } from './rig';


/**
 * Colours sampled off the reference photograph, so the stage lighting and every effect are lit in
 * the character's own palette rather than a generic studio white.
 *
 * Bark / moss / leather: median of the pixels in that class over a 256px reduction of the
 * reference (bark = r>=g>=b and not backdrop-grey; moss = green-dominant; leather = r>g>b with
 * r-b>40). Eye: the green-dominant pixels of a 420x260 crop centred on the face, by percentile of
 * luminance — `eyeCore` is the p02 hot centre, `eyeIris` the p20 ring, `eyeDeep` the p60 body.
 */
export const PALETTE = {
  barkDark: '#231f12',
  barkMid: '#4b3e2b',
  barkLight: '#726a5c',
  mossDark: '#575a2b',
  mossMid: '#727369',
  mossLight: '#8b8c69',
  leatherDark: '#615736',
  leatherMid: '#766547',
  leatherLight: '#867b5b',
  eyeCore: '#d6faca',
  eyeIris: '#799d3d',
  eyeDeep: '#36581c',
  eyeRim: '#2f422f',
  /**
   * The reference's own studio backdrop — a NEUTRAL grey, median of its 54,227 near-neutral pixels
   * (max-min channel spread < 12). Shadow side #565a53, lit side #797d77; B-R is -2 across all of
   * them, i.e. genuinely achromatic.
   *
   * This is the ambient the photographed subject actually sits in, and it is the one measured
   * colour in the set with a blue channel. Every other entry here is warm or green, so a light rig
   * built only from the rest drives the render's blue to about 4/255 and the bark comes back lime
   * no matter how the greens are balanced — measured on the torso, not guessed at. Skylight is
   * what puts blue into wood in shade; this is that light, and it came out of the photograph.
   */
  studioAmbient: '#6b6f69',
} as const;

/**
 * The hue of the measured iris, in degrees. Every emissive channel in the demo is built by
 * `setHSL` off THIS number rather than an invented green, so the glow, the motes, the trails and
 * the ground rings are all the same hue as the character's eyes — only their saturation and
 * lightness differ, because an emissive channel has to out-run the albedo it sits on.
 */
export const LIFE_HUE = 82.5 / 360;
export const LIFE_SATURATION = 0.44;


/**
 * Per-channel gain that white-balances the mesh's baked albedo to the reference photograph.
 *
 * The generated GLB's texture is not the reference's bark. Measured over the 56,588 bark vertices
 * (costume excluded), the mesh's median albedo is #3d2d0e, whose blue is 9.4% of its red. The same
 * bark measured off the photograph is #4b3e2b, at 34.3%. **97% of bark vertices have a blue channel
 * under 55% of their red** — Tripo's bake took almost all the blue out of the wood.
 *
 * That is why the figure rendered lime no matter how the lights were balanced, and it is worth
 * being precise about how that was established rather than tuned away: the lit chest measured
 * rgb(72, 78, 7), and switching off the sap, the environment, every point light, the atmospherics,
 * the rim and the hemisphere in turn moved the blue channel by at most 7/255. Nothing in the
 * lighting was responsible. Neither were the cavity and moss tints, which were the next suspects
 * and were also measured and cleared. The albedo itself had no blue to light.
 *
 * These gains are the ratio of the two medians in LINEAR space, which is the space the decoder
 * already leaves vertex colours in. Applying them is a white balance to the reference, not a
 * stylistic grade — it is the step that makes the wood grey-brown wood instead of olive.
 */
export const ALBEDO_WHITE_BALANCE: readonly [number, number, number] = [1.508, 1.836, 5.501];

export interface MeasuredSocket {
  id: string;
  /** The bone this socket rides. A real bone name out of the rig, not a hypothesis. */
  bone: string;
  kind: SocketKind;
  /** Rig-local position, measured. */
  position: [number, number, number];
  /** How many vertices the measurement averaged. */
  samples: number;
  /** The measurement that produced `position`. */
  method: string;
}

/** Effect / grip / attachment anchors. Each one is a measured centroid on a real bone. */
export const SOCKETS: MeasuredSocket[] = [
  { id: 'eye-l', bone: 'Head', kind: 'effect', position: [0.090757, 0.775029, -0.022799], samples: 55, method: 'vertices on Head whose vertex colour is green-dominant (g>r+0.03, g>b+0.05), split at the head midline' },
  { id: 'eye-r', bone: 'Head', kind: 'effect', position: [0.090374, 0.776224, 0.020707], samples: 28, method: 'same green-dominant cluster, +Z (anatomical right) half' },
  { id: 'crown', bone: 'Head', kind: 'effect', position: [-0.000228, 0.938538, 0.019782], samples: 200, method: '200 highest-Y vertices bound to the head — the branch crown' },
  { id: 'chest-core', bone: 'Spine02', kind: 'effect', position: [0.025322, 0.56931, -0.005659], samples: 5697, method: 'centroid of vertices bound to Spine01/Spine02' },
  { id: 'grip-l', bone: 'L_Hand', kind: 'grip', position: [-0.025648, 0.633817, -0.486586], samples: 150, method: '150 most distal (-Z) vertices bound to L_Hand' },
  { id: 'grip-r', bone: 'R_Hand', kind: 'grip', position: [0.01507, 0.634118, 0.487115], samples: 150, method: '150 most distal (+Z) vertices bound to R_Hand' },
  { id: 'foot-l', bone: 'L_ToeBase', kind: 'attachment', position: [0.004405, 0.014698, -0.109597], samples: 1549, method: 'centroid of vertices bound to L_Foot/L_ToeBase' },
  { id: 'foot-r', bone: 'R_ToeBase', kind: 'attachment', position: [0.012706, 0.014296, 0.106662], samples: 1595, method: 'centroid of vertices bound to R_Foot/R_ToeBase' },
];


/**
 * The costume split.
 *
 * The export ships ONE skinned shell: the leather bracers and gloves are baked into the same
 * 115,350 triangles as the bark. Smooth-skinning a stiff leather sleeve across the elbow and the
 * wrist shears it, which is the smear the reference never shows. So the sleeve triangles are
 * lifted out of the shell and rebuilt as four rigid meshes, each parented to one bone.
 *
 * Which triangles: a vertex belongs to the costume when its dominant bone is a forearm or hand
 * bone AND its distance along the arm axis falls in the measured leather band. The band came out
 * of a warmth profile (median R-G per vertex colour) taken along both arms independently — the
 * leather fraction rises from ~5% on the upper arm to 23-40% over |z| in [0.258, 0.425] and falls
 * back to ~6% past the glove cuff, and it does so at the SAME arm coordinate on the left and the
 * right, which is what makes it a feature rather than noise. The wrist cut at 0.335 is where the
 * hand bone takes over as dominant. A triangle joins a piece when two of its three vertices do.
 *
 * That is a hypothesis confirmed by symmetry and by the render, not a labelled asset: the export
 * carries no material IDs to appeal to.
 */
export const COSTUME_BAND = { bracer: [0.258, 0.335], glove: [0.335, 0.425] } as const;

export interface CostumePieceSpec {
  id: string;
  /** The bone the piece rides RIGIDLY — this is the whole point of the split. */
  bone: string;
  label: string;
  triangles: number;
}

export const COSTUME_PIECES: CostumePieceSpec[] = [
  { id: 'bracer-l', bone: 'L_Forearm', label: 'left forearm bracer', triangles: 3226 },
  { id: 'glove-l', bone: 'L_Hand', label: 'left gauntlet', triangles: 3236 },
  { id: 'bracer-r', bone: 'R_Forearm', label: 'right forearm bracer', triangles: 3588 },
  { id: 'glove-r', bone: 'R_Hand', label: 'right gauntlet', triangles: 3834 },
];

/** Triangles left on the deforming bark shell once the costume is lifted out. */
export const SHELL_TRIANGLES = 101466;

/**
 * Triangle -> piece, run-length encoded: one byte of piece code (0 = shell, 1..4 = the entries of
 * COSTUME_PIECES in order) followed by a varint run length. 339 runs cover all 115,350 triangles,
 * because the source triangle order is spatially coherent.
 */
export const COSTUME_RLE =
  'AJ8PBAEAKgQCABMEBAABBAQAAQQCAAIEAQACBAIAAQQCAAMEAQALBAEAAwQOAAEEAgACBAEAAwQBAAQEFQABBAIAAgQBAAIEAgACBBgAAQQCAAMEXQABBIQcAwEEBQMBBAsDAQQCAwEEAgMBBAMDAQQJAwEEAgMBBAYDAgQBAwEEAwMGBAEDAQQBAwIEAQMKBAEDAQQBAwEEAwMKBAIDCQQBAwIEAQMDBAIDBgQBA9wZAAEDIQABAxkAAgMkAAEDBQABAx4ABAMEAAEDEgABAwIAAQMBAAIDFgAFAwEAAwMBAAEDAQABAwEAAQMDAAEDAQACAwYAAQMDAAEDBwAFAwEABAMBAAEDAQAEAwEAAQMIAAEDBAABAwIAAgMBAA4DAQAEAwEAAQMBAAIDAgABAwIAAQMBAAEDAgAQAwEACwMBAAMDAQAGAwEACAMBAO/1BQECABgBAQAfAQMACgEBAAIBAQALAQIAAQEEAAIBAwACAQEAAgEBAAoBAgABAQIAAgEDAAMBAgABAQMAAgECAAIBAwAKAQMAAwEDAAEBCQABAQEAAQEBAAIBAgACAQEAAQEDAAIBFwABAQIAAQEBAAEBFAACAQIAAQEEAAEBmwEAAQG1FgIBAR4CAQEBAgEBEwIBAQECAQEEAgEBBwICAQECAQECAgIBAQICAQUCAQECAgQBAQIDAQECAQEBAgEBAQIBAQECAQEBAggBAQIBAQICAQEBAgIBAQIDAQECAQEBAhABAQIBAQICWAEBAgMBAQKnFwABAiQAAgINAAECAQADAgEAAgIBAAMCAgABAggAAQIEAAECAgAKAgEAAgICAAECAQABAgQAAQIHAAgCAQAEAgEAAgIIAAICAQAKAgIAAwICAAECAgAJAgEAAQIBAAYCAQAWAgEAgA8EBACAAQ==';
export const COSTUME_RLE_TRIANGLES = 115350;

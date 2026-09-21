/**
 * The full clip catalog extracted from the supplied rig data. The exported
 * string list is the source of truth for the showcase's animation panel —
 * everything else derives from it.
 *
 * Names are the rig's own (`preset:biped:*` for the retargeted set, the rest
 * given names). They match what `RiggedModel.play(clip)` accepts.
 */

export interface SoraClipDescriptor {
  /** Strict identifier the viewer sends through `play(...)`. */
  id: string;
  /** Button label shown in the showcase animation panel. */
  label: string;
  /** Clip duration in seconds, used to estimate panel sequencing only. */
  duration: number;
  /** Clips meant to play once instead of looping (e.g. greeting). */
  oneShot?: boolean;
  /**
   * Group tag — used purely so the showcase panel can group related clips.
   * Not a structural constraint.
   */
  group:
    | 'locomotion'
    | 'combat'
    | 'dance'
    | 'sport'
    | 'social'
    | 'idle';
}

const namedClip = (
  id: string,
  label: string,
  duration: number,
  group: SoraClipDescriptor['group'],
  oneShot?: boolean,
): SoraClipDescriptor => ({ id, label, duration, group, ...(oneShot ? { oneShot: true } : {}) });

/** Default 44 clips from the supplied skin-a rig. */
export const SORA_CLIPS: readonly SoraClipDescriptor[] = [
  namedClip('preset:biped:climb', 'Climb', 3.5, 'locomotion'),
  namedClip('preset:biped:dive', 'Dive', 2.75, 'sport'),
  namedClip('preset:biped:fall', 'Fall', 3.04, 'sport'),
  namedClip('preset:biped:hurt', 'Hurt', 13.88, 'combat'),
  namedClip('preset:biped:idle', 'Idle', 15.38, 'idle'),
  namedClip('preset:biped:jump', 'Jump', 2.25, 'sport'),
  namedClip('preset:biped:run', 'Run', 1.29, 'locomotion'),
  namedClip('preset:biped:shoot', 'Shoot', 9.08, 'combat'),
  namedClip('preset:biped:slash', 'Slash', 6.63, 'combat'),
  namedClip('preset:biped:turn', 'Turn', 3.88, 'locomotion'),
  namedClip('preset:biped:walk', 'Walk', 2.38, 'locomotion'),
  namedClip('preset:biped:run_upstairs', 'Run Upstairs', 0.83, 'locomotion'),
  namedClip('preset:biped:scratch', 'Scratch', 13.83, 'idle'),
  namedClip('preset:biped:sit', 'Sit', 7.21, 'idle'),
  namedClip('preset:biped:standing_relax', 'Standing Relax', 17.63, 'idle'),
  namedClip('preset:biped:surf', 'Surf', 3.71, 'sport'),
  namedClip('preset:biped:swagger', 'Swagger', 3.71, 'locomotion'),
  namedClip('preset:biped:swim', 'Swim', 5.75, 'sport'),
  namedClip('preset:biped:wait', 'Wait', 6.04, 'idle'),
  namedClip('preset:biped:box_01', 'Boxing 1', 2.25, 'combat'),
  namedClip('preset:biped:box_02', 'Boxing 2', 2.83, 'combat'),
  namedClip('preset:biped:box_03', 'Boxing 3', 2.58, 'combat'),
  namedClip('preset:biped:defeat_02', 'Defeat 2', 8.5, 'combat'),
  namedClip('preset:biped:defeat_03', 'Defeat 3', 5.58, 'combat'),
  namedClip('preset:biped:front_kick_01', 'Front Kick 1', 2.54, 'combat'),
  namedClip('preset:biped:front_kick_02', 'Front Kick 2', 1.42, 'combat'),
  namedClip('preset:biped:hit_to_body_01', 'Hit To Body', 1.33, 'combat'),
  namedClip('preset:biped:greet_01', 'Greet 1', 3.54, 'social', true),
  namedClip('preset:biped:greet_02', 'Greet 2', 5.63, 'social', true),
  namedClip('preset:biped:jump_rope_01', 'Jump Rope', 9.71, 'sport'),
  namedClip('preset:biped:volleyball', 'Volleyball', 8.63, 'sport'),
  namedClip('preset:biped:warm_up', 'Warm Up', 18.33, 'idle'),
  namedClip('preset:biped:dance_01', 'Dance 1', 23.21, 'dance'),
  namedClip('preset:biped:dance_02', 'Dance 2', 12.83, 'dance'),
  namedClip('preset:biped:dance_03', 'Dance 3', 12.83, 'dance'),
  namedClip('preset:biped:dance_04', 'Dance 4', 10.83, 'dance'),
  namedClip('preset:biped:dance_05', 'Dance 5', 2.92, 'dance'),
  namedClip('preset:biped:dance_06', 'Dance 6', 10.92, 'dance'),
  namedClip('preset:biped:play_mobile_game', 'Play Mobile Game', 17.83, 'idle'),
  namedClip('preset:biped:play_video_game', 'Play Video Game', 15.83, 'idle'),
  namedClip('Running Dive Roll', 'Running Dive Roll', 2.07, 'sport'),
  namedClip('Run Backwards', 'Run Backwards', 1.5, 'locomotion'),
  namedClip('Strafe', 'Strafe', 1.15, 'combat'),
  namedClip('Turning', 'Turning', 1.2, 'locomotion'),
];

/** Standalone character control; the showcase performs the transformation. */
export const OUTFIT_CHANGE_ID = 'outfit-change';

export interface SoraActionDescriptor extends SoraClipDescriptor {
  /** True for the button that changes the active character instead of playing a clip. */
  synthetic?: boolean;
}

export const SORA_ACTIONS: readonly SoraActionDescriptor[] = [
  ...SORA_CLIPS.map<SoraActionDescriptor>((c) => ({ ...c })),
  { id: OUTFIT_CHANGE_ID, label: 'Switch Character', duration: 2.2, group: 'social', synthetic: true, oneShot: true },
];

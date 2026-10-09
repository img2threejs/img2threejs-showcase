import { AnimationClip, FileLoader, type AnimationClipJSON } from 'three/webgpu';

/** Measured with the img2threejs 1.5.2 sampler and clip_features.py; source SHA-256 bbf93dbfd845c1d4b15e4e6bf75135606e8c8566e26dcba8d78d8b6e9741d344. */
export const ROBOT_ANIMATION_PROFILE = [
  { sourceName: "walk.001", label: "Walk", motionClass: "in-place", loop: true, duration: 2.375000, poseReturnDegrees: 0.052358, hipReturnH: 0.00000584, scaleDelta: 0.00001132, tracks: 195 },
  { sourceName: "greet_01.001", label: "US Greeting", motionClass: "in-place", loop: false, duration: 3.541667, poseReturnDegrees: 18.656844, hipReturnH: 0.00304907, scaleDelta: 0.00001144, tracks: 195 },
  { sourceName: "run.001", label: "Run", motionClass: "in-place", loop: false, duration: 1.291667, poseReturnDegrees: 19.500610, hipReturnH: 0.00782899, scaleDelta: 0.00001132, tracks: 195 },
  { sourceName: "Malaysia — Malay Greeting with a Hand-to-Chest Finish\nFor a f", label: "Malay Greeting", motionClass: "idle", loop: false, duration: 4.000000, poseReturnDegrees: 12.191535, hipReturnH: 0.00156557, scaleDelta: 0.00001121, tracks: 195 },
  { sourceName: "China — Traditional Gongshou Greeting\nFor a traditional or ce", label: "Gongshou Greeting", motionClass: "idle", loop: false, duration: 4.000000, poseReturnDegrees: 10.955070, hipReturnH: 0.00008617, scaleDelta: 0.00001132, tracks: 195 },
  { sourceName: "dance_03.001", label: "Dance 03", motionClass: "in-place", loop: false, duration: 12.833333, poseReturnDegrees: 2.661148, hipReturnH: 0.00361243, scaleDelta: 0.00001121, tracks: 195 },
  { sourceName: "warm_up.001", label: "Warm-up", motionClass: "jump", loop: false, duration: 18.333334, poseReturnDegrees: 7.322539, hipReturnH: 0.00229846, scaleDelta: 0.00001132, tracks: 195 },
  { sourceName: "Make animation greeting for a website, robot will be in the web", label: "Generally Greeting", motionClass: "idle", loop: false, duration: 6.000000, poseReturnDegrees: 7.619691, hipReturnH: 0.00057648, scaleDelta: 0.00001121, tracks: 195 },
  { sourceName: "front_kick_02.001", label: "Front Kick 02", motionClass: "in-place", loop: false, duration: 1.416667, poseReturnDegrees: 16.535793, hipReturnH: 0.01740095, scaleDelta: 0.00001132, tracks: 195 },
  { sourceName: "box_03.001", label: "Box 03", motionClass: "in-place", loop: true, duration: 2.583333, poseReturnDegrees: 0.185218, hipReturnH: 0.00000286, scaleDelta: 0.00001121, tracks: 195 },
  { sourceName: "India — Namaste with Palms Together\nContext: A polite greetin", label: "Namaste", motionClass: "idle", loop: false, duration: 4.000000, poseReturnDegrees: 10.291128, hipReturnH: 0.00154481, scaleDelta: 0.00001132, tracks: 195 },
  { sourceName: "front_kick_01.001", label: "Front Kick 01", motionClass: "in-place", loop: false, duration: 2.541667, poseReturnDegrees: 3.949247, hipReturnH: 0.00682544, scaleDelta: 0.00001132, tracks: 195 },
  { sourceName: "box_01.001", label: "Box 01", motionClass: "in-place", loop: true, duration: 2.250000, poseReturnDegrees: 0.000829, hipReturnH: 0.00000012, scaleDelta: 0.00001121, tracks: 195 },
  { sourceName: "box_02.001", label: "Box 02", motionClass: "in-place", loop: false, duration: 2.833333, poseReturnDegrees: 81.783209, hipReturnH: 0.05931329, scaleDelta: 0.00001132, tracks: 195 },
  { sourceName: "greet_04.001", label: "Hiphop Greeting", motionClass: "in-place", loop: false, duration: 2.833333, poseReturnDegrees: 1.044507, hipReturnH: 0.00023442, scaleDelta: 0.00001144, tracks: 195 },
  { sourceName: "Vietnam — Folded Arms and Respectful Head Bow\nFor a child or ", label: "Vietnamese Greeting", motionClass: "idle", loop: false, duration: 4.000000, poseReturnDegrees: 11.710398, hipReturnH: 0.00186272, scaleDelta: 0.00001144, tracks: 195 },
  { sourceName: "dance_04.001", label: "Dance 04", motionClass: "in-place", loop: false, duration: 10.833333, poseReturnDegrees: 2.853292, hipReturnH: 0.00010251, scaleDelta: 0.00001121, tracks: 195 },
] as const;

export interface RobotAnimationProfile {
  sourceName: string;
  label: string;
  motionClass: 'in-place' | 'idle' | 'jump';
  loop: boolean;
  duration: number;
  poseReturnDegrees: number;
  hipReturnH: number;
  scaleDelta: number;
  tracks: number;
}

const greetingNames = ["Japan's Greeting", 'Shaking Hands'] as const;
let greetingProfiles: RobotAnimationProfile[] = [];
let greetingPromise: Promise<AnimationClip[]> | null = null;
let exportedProfiles: RobotAnimationProfile[] = [];
let exportedAnimationPromise: Promise<AnimationClip[]> | null = null;

/** Loads the offline-retargeted clips and their measured profiles once, independently of the source GLB contract. */
export function loadRobotGreetingClips(): Promise<AnimationClip[]> {
  if (!greetingPromise) {
    greetingPromise = new FileLoader()
      .setResponseType('json')
      .loadAsync(import.meta.env.BASE_URL + 'robot/greetings.json')
      .then((payload: unknown) => {
        const data = payload as { clips: AnimationClipJSON[]; profiles: RobotAnimationProfile[] };
        if (!Array.isArray(data.clips) || !Array.isArray(data.profiles)
          || data.clips.length !== greetingNames.length || data.profiles.length !== greetingNames.length) {
          throw new Error('Robot greeting contract expected two clips and two measured profiles.');
        }
        const clips = data.clips.map((clip) => AnimationClip.parse(clip));
        // AnimationMixer caches actions by UUID; missing or shared IDs play the wrong gesture.
        if (clips.some((clip) => typeof clip.uuid !== 'string' || clip.uuid.length === 0)
          || new Set(clips.map((clip) => clip.uuid)).size !== clips.length) {
          throw new Error('Robot greeting clips require distinct, nonempty UUIDs.');
        }
        for (const name of greetingNames) {
          const matchingClips = clips.filter((clip) => clip.name === name);
          const matchingProfiles = data.profiles.filter((profile) => profile.sourceName === name);
          const clip = matchingClips[0];
          const profile = matchingProfiles[0];
          if (matchingClips.length !== 1 || matchingProfiles.length !== 1 || !clip || !profile
            || profile.label !== name || profile.loop !== false || profile.motionClass !== 'in-place'
            || !Number.isFinite(profile.duration) || profile.duration <= 0
            || Math.abs(clip.duration - profile.duration) > 0.000001
            || !Number.isInteger(profile.tracks) || profile.tracks <= 0 || clip.tracks.length !== profile.tracks
            || ![profile.poseReturnDegrees, profile.hipReturnH, profile.scaleDelta].every((value) => Number.isFinite(value) && value >= 0)
            || !clip.validate()) {
            throw new Error('Greeting ' + name + ' does not match its measured playback profile.');
          }
        }
        greetingProfiles = data.profiles;
        return clips;
    }).catch((error: unknown) => {
      greetingPromise = null;
      throw error;
    });
  }
  return greetingPromise;
}

/** Loads the six animation clips exported from the matching rig without reloading its duplicate mesh/texture. */
export function loadRobotExportedAnimationClips(): Promise<AnimationClip[]> {
  if (!exportedAnimationPromise) {
    exportedAnimationPromise = new FileLoader()
      .setResponseType('json')
      .loadAsync(import.meta.env.BASE_URL + 'robot/exported-robot-animations.json')
      .then((payload: unknown) => {
        const data = payload as {
          formatVersion: number;
          clipCount: number;
          clips: AnimationClipJSON[];
          profiles: RobotAnimationProfile[];
        };
        if (data.formatVersion !== 1 || data.clipCount !== 6
          || !Array.isArray(data.clips) || data.clips.length !== data.clipCount
          || !Array.isArray(data.profiles) || data.profiles.length !== data.clipCount) {
          throw new Error('Exported robot animation pack must contain six clips and six profiles.');
        }
        const clips = data.clips.map((clip) => AnimationClip.parse(clip));
        if (clips.some((clip) => typeof clip.uuid !== 'string' || clip.uuid.length === 0)
          || new Set(clips.map((clip) => clip.uuid)).size !== clips.length) {
          throw new Error('Exported robot animations require distinct, nonempty UUIDs.');
        }
        const sourceNames = new Set<string>();
        const labels = new Set<string>();
        for (let index = 0; index < clips.length; index++) {
          const clip = clips[index];
          const profile = data.profiles[index];
          if (!clip || !profile || sourceNames.has(clip.name) || labels.has(profile.label)
            || profile.sourceName !== clip.name || !profile.label.trim()
            || !Number.isFinite(profile.duration) || Math.abs(clip.duration - profile.duration) > 1e-6
            || !Number.isInteger(profile.tracks) || profile.tracks !== clip.tracks.length
            || clip.tracks.length !== 195 || !clip.validate()
            || ![profile.poseReturnDegrees, profile.hipReturnH, profile.scaleDelta].every((value) => Number.isFinite(value) && value >= 0)) {
            throw new Error('Exported robot animation ' + (clip?.name ?? index) + ' does not match its playback profile.');
          }
          sourceNames.add(clip.name);
          labels.add(profile.label);
        }
        exportedProfiles = data.profiles;
        return clips;
    }).catch((error: unknown) => {
      exportedAnimationPromise = null;
      throw error;
    });
  }
  return exportedAnimationPromise;
}

export function getRobotAnimationProfile(sourceName: string): RobotAnimationProfile | undefined {
  return ROBOT_ANIMATION_PROFILE.find((profile) => profile.sourceName === sourceName)
    ?? greetingProfiles.find((profile) => profile.sourceName === sourceName)
    ?? exportedProfiles.find((profile) => profile.sourceName === sourceName);
}

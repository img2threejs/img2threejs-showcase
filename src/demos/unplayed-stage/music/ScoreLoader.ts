export type TrackId = 'piano' | 'guitar' | 'bass' | 'drums';
export interface NoteEvent {
  id: string;
  instrumentId: TrackId;
  onsetSeconds: number;
  releaseSeconds: number;
  midiPitch: number;
  velocity: number;
  componentId: string;
  stringIndex?: number;
  fret?: number;
  drumPart?: string;
  stickId?: 'left' | 'right' | 'pedal';
}
export interface ControllerEvent {
  instrumentId: 'piano';
  timeSeconds: number;
  type: 'sustain';
  value: 0 | 1;
  componentId?: string;
}
export interface Score {
  version: string;
  durationSeconds: number;
  bpm: number;
  meter: [number, number];
  notes: NoteEvent[];
  controllers: ControllerEvent[];
}

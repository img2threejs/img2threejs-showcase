export const IPHONE_DUO_FINISHES = ['white', 'night', 'sage', 'sand', 'coral', 'lavender'] as const;

export type IphoneDuoFinish = typeof IPHONE_DUO_FINISHES[number];

export type IphoneDuoFinishWeights = {
  [finish in IphoneDuoFinish]: number;
};

export interface IphoneDuoFinishPalette {
  label: string;
  hex: string;
  study: boolean;
  screenTreatment: 'day' | 'night';
  material: {
    body: string;
    bodyGlass: string;
    enclosure: string;
    ancillaryMetal: string;
    ancillaryInsert: string;
    button: string;
    logo: string;
    capsule: string;
    lensRing: string;
    lensInnerRing: string;
    lensCavity: string;
    lensGlass: string;
    lensTransmission: string;
    microphone: string;
    flash: string;
  };
  lighting: {
    softFill: number;
    railLift: number;
    macroPostCut: number;
  };
}

const whiteMaterial = {
  body: '#F7F7F4',
  bodyGlass: '#F7F7F4',
  enclosure: '#C9CCD0',
  ancillaryMetal: '#D6D0C6',
  ancillaryInsert: '#BEB7AB',
  button: '#B8B1A7',
  logo: '#807A71',
  capsule: '#EEEAE3',
  lensRing: '#DEDBD5',
  lensInnerRing: '#DEDBD5',
  lensCavity: '#07080C',
  lensGlass: '#0C1015',
  lensTransmission: '#20242A',
  microphone: '#77736E',
  flash: '#E5DDD2',
};

export const IPHONE_DUO_FINISH_PALETTES: Record<IphoneDuoFinish, IphoneDuoFinishPalette> = {
  white: {
    label: 'White',
    hex: '#F7F7F4',
    study: false,
    screenTreatment: 'day',
    material: whiteMaterial,
    lighting: { softFill: 180, railLift: 0, macroPostCut: 0.42 },
  },
  night: {
    label: 'Night',
    hex: '#4C5560',
    study: false,
    screenTreatment: 'night',
    material: {
      body: '#4C5560',
      bodyGlass: '#4C5560',
      enclosure: '#3C4C5E',
      ancillaryMetal: '#26303D',
      ancillaryInsert: '#1B2532',
      button: '#1A202B',
      logo: '#0D1620',
      capsule: '#2F3945',
      lensRing: '#2B3442',
      lensInnerRing: '#1A222E',
      lensCavity: '#0D141F',
      lensGlass: '#0D141F',
      lensTransmission: '#172337',
      microphone: '#454D5A',
      flash: '#E5DDD2',
    },
    lighting: { softFill: 52, railLift: 1, macroPostCut: 0.95 },
  },
  sage: {
    label: 'Sage study',
    hex: '#7A8B72',
    study: true,
    screenTreatment: 'day',
    material: {
      body: '#7A8B72',
      bodyGlass: '#6B7B64',
      enclosure: '#5E6E59',
      ancillaryMetal: '#586753',
      ancillaryInsert: '#3F4C3B',
      button: '#354333',
      logo: '#253024',
      capsule: '#64755D',
      lensRing: '#435040',
      lensInnerRing: '#293428',
      lensCavity: '#0D1510',
      lensGlass: '#101A15',
      lensTransmission: '#22392C',
      microphone: '#66745F',
      flash: '#E8E1D5',
    },
    lighting: { softFill: 158, railLift: 0.15, macroPostCut: 0.50 },
  },
  sand: {
    label: 'Sand study',
    hex: '#CDB99B',
    study: true,
    screenTreatment: 'day',
    material: {
      body: '#CDB99B',
      bodyGlass: '#B7A486',
      enclosure: '#A38F72',
      ancillaryMetal: '#968263',
      ancillaryInsert: '#665847',
      button: '#574A3B',
      logo: '#4C3D30',
      capsule: '#A59175',
      lensRing: '#6F6250',
      lensInnerRing: '#443A30',
      lensCavity: '#171310',
      lensGlass: '#1B1813',
      lensTransmission: '#3D3427',
      microphone: '#A39682',
      flash: '#EFE7DC',
    },
    lighting: { softFill: 174, railLift: 0.08, macroPostCut: 0.46 },
  },
  coral: {
    label: 'Coral study',
    hex: '#C87568',
    study: true,
    screenTreatment: 'day',
    material: {
      body: '#C87568',
      bodyGlass: '#B36056',
      enclosure: '#9D544C',
      ancillaryMetal: '#8A4941',
      ancillaryInsert: '#5D302D',
      button: '#4E2926',
      logo: '#44211E',
      capsule: '#A65A50',
      lensRing: '#713C38',
      lensInnerRing: '#452826',
      lensCavity: '#180E0D',
      lensGlass: '#1D1211',
      lensTransmission: '#47211F',
      microphone: '#AD796F',
      flash: '#F0E5D8',
    },
    lighting: { softFill: 160, railLift: 0.18, macroPostCut: 0.50 },
  },
  lavender: {
    label: 'Lavender study',
    hex: '#8F84B3',
    study: true,
    screenTreatment: 'day',
    material: {
      body: '#8F84B3',
      bodyGlass: '#7E74A1',
      enclosure: '#716790',
      ancillaryMetal: '#655B84',
      ancillaryInsert: '#443B5D',
      button: '#382F4E',
      logo: '#2E263F',
      capsule: '#796F9F',
      lensRing: '#4F486A',
      lensInnerRing: '#312B46',
      lensCavity: '#100E17',
      lensGlass: '#151321',
      lensTransmission: '#312949',
      microphone: '#7D739A',
      flash: '#E9E1D7',
    },
    lighting: { softFill: 150, railLift: 0.22, macroPostCut: 0.54 },
  },
};

export function isIphoneDuoFinish(value: string | undefined): value is IphoneDuoFinish {
  return value !== undefined && (IPHONE_DUO_FINISHES as readonly string[]).includes(value);
}

export function createFinishWeights(finish: IphoneDuoFinish = 'white'): IphoneDuoFinishWeights {
  return {
    white: finish === 'white' ? 1 : 0,
    night: finish === 'night' ? 1 : 0,
    sage: finish === 'sage' ? 1 : 0,
    sand: finish === 'sand' ? 1 : 0,
    coral: finish === 'coral' ? 1 : 0,
    lavender: finish === 'lavender' ? 1 : 0,
  };
}

export function normalizeFinishWeights(
  input: Partial<IphoneDuoFinishWeights> | undefined,
): IphoneDuoFinishWeights {
  const weights = createFinishWeights();
  let total = 0;
  IPHONE_DUO_FINISHES.forEach((finish) => {
    const value = input?.[finish];
    const safe = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
    weights[finish] = safe;
    total += safe;
  });
  if (total <= 1e-8) return createFinishWeights('white');
  IPHONE_DUO_FINISHES.forEach((finish) => {
    weights[finish] /= total;
  });
  return weights;
}

export function weightedFinishValue(
  weights: IphoneDuoFinishWeights,
  getValue: (palette: IphoneDuoFinishPalette) => number,
): number {
  return IPHONE_DUO_FINISHES.reduce(
    (sum, finish) => sum + weights[finish] * getValue(IPHONE_DUO_FINISH_PALETTES[finish]),
    0,
  );
}

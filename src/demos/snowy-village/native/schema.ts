export interface NativePayload {
  readonly sha256: string;
  readonly byteLength: number;
  readonly mimeType: string;
  readonly base64: string;
}

export interface NativeAccessor {
  readonly sourceIndex: number;
  readonly componentType: number;
  readonly componentArrayType: string;
  readonly type: string;
  readonly count: number;
  readonly normalized: boolean;
  readonly min: readonly number[] | null;
  readonly max: readonly number[] | null;
  readonly sha256: string;
  readonly byteLength: number;
  readonly payload: Omit<NativePayload, 'base64'>;
}

export interface NativeImage {
  readonly sourceIndex: number;
  readonly mimeType: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly payload: Omit<NativePayload, 'base64'>;
}

export interface NativeAsset {
  readonly schemaVersion: 1;
  readonly role: string;
  readonly source: { readonly path: string; readonly originalPath: string; readonly bytes: number; readonly sha256: string };
  readonly raw: {
    readonly gltf: Readonly<Record<string, unknown>>;
    readonly accessors: Readonly<Record<number, NativeAccessor>>;
    readonly images: Readonly<Record<number, NativeImage>>;
  };
  readonly effective: {
    readonly threeRevision: '169.0';
    readonly nodes: readonly Readonly<Record<string, unknown>>[];
    readonly meshes: readonly Readonly<Record<string, unknown>>[];
    readonly materials: readonly Readonly<Record<string, unknown>>[];
    readonly materialVariants: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    readonly textures: readonly Readonly<Record<string, unknown>>[];
    readonly samplers: readonly Readonly<Record<string, unknown>>[];
    readonly images: Readonly<Record<number, Omit<NativeImage, 'payload'> & { readonly decodeOptions: { readonly premultiplyAlpha: 'none'; readonly colorSpaceConversion: 'none' } }>>;
    readonly skins: readonly Readonly<Record<string, unknown>>[];
    readonly animations: readonly Readonly<Record<string, unknown>>[];
    readonly skinWeights: Readonly<Record<string, { readonly nodeIndex: number; readonly meshIndex: number; readonly primitiveIndex: number; readonly sourceAccessorIndex: number; readonly payloadSha256: string; readonly vertexCount: number }>>;
  };
  readonly payloads: {
    readonly accessors: Readonly<Record<string, NativePayload>>;
    readonly images: Readonly<Record<string, NativePayload>>;
    readonly effective: Readonly<Record<string, NativePayload>>;
  };
}

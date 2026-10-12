import { getDemo } from './demos/registry';

/** Source archives are generated from the same checkout as the deployed gallery. */
export async function downloadShowcaseSource(id: string, signal?: AbortSignal): Promise<{ blob: Blob; filename: string }> {
  if (!getDemo(id)) throw new Error(`Unknown Three.js showcase: ${id}`);
  const response = await fetch(`${import.meta.env.BASE_URL}source/${encodeURIComponent(id)}.zip`, { signal });
  if (!response.ok) throw new Error(`Source download failed (HTTP ${response.status}). Please try again.`);
  const blob = await response.blob();
  const signature = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  if (signature[0] !== 0x50 || signature[1] !== 0x4b || signature[2] !== 3 || signature[3] !== 4) {
    throw new Error('The source archive is unavailable. Please try again after the site has finished deploying.');
  }
  return { blob, filename: `${id}-source.zip` };
}

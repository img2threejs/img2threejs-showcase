import { decodeModel, type DecodedPart } from './meshCodec';
export type GrootSourceQuality='high'|'medium';
// Data-only supplied archive payloads: no ZIP JavaScript is evaluated. At most two
// decoded medium payloads, shared across mounts; failures are retryable, not cached.
const urls={bloom:new URL('./bloom-source/surfaceData.medium.json',import.meta.url),ice:new URL('./ice-source/surfaceData.medium.json',import.meta.url)};
const pending:Partial<Record<keyof typeof urls,Promise<DecodedPart[]>>>={};
export function loadGrootMedium(id:keyof typeof urls):Promise<DecodedPart[]>{
 return pending[id]??=(async()=>{try{
  const response=await fetch(urls[id]);if(!response.ok)throw new Error(`${id} medium source: HTTP ${response.status}`);
  const data=await response.json();return decodeModel(data.model,data.stream);
 }catch(error){delete pending[id];throw error;}})();
}

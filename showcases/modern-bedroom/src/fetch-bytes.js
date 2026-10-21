// Streaming fetch into one preallocated buffer, with byte progress.
// `onProgress(loaded, total)`: `total` is 0 when the server did not announce a usable length (no Content-Length, or a
// Content-Encoding that makes it differ from the bytes we count).
export async function fetchBytes(url, { onProgress, signal, cache } = {}) {
  const response = await fetch(url, { signal, cache });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
  const encoding = response.headers.get('content-encoding');
  const announced = Number(response.headers.get('content-length')) || 0;
  const total = encoding && encoding !== 'identity' ? 0 : announced;
  onProgress?.(0, total);
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    onProgress?.(buffer.byteLength, buffer.byteLength);
    return buffer;
  }
  const reader = response.body.getReader();
  let out = new Uint8Array(total || 1 << 20);
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (loaded + value.length > out.length) {
      // Unannounced or wrong length: grow geometrically (rare; the announced path never reallocates).
      const grown = new Uint8Array(Math.max(out.length * 2, loaded + value.length));
      grown.set(out.subarray(0, loaded));
      out = grown;
    }
    out.set(value, loaded);
    loaded += value.length;
    onProgress?.(loaded, total);
  }
  onProgress?.(loaded, loaded);
  // The preallocated buffer is exact when the announced length held; otherwise trim once.
  return loaded === out.buffer.byteLength ? out.buffer : out.buffer.slice(0, loaded);
}

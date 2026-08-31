const ERROR_DETAIL_CAP_BYTES = 1024;

/** Read a bounded diagnostic prefix, then release the response stream. */
export async function errorDetail(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';

  const chunks: Uint8Array[] = [];
  let size = 0;
  let done = false;
  try {
    while (size < ERROR_DETAIL_CAP_BYTES) {
      const next = await reader.read();
      done = next.done;
      if (done) break;
      if (!next.value) continue;

      const chunk = new Uint8Array(next.value.subarray(0, ERROR_DETAIL_CAP_BYTES - size));
      chunks.push(chunk);
      size += chunk.byteLength;
      if (chunk.byteLength < next.value.byteLength) break;
    }
  } finally {
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bodySafe(new TextDecoder().decode(bytes)).slice(0, 200);
}
import { bodySafe } from '../format.ts';

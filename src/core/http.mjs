// Fetch's request signal remains responsible for timeout/abort during body reads.
export async function readResponseText(response, maximumBytes) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    await response.body?.cancel().catch(() => {});
    throw new RangeError("HTTP response exceeds the configured byte limit");
  }
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel().catch(() => {});
        throw new RangeError("HTTP response exceeds the configured byte limit");
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, bytes).toString("utf8");
  } finally {
    reader.releaseLock();
  }
}

// Shared by the browser and provider client. Chunk boundaries may split UTF-8 or SSE lines.
export async function* readEventStream(body) {
  if (!body) throw new Error('The server did not return a stream.');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (buffer.length > 1_000_000) throw new Error('The stream exceeded the event size limit.');
      if (done) buffer += '\n\n';
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end).replace(/\r$/, '');
        buffer = buffer.slice(end + 1);
        if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        else if (!line && data.length) {
          const payload = data.join('\n');
          data = [];
          if (payload !== '[DONE]') yield JSON.parse(payload);
        }
        if (data.reduce((size, line) => size + line.length, 0) > 1_000_000) throw new Error('The stream exceeded the event size limit.');
      }
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

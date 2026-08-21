export async function* readSseData(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let done = false
  const abort = () => { void reader.cancel(signal?.reason) }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    while (!done) {
      if (signal?.aborted) throw signal.reason
      const next = await reader.read()
      if (signal?.aborted) throw signal.reason
      done = next.done
      buffer += decoder.decode(next.value, { stream: !done })
      let match: RegExpExecArray | null
      while ((match = /\r\n\r\n|\n\n|\r\r/.exec(buffer))) {
        const block = buffer.slice(0, match.index)
        buffer = buffer.slice(match.index + match[0].length)
        const data = block.split(/\r\n|\r|\n/)
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).replace(/^ /, ''))
          .join('\n')
        if (data) yield data
      }
    }
    const data = buffer.split(/\r\n|\r|\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).replace(/^ /, ''))
      .join('\n')
    if (data) yield data
  } finally {
    signal?.removeEventListener('abort', abort)
    if (!done) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

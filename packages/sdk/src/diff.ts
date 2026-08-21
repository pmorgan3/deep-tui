function lines(value: string): string[] {
  if (!value) return []
  const normalized = value.replace(/\r\n?/g, '\n')
  const output = normalized.split('\n')
  if (normalized.endsWith('\n')) output.pop()
  return output
}

function range(start: number, count: number): string {
  return count === 1 ? String(start) : `${start},${count}`
}

/**
 * Create a bounded-context unified diff for a complete-file replacement.
 * It intentionally emits one hunk around the changed region; exact patch
 * application remains the responsibility of the patch tool.
 */
export function createUnifiedDiff(
  filename: string,
  before: string | undefined,
  after: string | undefined,
  contextLines = 3,
): string {
  if (before === after) return ''
  const oldLines = lines(before ?? '')
  const newLines = lines(after ?? '')
  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < oldLines.length - prefix
    && suffix < newLines.length - prefix
    && oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]
  ) suffix += 1

  const oldChangeEnd = oldLines.length - suffix
  const newChangeEnd = newLines.length - suffix
  const hunkStart = Math.max(0, prefix - Math.max(0, contextLines))
  const oldHunkEnd = Math.min(oldLines.length, oldChangeEnd + Math.max(0, contextLines))
  const newHunkEnd = Math.min(newLines.length, newChangeEnd + Math.max(0, contextLines))
  const oldCount = oldHunkEnd - hunkStart
  const newCount = newHunkEnd - hunkStart
  const oldStart = oldCount === 0 ? 0 : hunkStart + 1
  const newStart = newCount === 0 ? 0 : hunkStart + 1
  const output = [
    before === undefined ? '--- /dev/null' : `--- a/${filename}`,
    after === undefined ? '+++ /dev/null' : `+++ b/${filename}`,
    `@@ -${range(oldStart, oldCount)} +${range(newStart, newCount)} @@`,
  ]

  for (let index = hunkStart; index < prefix; index += 1) output.push(` ${oldLines[index] ?? ''}`)
  for (let index = prefix; index < oldChangeEnd; index += 1) output.push(`-${oldLines[index] ?? ''}`)
  for (let index = prefix; index < newChangeEnd; index += 1) output.push(`+${newLines[index] ?? ''}`)
  for (let offset = 0; offset < Math.min(contextLines, suffix); offset += 1) {
    output.push(` ${oldLines[oldChangeEnd + offset] ?? ''}`)
  }
  if (before !== undefined && !before.endsWith('\n')) output.push('\\ No newline at end of file (before)')
  if (after !== undefined && !after.endsWith('\n')) output.push('\\ No newline at end of file (after)')
  return `${output.join('\n')}\n`
}

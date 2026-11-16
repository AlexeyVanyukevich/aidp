/** The most pairs of differing lines the diff compares. */
export const DIFF_CELL_LIMIT = 1_000_000
const CONTEXT = 2

interface Op {
  t: ' ' | '-' | '+'
  line: string
}

/**
 * A unified diff of two texts by line, with 2 lines of context; the empty string for equal texts,
 * null when the differing middles are too large to compare.
 */
export function lineDiff(before: string, after: string): string | null {
  const a = before.split('\n')
  const b = after.split('\n')
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++
  const midA = a.slice(head, a.length - tail)
  const midB = b.slice(head, b.length - tail)
  if (midA.length * midB.length > DIFF_CELL_LIMIT) return null
  if (midA.length === 0 && midB.length === 0) return ''

  const width = midB.length + 1
  const table = new Uint32Array((midA.length + 1) * width)
  const at = (i: number, j: number) => table[i * width + j] ?? 0
  for (let i = midA.length - 1; i >= 0; i--)
    for (let j = midB.length - 1; j >= 0; j--)
      table[i * width + j] =
        midA[i] === midB[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1))

  const ops: Op[] = a.slice(0, head).map((line) => ({ t: ' ', line }))
  let i = 0
  let j = 0
  while (i < midA.length || j < midB.length) {
    if (i < midA.length && j < midB.length && midA[i] === midB[j]) {
      ops.push({ t: ' ', line: midA[i] ?? '' })
      i++
      j++
    } else if (j >= midB.length || (i < midA.length && at(i + 1, j) >= at(i, j + 1))) {
      ops.push({ t: '-', line: midA[i] ?? '' })
      i++
    } else {
      ops.push({ t: '+', line: midB[j] ?? '' })
      j++
    }
  }
  for (const line of a.slice(a.length - tail)) ops.push({ t: ' ', line })

  const changed: number[] = []
  ops.forEach((op, k) => {
    if (op.t !== ' ') changed.push(k)
  })
  const groups: [number, number][] = []
  for (const k of changed) {
    const last = groups[groups.length - 1]
    if (last !== undefined && k - last[1] - 1 <= 2 * CONTEXT) last[1] = k
    else groups.push([k, k])
  }

  const out: string[] = []
  for (const [first, last] of groups) {
    const from = Math.max(0, first - CONTEXT)
    const to = Math.min(ops.length - 1, last + CONTEXT)
    const slice = ops.slice(from, to + 1)
    const prior = ops.slice(0, from)
    const beforeBefore = prior.filter((op) => op.t !== '+').length
    const afterBefore = prior.filter((op) => op.t !== '-').length
    const beforeLen = slice.filter((op) => op.t !== '+').length
    const afterLen = slice.filter((op) => op.t !== '-').length
    out.push(
      `@@ -${beforeLen === 0 ? beforeBefore : beforeBefore + 1},${beforeLen} +${afterLen === 0 ? afterBefore : afterBefore + 1},${afterLen} @@`,
    )
    for (const op of slice) out.push(`${op.t}${op.line}`)
  }
  return out.join('\n')
}

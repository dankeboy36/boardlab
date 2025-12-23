// @ts-check

/**
 * Serial text → aligned columnar samples according to Monitor policy.
 *
 * - Split by CR/LF; tokenize by whitespace/comma/semicolon.
 * - Extract finite numbers only.
 * - Mode detection: first line with >= 2 numbers switches to 'explicit-x'.
 *
 *   - Explicit-x: x = first column, ys = remaining columns; drop row if x <= lastX.
 *   - Implicit-index: x = nextIndex++, ys = [last column].
 * - Do not convert x units once mode is chosen.
 * - Multiple series: keep common x[] and parallel yN[]; fill nulls for missing.
 *
 * @typedef {'implicit-index' | 'explicit-x'} Mode
 *
 * @typedef {(number | null | undefined)[]} YArray
 *
 * @typedef {[number[], ...YArray[]]} FixedSample
 * @param {string} text
 * @param {{ current: Mode }} modeRef
 * @param {{ current: number }} nextIndexRef
 * @param {{ current: number | null }} lastXRef
 * @returns {FixedSample | null}
 */
export function parseSamples(text, modeRef, nextIndexRef, lastXRef) {
  const lines = String(text).split(/\r?\n/)
  /** @type {number[]} */
  const xs = []
  /** @type {YArray[]} */
  const ys = []
  let rowCount = 0

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    const tokens = line.split(/[\s,;]+/).filter(Boolean)
    if (tokens.length === 0) continue

    // Extract numeric columns
    const nums = tokens.map(Number).filter((n) => Number.isFinite(n))
    if (nums.length === 0) continue

    // Lock mode to explicit-x once we see multi-number numeric lines
    if (modeRef.current === 'implicit-index' && nums.length >= 2) {
      modeRef.current = 'explicit-x'
    }

    let x
    /** @type {number[]} */
    let rowYs
    if (modeRef.current === 'explicit-x') {
      x = /** @type {number} */ (nums[0])
      rowYs = nums.slice(1)
      const lastX = lastXRef.current
      if (lastX != null && !(x > lastX)) {
        // Non-increasing x: drop the row
        continue
      }
      lastXRef.current = x
    } else {
      x = nextIndexRef.current++
      rowYs = [nums[nums.length - 1]]
    }

    // Ensure we have enough series arrays; backfill previous rows with nulls
    for (let s = ys.length; s < rowYs.length; s++) {
      const arr = new Array(rowCount)
      for (let i = 0; i < rowCount; i++) arr[i] = null
      ys.push(arr)
    }

    xs.push(x)
    for (let s = 0; s < ys.length; s++) {
      ys[s].push(s < rowYs.length ? rowYs[s] : null)
    }
    rowCount++
  }

  if (xs.length === 0) return null
  // @ts-ignore - variadic tuple
  return [xs, ...ys]
}

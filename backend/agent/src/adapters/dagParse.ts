/**
 * Robust DAG-from-LLM-output parsing. The naive `JSON.parse` path fails
 * when the provider truncates mid-array (which 0G TEE providers do —
 * they cap response tokens regardless of the request's max_tokens). This
 * helper walks the response and extracts every top-level object that
 * parses cleanly, even if the array itself is unterminated.
 *
 * Returns null if no parseable node is found, so callers can decide
 * whether to throw or fall back further.
 */
export function recoverDAGNodes(raw: string): any[] | null {
  const trimmed = raw.trim()

  // Strategy 1 — strict JSON of the whole {"nodes":[...]} object.
  const jsonMatch = trimmed.match(/\{[\s\S]*?"nodes"\s*:\s*\[[\s\S]*?\]\s*\}/)
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0])
      if (Array.isArray(obj?.nodes) && obj.nodes.length > 0) return obj.nodes
    } catch {
      // sanitize trailing commas + control chars and retry once
      try {
        const sanitized = jsonMatch[0]
          .replace(/,\s*([\]}])/g, '$1')
          .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
        const obj = JSON.parse(sanitized)
        if (Array.isArray(obj?.nodes) && obj.nodes.length > 0) return obj.nodes
      } catch {
        // fall through to recovery walk
      }
    }
  }

  // Strategy 2 — truncated array recovery. Walk character-by-character
  // through whatever follows `"nodes":[` and extract every balanced
  // `{...}` object, tolerating an unterminated last entry.
  const arrayHeader = trimmed.search(/"nodes"\s*:\s*\[/)
  if (arrayHeader < 0) return null
  const arrayStart = trimmed.indexOf('[', arrayHeader)
  if (arrayStart < 0) return null
  const body = trimmed.substring(arrayStart + 1)

  const nodes: any[] = []
  let depth = 0
  let objStart = -1
  let inString = false
  let escape = false

  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (escape) { escape = false; continue }
    if (inString) {
      if (ch === '\\') escape = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{') {
      if (depth === 0) objStart = i
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0 && objStart >= 0) {
        const objStr = body.substring(objStart, i + 1)
        try {
          nodes.push(JSON.parse(objStr))
        } catch {
          // skip malformed object, keep walking
        }
        objStart = -1
      }
    } else if (ch === ']' && depth === 0) {
      // legitimate end of the nodes array
      break
    }
  }

  return nodes.length > 0 ? nodes : null
}

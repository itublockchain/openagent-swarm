/**
 * Parse a judge LLM response into a structured verdict.
 *
 * Returns null when the response cannot be reliably interpreted — callers
 * MUST treat null as a fail-closed signal. We intentionally do NOT do
 * permissive keyword matching ("looks like it said valid=true") because
 * that opens a prompt-injection vector where a malicious worker output can
 * embed phrases that fool the matcher.
 */
export interface JudgeVerdict {
  valid: boolean
  schemaValid: boolean
  reason: string
}

export function parseJudgeResponse(raw: string): JudgeVerdict | null {
  const clean = raw.replace(/```json\n?|```/g, '').trim()

  // Pull out the first {...} block — models sometimes wrap with prose.
  const jsonMatch = clean.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return null

  let parsed: any
  try {
    parsed = JSON.parse(jsonMatch[0])
  } catch {
    return null
  }

  if (typeof parsed.valid !== 'boolean') return null

  // schemaValid is optional for backward compatibility with older judge
  // prompts. When missing, default to whatever `valid` says — preserves
  // fail-closed semantics (false stays false).
  const schemaValid = typeof parsed.schemaValid === 'boolean'
    ? parsed.schemaValid
    : parsed.valid === true
  const reason = typeof parsed.reason === 'string' ? parsed.reason : ''

  return { valid: parsed.valid, schemaValid, reason }
}

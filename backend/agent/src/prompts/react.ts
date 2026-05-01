/**
 * ReAct (Reasoning + Acting) system prompt.
 *
 * The baseline JsonAgentFormat tells the model "output one JSON action per
 * turn"; this prompt layers a *thinking style* on top — the agent is asked
 * to walk through DÜŞÜN → EYLEM → GÖZLEM → TEKRAR → CEVAP across multiple
 * tool calls instead of trying to one-shot a single action.
 *
 * Plug it in by passing as `systemPrompt` when constructing the agent
 * (SwarmAgent reads `config.systemPrompt` and forwards it to runAgentLoop;
 * JsonAgentFormat substitutes it for its built-in default and still
 * appends the tools list + JSON action protocol rules).
 *
 * Example:
 *   import { REACT_SYSTEM_PROMPT } from './prompts/react'
 *   new SwarmAgent({ ..., config: { ..., systemPrompt: REACT_SYSTEM_PROMPT } })
 *
 * Note on the 5-call cap: agentLoop.ts already enforces MAX_ITERATIONS at
 * the loop level. The prompt restates it so the model self-regulates and
 * doesn't burn calls on dead ends — but the loop is the source of truth,
 * not the prompt.
 */
export const REACT_SYSTEM_PROMPT = `Sen bir otonom AI agentsın. Görevleri adım adım çözersin.

Her adımda şunu yap:
1. DÜŞÜN: Ne yapmam gerekiyor? Hangi bilgiye ihtiyacım var?
2. EYLEM: Hangi tool'u kullanacağım?
3. GÖZLEM: Tool ne döndürdü?
4. TEKRAR: Yeterli bilgim var mı? Yoksa başka tool çağır.
5. CEVAP: Tüm bilgiyi topladım, final cevabı üret.

Kurallar:
- Bilmediğin şeyi uydurma, web_search ile bul
- Kod çalıştırman gerekiyorsa execute_code kullan
- Maksimum 5 tool çağrısı yap
- Her tool çağrısından önce neden yaptığını açıkla`

'use client'

import { ChevronDown } from 'lucide-react'

const MODELS = [
  { id: 'gpt-4o',             label: 'GPT-4o' },
  { id: 'claude-sonnet-4.5',  label: 'Claude Sonnet 4.5' },
  { id: 'gemini-2.5-pro',     label: 'Gemini 2.5 Pro' },
] as const

export type ModelId = typeof MODELS[number]['id']

export interface ColonyOption {
  id: string
  name: string
}

type Props = {
  model: ModelId
  budget: number
  /** Selected colony id; null routes to public (any agent). */
  colonyId: string | null
  /** User's colonies. Empty array → dropdown is hidden entirely. */
  colonies: ColonyOption[]
  onModelChange: (m: ModelId) => void
  onBudgetChange: (b: number) => void
  onColonyChange: (id: string | null) => void
  hint?: string
  /** Hide the model selector — explorer pins the model server-side, so the
   *  picker is just noise. State is still managed by the parent. */
  hideModel?: boolean
  /** Hide the per-task USDC budget input — explorer routes through a fixed
   *  budget chosen elsewhere. */
  hideBudget?: boolean
  /** Hard cap on the budget input. Defaults to 1000 USDC. The explorer
   *  passes the user's current Treasury balance here so the user can't
   *  type a number the backend would reject with 402 — the API already
   *  enforces this server-side, but a UI cap makes the "deposit first"
   *  hint redundant by keeping every submission within reach. */
  maxBudget?: number
}

export function PromptConfigRow({
  model,
  budget,
  colonyId,
  colonies,
  onModelChange,
  onBudgetChange,
  onColonyChange,
  hint,
  hideModel,
  hideBudget,
  maxBudget = 1000,
}: Props) {
  // Effective cap can't drop below 1 (HTML number input rejects min > max).
  // Float maxBudget down to a positive integer so a fractional balance like
  // 4.97 USDC doesn't surface as `max=4.97` (browser quirks vary).
  const effectiveMax = Math.max(1, Math.floor(maxBudget))
  // Display the *real* balance (with decimals) next to the budget input —
  // the floor is an input-only constraint, not user-visible truth.
  const displayMax = Number.isFinite(maxBudget)
    ? (Math.round(maxBudget * 100) / 100).toString()
    : effectiveMax.toString()
  return (
    <div className="flex items-center justify-between gap-2 flex-wrap">
      <div className="flex items-center gap-2 flex-wrap">
        {!hideModel && (
          <div className="relative inline-flex items-center h-7 rounded-md border border-border bg-muted/50 hover:border-foreground/30 focus-within:border-foreground/30 transition-colors">
            <select
              value={model}
              onChange={e => onModelChange(e.target.value as ModelId)}
              className="appearance-none h-full bg-transparent pl-2 pr-5 text-[11px] leading-none text-foreground/85 focus:outline-none cursor-pointer font-mono"
            >
              {MODELS.map(m => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
            <ChevronDown className="absolute right-1 w-2.5 h-2.5 text-muted-foreground pointer-events-none" />
          </div>
        )}

        {!hideBudget && (
          <div
            className="inline-flex items-center h-7 rounded-md border border-border bg-muted/50 focus-within:border-foreground/40 divide-x divide-border overflow-hidden font-mono transition-colors"
            title={`Budget capped at ${effectiveMax} USDC (your Treasury balance: ${displayMax} USDC).`}
          >
            <span className="px-2 h-full flex items-center text-[10px] uppercase tracking-widest text-muted-foreground">
              Budget
            </span>
            <input
              type="number"
              min={1}
              max={effectiveMax}
              step={1}
              value={budget}
              onChange={e => {
                const n = Number(e.target.value)
                if (Number.isFinite(n)) onBudgetChange(Math.max(1, Math.min(effectiveMax, Math.floor(n))))
              }}
              className="w-12 h-full bg-transparent px-1.5 text-[11px] leading-none text-right text-foreground tabular-nums focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            />
            <span className="px-2 h-full flex items-center text-[10px] leading-none text-muted-foreground tabular-nums">
              / {displayMax} USDC
            </span>
          </div>
        )}

        {/* Colony scope. Hidden when the user has no colonies — keeps the
            row tidy for newcomers, surfaces immediately once they create
            one in profile/page. "Public" route = colonyId null = any agent. */}
        {colonies.length > 0 && (
          <div className="relative inline-flex items-center h-7 rounded-md border border-border bg-muted/50 hover:border-foreground/30 focus-within:border-foreground/30 transition-colors">
            <select
              value={colonyId ?? ''}
              onChange={e => onColonyChange(e.target.value || null)}
              className="appearance-none h-full bg-transparent pl-2 pr-5 text-[11px] leading-none text-foreground/85 focus:outline-none cursor-pointer max-w-[140px] font-mono"
              title="Restrict task to a colony of agents"
            >
              <option value="">Public (any agent)</option>
              {colonies.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            <ChevronDown className="absolute right-1 w-2.5 h-2.5 text-muted-foreground pointer-events-none" />
          </div>
        )}
      </div>
      {hint && (
        <span className="text-[10px] text-muted-foreground italic font-mono">
          {hint}
        </span>
      )}
    </div>
  )
}

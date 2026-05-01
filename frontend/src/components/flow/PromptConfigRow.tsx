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
}: Props) {
  return (
    <div className="mt-3 flex items-center justify-between px-1">
      <div className="flex items-center gap-2 flex-wrap">
        {!hideModel && (
          <div className="relative inline-flex items-center h-6 rounded border border-border bg-muted hover:border-foreground/30 focus-within:border-foreground/30">
            <select
              value={model}
              onChange={e => onModelChange(e.target.value as ModelId)}
              className="appearance-none h-full bg-transparent pl-2 pr-5 text-[10px] leading-none text-foreground/80 focus:outline-none cursor-pointer"
            >
              {MODELS.map(m => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
            <ChevronDown className="absolute right-1 w-2.5 h-2.5 text-muted-foreground pointer-events-none" />
          </div>
        )}

        {!hideBudget && (
          <div className="inline-flex items-center h-6 rounded border border-border bg-muted focus-within:border-foreground/30">
            <input
              type="number"
              min={1}
              max={1000}
              step={1}
              value={budget}
              onChange={e => {
                const n = Number(e.target.value)
                if (Number.isFinite(n)) onBudgetChange(Math.max(1, Math.min(1000, Math.floor(n))))
              }}
              className="w-10 h-full bg-transparent px-1.5 text-[10px] leading-none text-right text-foreground/80 focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            />
            <span className="pr-1.5 text-[10px] leading-none text-muted-foreground">USDC</span>
          </div>
        )}

        {/* Colony scope. Hidden when the user has no colonies — keeps the
            row tidy for newcomers, surfaces immediately once they create
            one in profile/page. "Public" route = colonyId null = any agent. */}
        {colonies.length > 0 && (
          <div className="relative inline-flex items-center h-6 rounded border border-border bg-muted hover:border-foreground/30 focus-within:border-foreground/30">
            <select
              value={colonyId ?? ''}
              onChange={e => onColonyChange(e.target.value || null)}
              className="appearance-none h-full bg-transparent pl-2 pr-5 text-[10px] leading-none text-foreground/80 focus:outline-none cursor-pointer max-w-[140px]"
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
      <span className="text-[10px] text-muted-foreground italic">
        {hint ?? 'Press Enter to dispatch'}
      </span>
    </div>
  )
}

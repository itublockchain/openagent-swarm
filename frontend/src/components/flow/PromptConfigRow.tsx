'use client'

import { ChevronDown } from 'lucide-react'

const MODELS = [
  { id: 'gpt-4o',             label: 'GPT-4o' },
  { id: 'claude-sonnet-4.5',  label: 'Claude Sonnet 4.5' },
  { id: 'gemini-2.5-pro',     label: 'Gemini 2.5 Pro' },
] as const

export type ModelId = typeof MODELS[number]['id']

type Props = {
  model: ModelId
  budget: number
  onModelChange: (m: ModelId) => void
  onBudgetChange: (b: number) => void
  hint?: string
}

export function PromptConfigRow({ model, budget, onModelChange, onBudgetChange, hint }: Props) {
  return (
    <div className="mt-3 flex items-center justify-between px-1">
      <div className="flex items-center gap-2">
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
      </div>
      <span className="text-[10px] text-muted-foreground italic">
        {hint ?? 'Press Enter to dispatch'}
      </span>
    </div>
  )
}

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
        <div className="relative">
          <select
            value={model}
            onChange={e => onModelChange(e.target.value as ModelId)}
            className="appearance-none text-[10px] bg-muted text-foreground/80 px-1.5 pr-5 py-0.5 rounded border border-border hover:border-foreground/30 focus:outline-none focus:ring-1 focus:ring-primary/30 cursor-pointer"
          >
            {MODELS.map(m => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
          <ChevronDown className="absolute right-1 top-1/2 -translate-y-1/2 w-2.5 h-2.5 text-muted-foreground pointer-events-none" />
        </div>

        <div className="flex items-center text-[10px] bg-muted text-muted-foreground rounded border border-border focus-within:border-foreground/30">
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
            className="w-10 bg-transparent px-1.5 py-0.5 text-right text-foreground/80 focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          />
          <span className="pr-1.5 text-muted-foreground">USDC</span>
        </div>
      </div>
      <span className="text-[10px] text-muted-foreground italic">
        {hint ?? 'Press Enter to dispatch'}
      </span>
    </div>
  )
}

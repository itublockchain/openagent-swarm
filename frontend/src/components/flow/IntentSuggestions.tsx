'use client'

import { Sparkles } from 'lucide-react'

const SUGGESTIONS = [
  'Research the top AI trends on X this week',
  'Summarize https://arxiv.org/abs/2401.12345',
  'Generate a market report on Solana DeFi',
  'Find the highest-yielding stablecoin pools right now',
]

export function IntentSuggestions({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="px-4 pt-3 pb-2 border-t border-border bg-background/60">
      <div className="flex items-center gap-1.5 mb-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
        <Sparkles className="w-3 h-3" />
        Try one of these
      </div>
      <div className="flex gap-1.5 overflow-x-auto -mx-1 px-1 pb-1 [scrollbar-width:thin]">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onPick(s)}
            className="shrink-0 text-[11px] px-2.5 py-1 rounded-full border border-border bg-muted/40 hover:bg-muted hover:border-foreground/20 text-muted-foreground hover:text-foreground transition-colors whitespace-nowrap"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  )
}

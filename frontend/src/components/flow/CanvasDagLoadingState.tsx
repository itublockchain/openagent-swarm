'use client'

import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Props {
  visible: boolean
  phase: 'broadcasting' | 'awaiting-dag'
}

export function CanvasDagLoadingState({ visible, phase }: Props) {
  const title = phase === 'broadcasting' ? 'Broadcasting intent to SPORE' : 'Creating DAG'
  const subtitle =
    phase === 'broadcasting'
      ? 'Debiting Treasury and submitting to AXL…'
      : 'Planner is decomposing your intent into subtasks…'

  return (
    <div
      aria-hidden={!visible}
      className={cn(
        'absolute inset-0 z-[5] flex items-center justify-center pointer-events-none transition-all duration-300 ease-out',
        visible ? 'opacity-100 scale-100' : 'opacity-0 scale-95',
      )}
    >
      <div className="flex flex-col items-center gap-4">
        <div className="flex items-center gap-3 px-5 py-3 rounded-2xl border border-primary/30 bg-background/85 backdrop-blur-md shadow-lg">
          <div className="relative shrink-0">
            <Loader2 className="w-5 h-5 text-primary animate-spin" />
            <span className="absolute inset-0 rounded-full bg-primary/20 animate-ping" />
          </div>
          <div className="min-w-0">
            <div className="text-[10px] font-bold uppercase tracking-widest text-primary mb-0.5">
              SPORE working
            </div>
            <div className="text-sm font-medium text-foreground/85">{title}</div>
            <div className="text-[11px] text-muted-foreground mt-0.5">{subtitle}</div>
          </div>
        </div>

        {/* Skeleton DAG hint — three pulsing pills wired vertically so the
            user sees "something is being built here" instead of staring at
            an empty grid. */}
        <div className="flex flex-col items-center gap-2 opacity-60">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex flex-col items-center gap-2">
              <div
                className="h-7 w-44 rounded-md border border-border bg-muted/60 animate-pulse"
                style={{ animationDelay: `${i * 150}ms` }}
              />
              {i < 2 && <div className="h-3 w-px bg-border/60" />}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

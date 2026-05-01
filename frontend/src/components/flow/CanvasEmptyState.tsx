'use client'

import { ArrowRight, Loader2 } from 'lucide-react'

interface Props {
  /** Show a spinner + status label instead of the default "submit an intent" pill. */
  isSubmitting?: boolean
  /** Status text shown next to the spinner (only used while isSubmitting). */
  label?: string
}

export function CanvasEmptyState({ isSubmitting, label }: Props = {}) {
  return (
    <div className="absolute inset-0 z-[5] flex items-center justify-center pointer-events-none">
      <div className="flex items-center gap-3 px-4 py-2.5 rounded-full border border-border bg-background/80 backdrop-blur-sm shadow-sm">
        {isSubmitting ? (
          <>
            <Loader2 className="w-4 h-4 text-primary animate-spin" />
            <span className="text-sm font-medium text-foreground/80">
              {label ?? 'Dispatching…'}
            </span>
          </>
        ) : (
          <>
            <span className="text-sm font-medium text-foreground/80">
              Submit an intent to begin
            </span>
            <ArrowRight className="w-4 h-4 text-muted-foreground" />
          </>
        )}
      </div>
    </div>
  )
}

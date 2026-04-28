'use client'

import { ArrowRight } from 'lucide-react'

export function CanvasEmptyState() {
  return (
    <div className="absolute inset-0 z-[5] flex items-center justify-center pointer-events-none">
      <div className="flex items-center gap-3 px-4 py-2.5 rounded-full border border-border bg-background/80 backdrop-blur-sm shadow-sm">
        <span className="text-sm font-medium text-foreground/80">
          Submit an intent to begin
        </span>
        <ArrowRight className="w-4 h-4 text-muted-foreground" />
      </div>
    </div>
  )
}

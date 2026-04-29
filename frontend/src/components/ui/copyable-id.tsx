'use client'

import { useState } from 'react'
import { Copy, Check } from 'lucide-react'
import { cn, shortHash } from '@/lib/utils'

interface Props {
  value: string
  head?: number
  tail?: number
  className?: string
  /** Hide the address text, show only the icon. */
  iconOnly?: boolean
}

export function CopyableId({ value, head = 8, tail = 6, className, iconOnly = false }: Props) {
  const [copied, setCopied] = useState(false)
  const onCopy = async (e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      // ignore
    }
  }
  return (
    <button
      onClick={onCopy}
      title={copied ? 'Copied!' : value}
      aria-label={`Copy ${value}`}
      className={cn(
        'group inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/50 bg-muted/30 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:border-border hover:text-foreground transition-colors',
        className
      )}
    >
      {!iconOnly && <span className="truncate">{shortHash(value, head, tail)}</span>}
      {copied ? (
        <Check className="w-3 h-3 shrink-0 text-green-500" />
      ) : (
        <Copy className="w-3 h-3 shrink-0 opacity-60 group-hover:opacity-100" />
      )}
    </button>
  )
}

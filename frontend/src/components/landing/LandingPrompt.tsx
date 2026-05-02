'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowUp } from 'lucide-react'

export function LandingPrompt() {
  const [prompt, setPrompt] = useState('')
  const router = useRouter()

  const submit = () => {
    const trimmed = prompt.trim()
    if (trimmed) {
      router.push(`/explorer?intent=${encodeURIComponent(trimmed)}`)
    } else {
      router.push('/explorer')
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div className="w-full max-w-2xl mx-auto">
      <div className="relative overflow-hidden rounded-2xl border border-border bg-background/80 backdrop-blur-xl shadow-xl shadow-black/5 transition-colors hover:border-foreground/30">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Describe a task for SPORE."
          rows={1}
          className="w-full resize-none bg-transparent px-5 py-5 pr-16 text-base text-foreground placeholder:text-muted-foreground focus:outline-none min-h-[64px] max-h-[200px]"
          aria-label="Task prompt"
        />
        <button
          type="button"
          onClick={submit}
          disabled={!prompt.trim()}
          className="absolute bottom-3 right-3 flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-all disabled:bg-muted disabled:text-muted-foreground hover:bg-primary/90"
          aria-label="Send to SPORE"
        >
          <ArrowUp className="h-4 w-4" />
        </button>
      </div>
      <p className="mt-3 text-center text-xs text-muted-foreground">
        Press <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono">Enter</kbd> to send,{' '}
        <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono">Shift + Enter</kbd> for new line
      </p>
    </div>
  )
}

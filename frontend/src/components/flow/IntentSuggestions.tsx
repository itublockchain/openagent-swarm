'use client'

import { Sparkles } from 'lucide-react'

const SUGGESTIONS = [
  'Write a simple calculator in Python with add, subtract, multiply, divide',
  'Implement FizzBuzz in JavaScript for numbers 1 to 100',
  'Write a Python function that checks if a string is a palindrome',
  'Create a TypeScript function to reverse a linked list',
  'Implement binary search in Go with a unit test',
  'Write a Bash script that finds the 10 largest files in a directory',
  'Build a React counter component with increment, decrement, and reset',
  'Write a SQL query to get the second-highest salary from an employees table',
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

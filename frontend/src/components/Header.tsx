'use client'

import React from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Rocket } from 'lucide-react'
import { ThemeToggle } from './theme-toggle'

interface Props {
  onDeployClick: () => void
}

export function Header({ onDeployClick }: Props) {
  const searchParams = useSearchParams()
  const taskId = searchParams.get('taskId')
  
  // Persist taskId in navigation links if present
  const tasksHref = taskId ? `/?taskId=${taskId}` : '/'
  const poolHref = taskId ? `/pool?taskId=${taskId}` : '/pool'

  return (
    <header className="h-14 border-b border-border bg-background/95 backdrop-blur px-4 flex items-center justify-between shrink-0 z-50">
      <div className="flex items-center gap-8">
        <Link href={tasksHref} className="font-extrabold tracking-tighter text-lg">
          Swarm Explorer
        </Link>
        <nav className="hidden md:flex items-center gap-6">
          <Link href={tasksHref} className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
            Tasks
          </Link>
          <Link href={poolHref} className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
            Agent Pool
          </Link>
        </nav>
      </div>
      
      <div className="flex items-center gap-3">
        <button
          onClick={onDeployClick}
          className="flex items-center gap-1.5 bg-primary text-primary-foreground text-xs font-semibold px-3 py-1.5 rounded-md hover:bg-primary/90 transition-colors shadow-sm"
        >
          <Rocket className="w-3.5 h-3.5" />
          Deploy Agent
        </button>
        
        <span className="hidden sm:flex items-center gap-1.5 text-xs font-mono bg-green-500/10 text-green-600 dark:text-green-400 px-2 py-1 rounded-md border border-green-500/20">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
          </span>
          AXL Connected
        </span>
        
        <ThemeToggle />
      </div>
    </header>
  )
}

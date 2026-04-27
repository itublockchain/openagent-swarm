'use client'

import React from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Rocket, Wallet, LogOut } from 'lucide-react'
import { ThemeToggle } from './theme-toggle'
import { useAuth } from '../hooks/useAuth'
import { WalletModal } from './WalletModal'
import { useState } from 'react'

interface Props {
  onDeployClick: () => void
}

export function Header({ onDeployClick }: Props) {
  const searchParams = useSearchParams()
  const taskId = searchParams.get('taskId')
  
  const { address, isAuthenticated, signOut } = useAuth()
  const [showWallet, setShowWallet] = useState(false)

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
        {isAuthenticated ? (
          <div className="flex items-center gap-2">
            <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 bg-muted/50 border border-border rounded-md text-xs font-mono text-muted-foreground">
              <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
              {address?.slice(0, 6)}...{address?.slice(-4)}
            </div>
            <button
              onClick={signOut}
              className="p-1.5 hover:bg-muted rounded-md transition-colors text-muted-foreground hover:text-foreground"
              title="Disconnect"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <button
            onClick={() => setShowWallet(true)}
            className="flex items-center gap-1.5 bg-secondary text-secondary-foreground text-xs font-semibold px-3 py-1.5 rounded-md hover:bg-secondary/80 transition-colors shadow-sm border border-border"
          >
            <Wallet className="w-3.5 h-3.5" />
            Connect
          </button>
        )}

        <button
          onClick={onDeployClick}
          className="flex items-center gap-1.5 bg-primary text-primary-foreground text-xs font-semibold px-3 py-1.5 rounded-md hover:bg-primary/90 transition-colors shadow-sm"
        >
          <Rocket className="w-3.5 h-3.5" />
          Deploy Agent
        </button>
        
        <ThemeToggle />
      </div>

      {showWallet && (
        <WalletModal
          onClose={() => setShowWallet(false)}
          onAuthenticated={() => setShowWallet(false)}
        />
      )}
    </header>
  )
}

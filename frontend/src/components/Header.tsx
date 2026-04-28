'use client'

import React, { useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Rocket, Wallet, LogOut, Copy, Check } from 'lucide-react'
import { useBalance, useChainId, useSwitchChain } from 'wagmi'
import { ThemeToggle } from './theme-toggle'
import { useAuth } from '../hooks/useAuth'
import { WalletModal } from './WalletModal'
import { ogTestnet } from '../../lib/wagmi'

interface Props {
  onDeployClick: () => void
}

function formatBalance(value: bigint, decimals: number): string {
  const denom = BigInt(10) ** BigInt(decimals)
  const whole = value / denom
  const frac = value % denom
  if (frac === BigInt(0)) return whole.toString()
  // Show up to 4 fractional digits, trim trailing zeros.
  const fracStr = frac.toString().padStart(decimals, '0').slice(0, 4).replace(/0+$/, '')
  return fracStr ? `${whole}.${fracStr}` : whole.toString()
}

function WalletPill({ address }: { address: `0x${string}` }) {
  const chainId = useChainId()
  const { switchChainAsync } = useSwitchChain()
  const { data: balance } = useBalance({ address, chainId: ogTestnet.id })
  const [copied, setCopied] = useState(false)
  const onCorrectChain = chainId === ogTestnet.id

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      // ignore
    }
  }

  return (
    <div className="hidden sm:flex items-stretch border border-border rounded-md bg-muted/50 text-xs font-mono divide-x divide-border overflow-hidden">
      {onCorrectChain ? (
        <div className="px-2 py-1.5 flex items-center gap-1.5 text-muted-foreground">
          <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
          <span className="hidden md:inline">0G Galileo</span>
        </div>
      ) : (
        <button
          onClick={() => switchChainAsync({ chainId: ogTestnet.id }).catch(() => {})}
          className="px-2 py-1.5 flex items-center gap-1.5 text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors"
          title="Switch to 0G Galileo"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
          <span className="hidden md:inline">Wrong network</span>
        </button>
      )}

      {balance && onCorrectChain && (
        <div className="px-2 py-1.5 flex items-center text-muted-foreground tabular-nums">
          {formatBalance(balance.value, balance.decimals)} {balance.symbol}
        </div>
      )}

      <div className="px-2 py-1.5 flex items-center text-muted-foreground">
        {address.slice(0, 6)}…{address.slice(-4)}
      </div>

      <button
        onClick={copy}
        className="px-2 flex items-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        title={copied ? 'Copied!' : 'Copy address'}
        aria-label="Copy address"
      >
        {copied ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
      </button>
    </div>
  )
}

export function Header({ onDeployClick }: Props) {
  const searchParams = useSearchParams()
  const taskId = searchParams.get('taskId')

  const { address, isAuthenticated, signOut } = useAuth()
  const [showWallet, setShowWallet] = useState(false)

  // Persist taskId in navigation links if present
  const tasksHref = taskId ? `/explorer?taskId=${taskId}` : '/explorer'
  const poolHref = taskId ? `/pool?taskId=${taskId}` : '/pool'

  return (
    <header className="h-14 border-b border-border bg-background/95 backdrop-blur px-4 flex items-center justify-between shrink-0 z-50">
      <div className="flex items-center gap-8">
        <Link href="/" className="font-extrabold tracking-tighter text-lg">
          Swarm
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
        {isAuthenticated && address ? (
          <div className="flex items-center gap-2">
            <WalletPill address={address as `0x${string}`} />
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

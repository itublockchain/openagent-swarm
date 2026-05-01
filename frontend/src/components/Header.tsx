'use client'

import React, { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { ArrowDownToLine, ArrowUpFromLine, Copy, Check, LogOut, Rocket, Wallet } from 'lucide-react'
import { useChainId, useReadContract, useSwitchChain } from 'wagmi'
import { ThemeToggle } from './theme-toggle'
import { useAuth } from '../hooks/useAuth'
import { WalletModal } from './WalletModal'
import { DepositModal } from './DepositModal'
import { WithdrawModal } from './WithdrawModal'
import { ERC20_ABI, CONTRACT_ADDRESSES } from '@/lib/contracts'
import { paymentChain } from '../../lib/wagmi'
import { apiRequest } from '../../lib/api'

const USDC_DECIMALS = 6

function fmtUsdcRaw(raw: bigint | undefined): string {
  if (raw == null) return '…'
  const denom = BigInt(10) ** BigInt(USDC_DECIMALS)
  const whole = raw / denom
  const frac = raw % denom
  const fracStr = frac.toString().padStart(USDC_DECIMALS, '0').slice(0, 2)
  return `${whole}.${fracStr}`
}

interface Props {
  onDeployClick: () => void
}

const BALANCE_REFRESH_MS = 12_000

function WalletPill({
  address,
  balance,
  onDeposit,
  onWithdraw,
}: {
  address: `0x${string}`
  balance: string | null
  onDeposit: () => void
  onWithdraw: () => void
}) {
  const chainId = useChainId()
  const { switchChainAsync } = useSwitchChain()
  const [copied, setCopied] = useState(false)
  const onCorrectChain = chainId === paymentChain.id

  // Real wallet USDC on Base Sepolia. Pinned to paymentChain.id so it
  // reads from Base regardless of which chain the wallet is currently
  // selected on — without the pin, `balanceOf` runs against e.g. mainnet
  // where this address has no contract and quietly returns 0.
  const usdcAddr = CONTRACT_ADDRESSES.usdc
  const walletUsdcQ = useReadContract({
    abi: ERC20_ABI,
    address: usdcAddr,
    chainId: paymentChain.id,
    functionName: 'balanceOf',
    args: [address],
    query: { enabled: !!usdcAddr, refetchInterval: 12_000 },
  })
  const walletUsdc = fmtUsdcRaw(walletUsdcQ.data as bigint | undefined)

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
          <span className="hidden md:inline">Base Sepolia</span>
        </div>
      ) : (
        <button
          onClick={() => switchChainAsync({ chainId: paymentChain.id }).catch(() => {})}
          className="px-2 py-1.5 flex items-center gap-1.5 text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors"
          title="Switch to Base Sepolia"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
          <span className="hidden md:inline">Wrong network</span>
        </button>
      )}

      {/* Two stacked balances: in-app Treasury (what every action spends
          from) and the user's raw wallet USDC on Base Sepolia. Showing
          both prevents the "I have USDC, why does it say 0?" confusion —
          the answer is "your wallet has it; click ⬇️ to deposit into the
          Treasury". */}
      <div
        className="px-2 py-1 flex flex-col items-end justify-center text-[10px] font-mono leading-tight tabular-nums"
        title="Treasury = in-app balance (spent by tasks / agents). Wallet = raw Base Sepolia USDC. Deposit ⬇️ moves wallet → Treasury."
      >
        <span className="text-foreground">
          <span className="opacity-50 mr-1">treasury</span>
          {balance ?? '…'}
        </span>
        <span className="text-muted-foreground/80">
          <span className="opacity-50 mr-1">wallet</span>
          {walletUsdc}
        </span>
      </div>

      <button
        onClick={onDeposit}
        className="px-2 flex items-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        title="Deposit USDC from your wallet into the Treasury"
      >
        <ArrowDownToLine className="w-3 h-3" />
      </button>
      <button
        onClick={onWithdraw}
        className="px-2 flex items-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        title="Withdraw USDC"
      >
        <ArrowUpFromLine className="w-3 h-3" />
      </button>

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
  const [showDeposit, setShowDeposit] = useState(false)
  const [showWithdraw, setShowWithdraw] = useState(false)
  const [balance, setBalance] = useState<string | null>(null)

  const refreshBalance = useCallback(async () => {
    if (!isAuthenticated) {
      setBalance(null)
      return
    }
    try {
      const res = await apiRequest('/v1/me/balance')
      if (!res.ok) {
        setBalance(null)
        return
      }
      const data = (await res.json()) as { balance: string }
      const num = Number(data.balance)
      setBalance(Number.isFinite(num) ? num.toFixed(2) : data.balance)
    } catch {
      setBalance(null)
    }
  }, [isAuthenticated])

  useEffect(() => {
    refreshBalance()
    if (!isAuthenticated) return
    const t = setInterval(refreshBalance, BALANCE_REFRESH_MS)
    return () => clearInterval(t)
  }, [isAuthenticated, refreshBalance])

  // Persist taskId in navigation links if present
  const tasksHref = taskId ? `/explorer?taskId=${taskId}` : '/explorer'
  const poolHref = taskId ? `/pool?taskId=${taskId}` : '/pool'

  return (
    <header className="h-14 border-b border-border bg-background/95 backdrop-blur px-4 flex items-center justify-between shrink-0 z-50">
      <div className="flex items-center gap-8">
        <Link href="/" className="font-extrabold tracking-tighter text-lg">
          SPORE
        </Link>
        <nav className="hidden md:flex items-center gap-6">
          <Link href={tasksHref} className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
            Tasks
          </Link>
          <Link href={poolHref} className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
            Agent Pool
          </Link>
          <Link href="/developer" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
            Developer
          </Link>
          <Link href="/profile" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
            Profile
          </Link>
        </nav>
      </div>

      <div className="flex items-center gap-3">
        {isAuthenticated && address ? (
          <div className="flex items-center gap-2">
            <WalletPill
              address={address as `0x${string}`}
              balance={balance}
              onDeposit={() => setShowDeposit(true)}
              onWithdraw={() => setShowWithdraw(true)}
            />
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
      {showDeposit && (
        <DepositModal
          onClose={() => setShowDeposit(false)}
          onSuccess={() => {
            refreshBalance()
            setShowDeposit(false)
          }}
        />
      )}
      {showWithdraw && balance != null && (
        <WithdrawModal
          balance={balance}
          onClose={() => setShowWithdraw(false)}
          onSuccess={() => {
            refreshBalance()
            // Don't auto-close — let the user see the tx hashes.
          }}
        />
      )}
    </header>
  )
}

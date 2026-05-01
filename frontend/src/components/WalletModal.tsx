'use client'

import { useAuth } from '../hooks/useAuth'
import { useState } from 'react'
import { ShieldCheck, Loader2, AlertCircle, Wallet } from 'lucide-react'

interface Props {
  onClose: () => void
  onAuthenticated: () => void
}

export function WalletModal({ onClose, onAuthenticated }: Props) {
  const {
    address,
    isConnected,
    isAuthenticated,
    isAuthenticating,
    connectors,
    connect,
    isPending,
    signIn,
  } = useAuth()

  const [error, setError] = useState<string | null>(null)

  // Pick whichever injected wallet the user actually has. EIP-6963 makes
  // MetaMask, Rabby, Coinbase etc. each register as a distinct connector,
  // so we prefer any injected provider over the WalletConnect/SDK fallbacks.
  // Last resort: connectors[0], so the connect button is never inert.
  const primaryConnector =
    connectors.find(c => c.type === 'injected') ||
    connectors.find(c => c.id !== 'walletConnect' && c.id !== 'metaMaskSDK') ||
    connectors[0]

  const handleAction = async () => {
    setError(null)
    if (!isConnected) {
      if (primaryConnector) {
        connect({ connector: primaryConnector })
      } else {
        setError('No wallet detected. Install MetaMask, Rabby, or another EVM wallet and refresh.')
      }
    } else {
      try {
        await signIn()
        onAuthenticated()
        onClose()
      } catch (err) {
        setError('Authentication failed. Please try again.')
      }
    }
  }

  return (
    <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-8 shadow-2xl animate-in zoom-in-95 duration-200">
      <div className="flex flex-col items-center text-center mb-10">
        <div className="w-16 h-16 bg-primary/5 rounded-full flex items-center justify-center mb-6 border border-primary/10">
          <ShieldCheck className="w-8 h-8 text-primary" />
        </div>
        <h2 className="text-2xl font-bold tracking-tight text-foreground">SPORE Gateway</h2>
        <p className="text-sm text-muted-foreground mt-2">
          {isConnected ? 'Verify your identity to proceed' : 'Connect your wallet to get started'}
        </p>
      </div>

      <div className="space-y-6">
        <button
          onClick={handleAction}
          disabled={isPending || isAuthenticating}
          className="w-full relative flex items-center justify-center gap-3 px-6 py-4 bg-primary text-primary-foreground rounded-xl font-bold text-base transition-all hover:scale-[1.02] active:scale-[0.98] shadow-lg disabled:opacity-70 disabled:hover:scale-100"
        >
          {isPending || isAuthenticating ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              <span>{isPending ? 'Connecting...' : 'Signing...'}</span>
            </>
          ) : (
            <>
              {!isConnected ? (
                <>
                  <Wallet className="w-5 h-5" />
                  <span>Connect Wallet</span>
                </>
              ) : (
                <>
                  <ShieldCheck className="w-5 h-5" />
                  <span>Sign & Enter</span>
                </>
              )}
            </>
          )}
        </button>

        {isConnected && !isAuthenticating && (
          <div className="text-center">
            <p className="text-[10px] font-mono text-muted-foreground bg-muted/30 px-3 py-1 rounded-full inline-block border border-border">
              {address?.slice(0, 6)}...{address?.slice(-4)}
            </p>
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 p-4 bg-destructive/10 border border-destructive/20 rounded-xl text-destructive text-xs animate-in fade-in slide-in-from-top-1">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </div>

      <div className="mt-12 text-center pt-6 border-t border-border/50">
        <p className="text-[10px] text-muted-foreground uppercase tracking-[0.2em] font-bold opacity-30">
          Identity Secured by SPORE
        </p>
      </div>
    </div>
  )
}

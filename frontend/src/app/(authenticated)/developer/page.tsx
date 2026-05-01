'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAccount, useChainId, useReadContract, useSwitchChain, useWriteContract } from 'wagmi'
import { readContract } from '@wagmi/core'
import { Copy, Check, Key as KeyIcon, Plus, Trash2, AlertTriangle, Wallet, ShieldAlert } from 'lucide-react'
import { Header } from '@/components/Header'
import { DeployAgentModal } from '@/components/DeployAgentModal'
import { CopyableId } from '@/components/ui/copyable-id'
import { cn } from '@/lib/utils'
import { ConfirmModal } from '@/components/ConfirmModal'
import { ERC20_ABI, SWARM_TREASURY_ABI, CONTRACT_ADDRESSES } from '@/lib/contracts'
import { config as wagmiConfig, ogTestnet } from '../../../../lib/wagmi'
import { apiRequest } from '../../../../lib/api'
import { waitTxOrVerify } from '../../../../lib/tx'

/** Unwrap an unknown error into a string. ethers v6 stamps shortMessage
 *  on revert errors and that's almost always the friendliest thing to
 *  show; fall back to plain message, then String(). */
function errMsg(e: unknown): string {
  if (e && typeof e === 'object') {
    const obj = e as { shortMessage?: unknown; message?: unknown }
    if (typeof obj.shortMessage === 'string') return obj.shortMessage
    if (typeof obj.message === 'string') return obj.message
  }
  return String(e)
}

type Scope = 'tasks:submit' | 'tasks:read' | 'agents:read'

interface ApiKey {
  id: string
  userAddress: string
  scopes: Scope[]
  name: string | null
  prefix: string
  createdAt: string
  lastUsedAt: string | null
  frozenAt: string | null
  revokedAt: string | null
}

interface CreatedKeyResponse extends ApiKey {
  key: string                 // plaintext, shown ONCE
  chainKeyHash: `0x${string}` // bytes32, used in Treasury.bindKey
}

const ALL_SCOPES: { value: Scope; label: string; help: string }[] = [
  { value: 'tasks:submit', label: 'Submit tasks',   help: 'Spend Treasury balance to create new tasks' },
  { value: 'tasks:read',   label: 'Read task state', help: 'Poll task status + final results' },
  { value: 'agents:read',  label: 'Read agent pool', help: 'List active agents in the swarm' },
]

export default function DeveloperPage() {
  const { address, isConnected } = useAccount()
  const chainId = useChainId()
  const { switchChainAsync } = useSwitchChain()
  const { writeContractAsync } = useWriteContract()
  const [isDeployOpen, setIsDeployOpen] = useState(false)

  const treasuryAddr = CONTRACT_ADDRESSES.treasury
  const usdcAddr = CONTRACT_ADDRESSES.usdc

  const onCorrectChain = chainId === ogTestnet.id

  // ---------- on-chain reads ----------
  const balanceQ = useReadContract({
    abi: SWARM_TREASURY_ABI,
    address: treasuryAddr,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: !!treasuryAddr && !!address && onCorrectChain, refetchInterval: 8_000 },
  })
  const dailyCapQ = useReadContract({
    abi: SWARM_TREASURY_ABI,
    address: treasuryAddr,
    functionName: 'dailyCap',
    args: address ? [address] : undefined,
    query: { enabled: !!treasuryAddr && !!address && onCorrectChain, refetchInterval: 30_000 },
  })
  const dailySpentQ = useReadContract({
    abi: SWARM_TREASURY_ABI,
    address: treasuryAddr,
    functionName: 'dailySpentView',
    args: address ? [address] : undefined,
    query: { enabled: !!treasuryAddr && !!address && onCorrectChain, refetchInterval: 8_000 },
  })
  const decimalsQ = useReadContract({
    abi: ERC20_ABI,
    address: usdcAddr,
    functionName: 'decimals',
    query: { enabled: !!usdcAddr },
  })
  const decimals = decimalsQ.data ?? 18

  const fmt = (n: bigint | undefined) => (n == null ? '—' : formatUnits(n, decimals))

  // ---------- API key list ----------
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [keysLoaded, setKeysLoaded] = useState(false)
  const [keysError, setKeysError] = useState<string | null>(null)

  const reloadKeys = useCallback(async () => {
    try {
      const res = await apiRequest('/v1/keys')
      if (!res.ok) throw new Error(`list failed (${res.status})`)
      const data = (await res.json()) as { keys: ApiKey[] }
      setKeys(data.keys)
      setKeysError(null)
    } catch (e) {
      setKeysError(errMsg(e))
    } finally {
      setKeysLoaded(true)
    }
  }, [])

  useEffect(() => {
    if (!isConnected) return
    reloadKeys()
  }, [isConnected, reloadKeys])

  // ---------- Generate key flow ----------
  const [creating, setCreating] = useState(false)
  const [genName, setGenName] = useState('')
  const [genScopes, setGenScopes] = useState<Set<Scope>>(new Set(['tasks:submit', 'tasks:read']))
  const [createdKey, setCreatedKey] = useState<CreatedKeyResponse | null>(null)
  const [bindStep, setBindStep] = useState<'idle' | 'awaiting-sign' | 'mining' | 'done' | 'error'>('idle')
  const [bindError, setBindError] = useState<string | null>(null)
  const [confirmState, setConfirmState] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
    isDestructive?: boolean;
    confirmText?: string;
  }>({ isOpen: false, title: '', message: '', onConfirm: () => {} })

  const toggleScope = (s: Scope) =>
    setGenScopes(prev => {
      const next = new Set(prev)
      if (next.has(s)) next.delete(s)
      else next.add(s)
      return next
    })

  const generateKey = async () => {
    setCreating(true)
    try {
      const res = await apiRequest('/v1/keys', {
        method: 'POST',
        body: JSON.stringify({
          name: genName.trim() || undefined,
          scopes: Array.from(genScopes),
        }),
      })
      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        throw new Error(e.error ?? `create failed (${res.status})`)
      }
      const data = (await res.json()) as CreatedKeyResponse
      setCreatedKey(data)
      setGenName('')
      setBindStep('idle')
      setBindError(null)
      await reloadKeys()
    } catch (e) {
      alert(errMsg(e))
    } finally {
      setCreating(false)
    }
  }

  // After the user copies the plaintext, ask them to sign Treasury.bindKey
  // so the on-chain freeze/spend gate is wired to their wallet.
  const bindCreatedKey = async () => {
    if (!createdKey || !treasuryAddr) return
    setBindError(null)
    setBindStep('awaiting-sign')
    try {
      if (chainId !== ogTestnet.id) {
        await switchChainAsync({ chainId: ogTestnet.id })
      }
      const tx = await writeContractAsync({
        abi: SWARM_TREASURY_ABI,
        address: treasuryAddr,
        functionName: 'bindKey',
        args: [createdKey.chainKeyHash],
        chainId: ogTestnet.id,
      })
      setBindStep('mining')
      // Verify path — Treasury.keyOwner(keyHash) flips to the user's
      // address atomically with bindKey. Idempotent, no pre-state needed.
      await waitTxOrVerify(tx, async () => {
        if (!address) return false
        const owner = (await readContract(wagmiConfig, {
          abi: SWARM_TREASURY_ABI,
          address: treasuryAddr,
          functionName: 'keyOwner',
          args: [createdKey.chainKeyHash],
        })) as `0x${string}`
        return owner.toLowerCase() === address.toLowerCase()
      })
      setBindStep('done')
    } catch (e) {
      setBindStep('error')
      setBindError(errMsg(e))
    }
  }

  // ---------- Deposit / Withdraw / Cap actions ----------
  const [depositInput, setDepositInput] = useState('')
  const [withdrawInput, setWithdrawInput] = useState('')
  const [capInput, setCapInput] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const ensureChain = async () => {
    if (chainId !== ogTestnet.id) await switchChainAsync({ chainId: ogTestnet.id })
  }

  const onDeposit = async () => {
    if (!treasuryAddr || !usdcAddr || !address) return
    if (!depositInput.match(/^\d+(\.\d+)?$/)) {
      setActionError('Deposit must be a positive decimal')
      return
    }
    const amount = parseUnits(depositInput, decimals)
    if (amount === BigInt(0)) {
      setActionError('Amount must be > 0')
      return
    }
    setBusy('deposit')
    setActionError(null)
    try {
      await ensureChain()

      // Skip approve if existing allowance already covers this deposit.
      const allowance = (await readContract(wagmiConfig, {
        abi: ERC20_ABI,
        address: usdcAddr,
        functionName: 'allowance',
        args: [address, treasuryAddr],
      })) as bigint
      if (allowance < amount) {
        const approveTx = await writeContractAsync({
          abi: ERC20_ABI,
          address: usdcAddr,
          functionName: 'approve',
          args: [treasuryAddr, amount],
          chainId: ogTestnet.id,
        })
        // Verify approve landed by re-reading allowance.
        await waitTxOrVerify(approveTx, async () => {
          if (!address) return false
          const a = (await readContract(wagmiConfig, {
            abi: ERC20_ABI,
            address: usdcAddr,
            functionName: 'allowance',
            args: [address, treasuryAddr],
          })) as bigint
          return a >= amount
        })
      }

      // Snapshot balance pre-deposit so we can detect "tx landed" via
      // delta even when receipt poll misses.
      const balBefore = address
        ? ((await readContract(wagmiConfig, {
            abi: SWARM_TREASURY_ABI,
            address: treasuryAddr,
            functionName: 'balanceOf',
            args: [address],
          })) as bigint)
        : BigInt(0)

      const depositTx = await writeContractAsync({
        abi: SWARM_TREASURY_ABI,
        address: treasuryAddr,
        functionName: 'deposit',
        args: [amount],
        chainId: ogTestnet.id,
      })
      await waitTxOrVerify(depositTx, async () => {
        if (!address) return false
        const balAfter = (await readContract(wagmiConfig, {
          abi: SWARM_TREASURY_ABI,
          address: treasuryAddr,
          functionName: 'balanceOf',
          args: [address],
        })) as bigint
        return balAfter >= balBefore + amount
      })
      setDepositInput('')
      balanceQ.refetch()
    } catch (e) {
      setActionError(errMsg(e))
    } finally {
      setBusy(null)
    }
  }

  const onWithdraw = async () => {
    if (!treasuryAddr) return
    if (!withdrawInput.match(/^\d+(\.\d+)?$/)) {
      setActionError('Withdraw must be a positive decimal')
      return
    }
    const amount = parseUnits(withdrawInput, decimals)
    setBusy('withdraw')
    setActionError(null)
    try {
      await ensureChain()
      const balBefore = address
        ? ((await readContract(wagmiConfig, {
            abi: SWARM_TREASURY_ABI,
            address: treasuryAddr,
            functionName: 'balanceOf',
            args: [address],
          })) as bigint)
        : BigInt(0)

      const tx = await writeContractAsync({
        abi: SWARM_TREASURY_ABI,
        address: treasuryAddr,
        functionName: 'withdraw',
        args: [amount],
        chainId: ogTestnet.id,
      })
      await waitTxOrVerify(tx, async () => {
        if (!address) return false
        const balAfter = (await readContract(wagmiConfig, {
          abi: SWARM_TREASURY_ABI,
          address: treasuryAddr,
          functionName: 'balanceOf',
          args: [address],
        })) as bigint
        // Tolerate rounding from balBefore being read before withdraw —
        // success means balance dropped by at least `amount`.
        return balBefore - balAfter >= amount
      })
      setWithdrawInput('')
      balanceQ.refetch()
    } catch (e) {
      setActionError(errMsg(e))
    } finally {
      setBusy(null)
    }
  }

  const onSetCap = async () => {
    if (!treasuryAddr) return
    if (!capInput.match(/^\d+(\.\d+)?$/)) {
      setActionError('Cap must be 0 or a positive decimal')
      return
    }
    const cap = parseUnits(capInput, decimals)
    setBusy('cap')
    setActionError(null)
    try {
      await ensureChain()
      const tx = await writeContractAsync({
        abi: SWARM_TREASURY_ABI,
        address: treasuryAddr,
        functionName: 'setDailyCap',
        args: [cap],
        chainId: ogTestnet.id,
      })
      // Verify cap landed by re-reading. Idempotent — exact match.
      await waitTxOrVerify(tx, async () => {
        if (!address) return false
        const c = (await readContract(wagmiConfig, {
          abi: SWARM_TREASURY_ABI,
          address: treasuryAddr,
          functionName: 'dailyCap',
          args: [address],
        })) as bigint
        return c === cap
      })
      setCapInput('')
      dailyCapQ.refetch()
    } catch (e) {
      setActionError(errMsg(e))
    } finally {
      setBusy(null)
    }
  }

  // ---------- Key freeze/revoke ----------
  const onFreeze = () => {
    // We need the chain hash of the key to freeze it on-chain. The DB
    // stores it but we don't currently expose it in the list response —
    // freeze is best-effort via a separate fetch. For MVP we surface a
    // hint and let the user revoke server-side instead.
    alert('On-chain freeze requires the chain key hash, which is only shown at creation. Use Revoke to disable the key server-side.')
  }

  const onRevoke = async (k: ApiKey) => {
    setConfirmState({
      isOpen: true,
      title: 'Revoke API Key',
      message: `Are you sure you want to revoke key "${k.name ?? k.prefix}"? This action cannot be undone and any application using this key will lose access immediately.`,
      isDestructive: true,
      confirmText: 'Revoke Key',
      onConfirm: async () => {
        setConfirmState(prev => ({ ...prev, isOpen: false }))
        try {
          const res = await apiRequest(`/v1/keys/${k.id}`, { method: 'DELETE' })
          if (!res.ok) throw new Error(`revoke failed (${res.status})`)
          await reloadKeys()
        } catch (e) {
          alert(errMsg(e))
        }
      }
    })
  }

  const visibleKeys = keys.filter(k => !k.revokedAt)

  // ---------- Render ----------
  if (!treasuryAddr) {
    return (
      <div className="flex flex-col h-full bg-background text-foreground overflow-hidden">
        <Header onDeployClick={() => setIsDeployOpen(true)} />
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="max-w-md text-center space-y-3">
            <ShieldAlert className="w-10 h-10 mx-auto text-yellow-500" />
            <h2 className="text-lg font-bold">Treasury contract not configured</h2>
            <p className="text-sm text-muted-foreground">
              Set <code className="font-mono bg-muted px-1.5 py-0.5 rounded">NEXT_PUBLIC_TREASURY_ADDRESS</code> in your frontend env to the deployed
              SwarmTreasury address. The Developer tab needs it for deposits, withdrawals, and key bindings.
            </p>
          </div>
        </div>
        <DeployAgentModal isOpen={isDeployOpen} onClose={() => setIsDeployOpen(false)} onSuccess={() => {}} />
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full bg-background text-foreground overflow-hidden">
      <Header onDeployClick={() => setIsDeployOpen(true)} />

      <main className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto px-6 py-8 space-y-8">
          <header className="space-y-1">
            <h1 className="text-2xl font-bold tracking-tight">Developer</h1>
            <p className="text-sm text-muted-foreground">
              Generate API keys, fund your Treasury balance, and manage spending caps for the Spore SDK.
            </p>
          </header>

          {/* Balance + cap panel */}
          <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Stat label="Treasury balance" value={fmt(balanceQ.data as bigint | undefined)} unit="USDC" />
            <Stat label="Daily cap" value={dailyCapQ.data === BigInt(0) ? 'Unlimited' : fmt(dailyCapQ.data as bigint | undefined)} unit="USDC" />
            <Stat
              label="Spent today"
              value={fmt(((dailySpentQ.data as readonly [bigint, bigint] | undefined)?.[0]))}
              unit="USDC"
              hint={dailyCapQ.data && dailyCapQ.data !== BigInt(0)
                ? `${fmtPct(((dailySpentQ.data as readonly [bigint, bigint] | undefined)?.[0] ?? BigInt(0)), dailyCapQ.data as bigint)} of cap`
                : undefined}
            />
          </section>

          {/* Deposit / withdraw / cap controls */}
          <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <ActionCard
              label="Deposit"
              hint="Pull USDC from your wallet into Treasury. Approves first if needed."
              cta={busy === 'deposit' ? 'Working…' : 'Deposit'}
              disabled={!isConnected || busy !== null || !depositInput}
              value={depositInput}
              onChange={setDepositInput}
              onSubmit={onDeposit}
              suffix="USDC"
            />
            <ActionCard
              label="Withdraw"
              hint="Pull USDC back to your wallet. Always available — never paused."
              cta={busy === 'withdraw' ? 'Working…' : 'Withdraw'}
              disabled={!isConnected || busy !== null || !withdrawInput}
              value={withdrawInput}
              onChange={setWithdrawInput}
              onSubmit={onWithdraw}
              suffix="USDC"
            />
            <ActionCard
              label="Daily spend cap"
              hint="Bound the operator's spend per 24h. Set 0 for unlimited."
              cta={busy === 'cap' ? 'Working…' : 'Update cap'}
              disabled={!isConnected || busy !== null || capInput === ''}
              value={capInput}
              onChange={setCapInput}
              onSubmit={onSetCap}
              suffix="USDC / day"
            />
          </section>

          {actionError && (
            <div className="px-4 py-2 rounded-md border border-red-500/30 bg-red-500/10 text-sm text-red-500 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span className="break-words">{actionError}</span>
            </div>
          )}

          {!onCorrectChain && isConnected && (
            <div className="px-4 py-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 text-sm text-yellow-600 dark:text-yellow-400 flex items-start gap-2">
              <Wallet className="w-4 h-4 shrink-0 mt-0.5" />
              <span>Wallet is on a different network. Switch to 0G Galileo (chainId {ogTestnet.id}) before any treasury action.</span>
            </div>
          )}

          {/* API keys */}
          <section className="space-y-4">
            <div className="flex items-end justify-between gap-4 flex-wrap">
              <div>
                <h2 className="text-lg font-semibold">API keys</h2>
                <p className="text-xs text-muted-foreground mt-1">
                  Plaintext is shown once at creation. After that, only the prefix is visible.
                </p>
              </div>
            </div>

            <div className="rounded-xl border border-border bg-card p-4 space-y-3">
              <div className="flex flex-col md:flex-row gap-2">
                <input
                  type="text"
                  placeholder="Key name (e.g. production-server)"
                  value={genName}
                  onChange={e => setGenName(e.target.value)}
                  maxLength={80}
                  className="flex-1 px-3 py-2 rounded-md border border-input bg-background text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <button
                  onClick={generateKey}
                  disabled={creating || genScopes.size === 0}
                  className="inline-flex items-center justify-center gap-1.5 bg-primary text-primary-foreground text-sm font-semibold px-4 py-2 rounded-md hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Plus className="w-4 h-4" />
                  {creating ? 'Generating…' : 'Generate key'}
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {ALL_SCOPES.map(s => {
                  const on = genScopes.has(s.value)
                  return (
                    <button
                      key={s.value}
                      onClick={() => toggleScope(s.value)}
                      title={s.help}
                      className={cn(
                        'text-[11px] font-mono uppercase tracking-wider px-2 py-1 rounded border transition-colors',
                        on
                          ? 'border-primary/40 bg-primary/10 text-primary'
                          : 'border-border bg-background text-muted-foreground hover:text-foreground hover:border-foreground/40',
                      )}
                    >
                      {on ? '✓ ' : ''}{s.label}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Existing keys list */}
            {!keysLoaded ? (
              <div className="space-y-2">
                {Array.from({ length: 2 }).map((_, i) => (
                  <div key={i} className="h-16 rounded-lg bg-muted/30 animate-pulse" />
                ))}
              </div>
            ) : keysError ? (
              <div className="text-sm text-red-500">{keysError}</div>
            ) : visibleKeys.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border bg-muted/20 px-6 py-10 text-center text-sm text-muted-foreground">
                No keys yet. Generate one above to start using the SDK.
              </div>
            ) : (
              <ul className="space-y-2">
                {visibleKeys.map(k => (
                  <li key={k.id} className="rounded-lg border border-border bg-card px-4 py-3 flex flex-col md:flex-row md:items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <KeyIcon className="w-3.5 h-3.5 text-muted-foreground" />
                        <span className="font-semibold text-sm truncate">{k.name ?? '(unnamed)'}</span>
                        <span className="font-mono text-[11px] text-muted-foreground">{k.prefix}</span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-mono text-muted-foreground">
                        <span>created {new Date(k.createdAt).toLocaleDateString()}</span>
                        {k.lastUsedAt && <span>last used {new Date(k.lastUsedAt).toLocaleDateString()}</span>}
                        <span>{k.scopes.length} scope{k.scopes.length === 1 ? '' : 's'}</span>
                        {k.frozenAt && <span className="text-yellow-500">frozen</span>}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => onFreeze()}
                        className="text-xs px-2 py-1.5 rounded border border-border hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                        title="Freeze on-chain (requires saved chain hash)"
                      >
                        Freeze
                      </button>
                      <button
                        onClick={() => onRevoke(k)}
                        className="inline-flex items-center gap-1 text-xs px-2 py-1.5 rounded border border-red-500/30 text-red-500 hover:bg-red-500/10 transition-colors"
                      >
                        <Trash2 className="w-3 h-3" />
                        Revoke
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </main>

      {/* One-time plaintext modal */}
      {createdKey && (
        <OneTimeKeyModal
          created={createdKey}
          bindStep={bindStep}
          bindError={bindError}
          onBind={bindCreatedKey}
          onClose={() => {
            if (bindStep !== 'done') {
              setConfirmState({
                isOpen: true,
                title: 'Close without binding?',
                message: 'The on-chain bind transaction is not confirmed yet. If you close now, this key will work for API requests but will not be able to spend Treasury balance. You can re-run bindKey manually later.',
                confirmText: 'Close Anyway',
                onConfirm: () => {
                  setConfirmState(prev => ({ ...prev, isOpen: false }))
                  setCreatedKey(null)
                  reloadKeys()
                }
              })
              return
            }
            setCreatedKey(null)
            reloadKeys()
          }}
        />
      )}

      <DeployAgentModal isOpen={isDeployOpen} onClose={() => setIsDeployOpen(false)} onSuccess={() => {}} />

      <ConfirmModal
        isOpen={confirmState.isOpen}
        title={confirmState.title}
        message={confirmState.message}
        confirmText={confirmState.confirmText}
        isDestructive={confirmState.isDestructive}
        onConfirm={confirmState.onConfirm}
        onClose={() => setConfirmState(prev => ({ ...prev, isOpen: false }))}
      />
    </div>
  )
}

// ============================================================
// Sub-components
// ============================================================

function Stat({ label, value, unit, hint }: { label: string; value: string; unit?: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="text-2xl font-bold tabular-nums">{value}</span>
        {unit && <span className="text-xs text-muted-foreground">{unit}</span>}
      </div>
      {hint && <div className="mt-1 text-[10px] text-muted-foreground">{hint}</div>}
    </div>
  )
}

function ActionCard({
  label, hint, cta, value, onChange, onSubmit, disabled, suffix,
}: {
  label: string
  hint: string
  cta: string
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  disabled: boolean
  suffix: string
}) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3 space-y-2">
      <div className="text-sm font-semibold">{label}</div>
      <div className="text-[11px] text-muted-foreground leading-snug">{hint}</div>
      <div className="flex items-center gap-2">
        <input
          type="number"
          inputMode="decimal"
          min="0"
          step="any"
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder="0"
          className="flex-1 px-2 py-1.5 rounded-md border border-input bg-background text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground whitespace-nowrap">{suffix}</span>
      </div>
      <button
        onClick={onSubmit}
        disabled={disabled}
        className="w-full text-xs font-semibold px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {cta}
      </button>
    </div>
  )
}

function OneTimeKeyModal({
  created, bindStep, bindError, onBind, onClose,
}: {
  created: CreatedKeyResponse
  bindStep: 'idle' | 'awaiting-sign' | 'mining' | 'done' | 'error'
  bindError: string | null
  onBind: () => void
  onClose: () => void
}) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(created.key)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-background/80 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg rounded-xl border border-border bg-card p-6 space-y-4">
        <div className="flex items-start gap-2">
          <KeyIcon className="w-5 h-5 text-primary shrink-0 mt-0.5" />
          <div>
            <h2 className="text-lg font-bold">New API key — save it now</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              This is the only time the full key is shown. After closing this dialog, only the prefix is recoverable.
            </p>
          </div>
        </div>

        <div className="font-mono text-[11px] break-all rounded-lg bg-muted px-3 py-2 select-all">
          {created.key}
        </div>
        <button
          onClick={copy}
          className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border border-border hover:bg-muted transition-colors"
        >
          {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
          {copied ? 'Copied' : 'Copy plaintext'}
        </button>

        <div className="border-t border-border pt-4 space-y-2">
          <div className="text-sm font-semibold flex items-center gap-1.5">
            <ShieldAlert className="w-4 h-4 text-yellow-500" />
            Bind this key on-chain
          </div>
          <p className="text-[11px] text-muted-foreground leading-snug">
            Treasury enforces freeze/spend rules on the keyHash bound to your wallet. Until you sign this transaction the key works server-side but
            <span className="font-semibold"> the SDK cannot spend</span> from your balance with it.
          </p>
          <div className="text-[10px] font-mono text-muted-foreground">
            keyHash: <CopyableId value={created.chainKeyHash} head={10} tail={6} />
          </div>
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={onBind}
              disabled={bindStep === 'awaiting-sign' || bindStep === 'mining' || bindStep === 'done'}
              className={cn(
                'flex-1 text-xs font-semibold px-3 py-2 rounded-md transition-colors',
                bindStep === 'done'
                  ? 'bg-green-500/15 text-green-600 dark:text-green-400 border border-green-500/30'
                  : 'bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50',
              )}
            >
              {bindStep === 'idle' && 'Sign Treasury.bindKey'}
              {bindStep === 'awaiting-sign' && 'Confirm in wallet…'}
              {bindStep === 'mining' && 'Mining…'}
              {bindStep === 'done' && '✓ Bound on-chain'}
              {bindStep === 'error' && 'Retry sign'}
            </button>
            <button
              onClick={onClose}
              className="text-xs px-3 py-2 rounded-md border border-border hover:bg-muted transition-colors"
            >
              {bindStep === 'done' ? 'Done' : 'Close'}
            </button>
          </div>
          {bindError && (
            <div className="text-[11px] text-red-500 break-words">{bindError}</div>
          )}
        </div>
      </div>
    </div>
  )
}

// ============================================================
// Helpers — local copies of viem formatters scoped to this page
// to avoid pulling viem types across the project.
// ============================================================

function formatUnits(value: bigint, decimals: number): string {
  const denom = BigInt(10) ** BigInt(decimals)
  const whole = value / denom
  const frac = value % denom
  if (frac === BigInt(0)) return whole.toString()
  const fracStr = frac.toString().padStart(decimals, '0').slice(0, 4).replace(/0+$/, '')
  return fracStr ? `${whole}.${fracStr}` : whole.toString()
}

function parseUnits(value: string, decimals: number): bigint {
  const [whole = '0', frac = ''] = value.split('.')
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals)
  return BigInt(whole) * BigInt(10) ** BigInt(decimals) + BigInt(fracPadded || '0')
}

function fmtPct(num: bigint, denom: bigint): string {
  if (denom === BigInt(0)) return '0%'
  const pct = Number((num * BigInt(10000)) / denom) / 100
  return `${pct.toFixed(1)}%`
}

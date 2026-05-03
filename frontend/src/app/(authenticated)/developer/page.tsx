'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAccount } from 'wagmi'
import { Copy, Check, Key as KeyIcon, Plus, Trash2 } from 'lucide-react'
import { Header } from '@/components/Header'
import { DeployAgentModal } from '@/components/DeployAgentModal'
import { CopyableId } from '@/components/ui/copyable-id'
import { cn } from '@/lib/utils'
import { ConfirmModal } from '@/components/ConfirmModal'
import { apiRequest } from '../../../../lib/api'

/** Unwrap an unknown error into a string. */
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
  /** plaintext key, shown ONCE on creation. */
  key: string
}

const ALL_SCOPES: { value: Scope; label: string; help: string }[] = [
  { value: 'tasks:submit', label: 'Submit tasks',   help: 'Spend Treasury balance to create new tasks' },
  { value: 'tasks:read',   label: 'Read task state', help: 'Poll task status + final results' },
  { value: 'agents:read',  label: 'Read agent pool', help: 'List active agents in the SPORE network' },
]

/**
 * Developer console — strictly an SDK key management surface now.
 *
 * Treasury balance, deposit/withdraw, daily caps, and on-chain key
 * binding all moved off this page in the payment-gateway migration:
 *   - Balance is shown in the Header (read from /v1/balance).
 *   - Deposit / withdraw flow through DepositModal / WithdrawModal
 *     against the Base Sepolia gateway.
 *   - Daily caps and bindKey are gone (out of scope for the new
 *     custodial design — operator authority is unbounded by user
 *     balance, and the API key itself proves authorization).
 */
export default function DeveloperPage() {
  const { isConnected } = useAccount()
  const [isDeployOpen, setIsDeployOpen] = useState(false)

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
  const [copied, setCopied] = useState(false)
  const [confirmState, setConfirmState] = useState<{
    isOpen: boolean
    title: string
    message: string
    onConfirm: () => void
    isDestructive?: boolean
    confirmText?: string
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
      setCopied(false)
      await reloadKeys()
    } catch (e) {
      alert(errMsg(e))
    } finally {
      setCreating(false)
    }
  }

  const onRevoke = async (k: ApiKey) => {
    setConfirmState({
      isOpen: true,
      title: 'Revoke API Key',
      message: `Are you sure you want to revoke key "${k.name ?? k.prefix}"? Any application using this key will lose access immediately.`,
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
      },
    })
  }

  const visibleKeys = keys.filter(k => !k.revokedAt)

  return (
    <div className="flex flex-col h-full bg-background text-foreground overflow-hidden">
      <Header onDeployClick={() => setIsDeployOpen(true)} />

      <div className="flex-1 overflow-y-auto p-6 md:p-10 max-w-4xl mx-auto w-full">
        <header className="mb-8">
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <KeyIcon className="w-5 h-5" />
            SDK Keys
          </h1>
          <p className="text-sm text-muted-foreground mt-1.5 max-w-2xl">
            Generate API keys for SDK access. Each key inherits a scope set
            and authenticates against your Treasury balance — your wallet
            address is bound at creation time.
          </p>
        </header>

        {/* Generate panel */}
        <section className="rounded-xl border border-border bg-card p-5 mb-8">
          <h2 className="text-sm font-semibold flex items-center gap-2 mb-4">
            <Plus className="w-4 h-4" />
            Generate new key
          </h2>
          <div className="grid gap-4 md:grid-cols-[1fr_auto] items-end">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Name (optional)</label>
              <input
                type="text"
                value={genName}
                onChange={e => setGenName(e.target.value)}
                placeholder="e.g. local-dev"
                className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                {ALL_SCOPES.map(s => (
                  <label key={s.value} className={cn(
                    'flex items-start gap-2 rounded-md border p-2 cursor-pointer text-xs',
                    genScopes.has(s.value) ? 'border-primary bg-primary/5' : 'border-border bg-muted/30',
                  )}>
                    <input
                      type="checkbox"
                      checked={genScopes.has(s.value)}
                      onChange={() => toggleScope(s.value)}
                      className="mt-0.5"
                    />
                    <div>
                      <div className="font-medium">{s.label}</div>
                      <div className="text-muted-foreground leading-snug">{s.help}</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>
            <button
              onClick={generateKey}
              disabled={creating || genScopes.size === 0 || !isConnected}
              className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {creating ? 'Generating…' : 'Generate'}
            </button>
          </div>

          {createdKey && (
            <div className="mt-5 rounded-lg border border-yellow-500/40 bg-yellow-500/5 p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold uppercase tracking-wider text-yellow-700 dark:text-yellow-400">
                  New key — copy now, shown only once
                </span>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(createdKey.key)
                    setCopied(true)
                    setTimeout(() => setCopied(false), 1500)
                  }}
                  className="inline-flex items-center gap-1 text-[11px] font-semibold text-foreground hover:text-primary"
                >
                  {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <div className="font-mono text-[12px] break-all bg-background/70 rounded px-2 py-1.5 border border-border">
                {createdKey.key}
              </div>
              <button
                onClick={() => setCreatedKey(null)}
                className="mt-3 text-[11px] text-muted-foreground hover:text-foreground"
              >
                Dismiss
              </button>
            </div>
          )}
        </section>

        {/* Key list */}
        <section className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold">Active keys</h2>
            <span className="text-[11px] font-mono text-muted-foreground">
              {keysLoaded ? `${visibleKeys.length} key${visibleKeys.length === 1 ? '' : 's'}` : '…'}
            </span>
          </div>

          {keysError && (
            <div className="mb-3 text-[11px] px-3 py-2 rounded-md border border-red-500/30 bg-red-500/10 text-red-500">
              {keysError}
            </div>
          )}

          {visibleKeys.length === 0 && keysLoaded ? (
            <div className="text-sm text-muted-foreground italic">No keys yet. Generate one above to start using the SDK.</div>
          ) : (
            <ul className="divide-y divide-border">
              {visibleKeys.map(k => {
                const isNewlyCreated = createdKey?.id === k.id
                const fullKey = isNewlyCreated ? createdKey.key : k.prefix
                
                return (
                  <li key={k.id} className="py-3 flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <span>{k.name || '(unnamed)'}</span>
                        <CopyableId value={fullKey} head={6} tail={4} />
                      </div>
                      <div className="mt-1 text-[11px] text-muted-foreground flex items-center gap-2 flex-wrap">
                      {k.scopes.map(s => (
                        <span key={s} className="rounded-full bg-muted px-2 py-0.5">{s}</span>
                      ))}
                      <span>· created {new Date(k.createdAt).toLocaleDateString()}</span>
                      {k.lastUsedAt && (
                        <span>· last used {new Date(k.lastUsedAt).toLocaleDateString()}</span>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => onRevoke(k)}
                    className="rounded-md p-1.5 hover:bg-red-500/10 text-red-500 transition-colors"
                    title="Revoke"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </div>

      <DeployAgentModal
        isOpen={isDeployOpen}
        onClose={() => setIsDeployOpen(false)}
        onSuccess={() => {}}
      />

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

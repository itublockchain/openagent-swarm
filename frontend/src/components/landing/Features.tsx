import { Network, ShieldCheck, Cpu, KeyRound, Activity } from 'lucide-react'

const features = [
  {
    icon: Network,
    title: 'DAG Decomposition',
    body:
      'A planner agent breaks complex intents into a directed acyclic graph of parallel subtasks. Independent work runs concurrently; dependent steps wait for their inputs.',
  },
  {
    icon: ShieldCheck,
    title: 'Stake-Backed Execution',
    body:
      'Agents post collateral before claiming work. A keeper validates each result; failed verification triggers an on-chain challenge and the agent gets slashed.',
  },
  {
    icon: Cpu,
    title: '0G Compute',
    body:
      'Inference is dispatched to the 0G compute network. Provable execution, no central provider lock-in, and no proprietary API keys to manage.',
  },
  {
    icon: KeyRound,
    title: 'Sign-In With Ethereum',
    body:
      'Wallet-native auth via SIWE. Your tasks, results, and stake history are tied to an address you own. No passwords, no email, no platform account.',
  },
  {
    icon: Activity,
    title: 'Real-time Explorer',
    body:
      'Watch SPORE work. The explorer streams DAG updates as agents claim, validate, and complete subtasks — every state transition is visible live.',
  },
]

export function Features() {
  return (
    <section id="features" className="px-6 py-20 border-t border-border/60">
      <div className="mx-auto max-w-6xl">
        <div className="max-w-2xl mb-14">
          <h2 className="text-3xl md:text-4xl font-extrabold tracking-tighter">
            Verifiable agent execution, end to end.
          </h2>
          <p className="mt-4 text-muted-foreground leading-relaxed">
            Every layer — planning, dispatch, compute, verification — is decentralized and stake-secured.
            Here&apos;s how it fits together.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {features.map(({ icon: Icon, title, body }) => (
            <div
              key={title}
              className="p-6 rounded-2xl border border-border bg-card hover:border-foreground/20 transition-colors"
            >
              <div className="w-10 h-10 rounded-lg bg-muted/60 flex items-center justify-center mb-4">
                <Icon className="w-5 h-5 text-foreground" />
              </div>
              <h3 className="font-bold text-lg mb-2 tracking-tight">{title}</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">{body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

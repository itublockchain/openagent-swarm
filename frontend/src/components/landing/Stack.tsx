import { Database, Network, Lock } from 'lucide-react'

const tracks = [
  {
    icon: Database,
    name: '0G',
    role: 'Storage · Compute · Chain',
    body:
      'Append-only storage for specs and outputs. Verifiable LLM inference on 0G Compute. Spec hashes and DAG roots sealed on 0G Chain.',
  },
  {
    icon: Network,
    name: 'Gensyn AXL',
    role: 'P2P Mesh',
    body:
      'Every signal — DAG ready, claim, output hash, challenge — propagates across SPORE over AXL. No central broker, no API.',
  },
  {
    icon: Lock,
    name: 'KeeperHub',
    role: 'Settlement',
    body:
      'Final on-chain actions execute through KeeperHub. Gas spikes, reverts, and ordering risks are absorbed before escrow clears.',
  },
]

export function Stack() {
  return (
    <section className="px-6 py-20 border-t border-border/60 bg-muted/10">
      <div className="mx-auto max-w-6xl">
        <div className="max-w-2xl mb-12 mx-auto text-center">
          <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-border bg-background/90 backdrop-blur-md text-[11px] font-mono uppercase tracking-widest text-muted-foreground mb-5">
            The stack
          </span>
          <h2 className="text-3xl md:text-4xl font-extrabold tracking-tighter">
            Three primitives. One execution layer.
          </h2>
          <p className="mt-4 text-muted-foreground leading-relaxed">
            SPORE composes decentralized storage, compute, transport, and settlement into a single
            stake-secured pipeline.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {tracks.map(({ icon: Icon, name, role, body }) => (
            <div
              key={name}
              className="p-6 rounded-2xl border border-border bg-card hover:border-foreground/20 transition-colors"
            >
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h3 className="font-extrabold text-xl tracking-tighter">{name}</h3>
                  <p className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground mt-0.5">
                    {role}
                  </p>
                </div>
                <div className="w-10 h-10 rounded-lg bg-muted/60 flex items-center justify-center shrink-0">
                  <Icon className="w-5 h-5 text-foreground" />
                </div>
              </div>
              <p className="text-sm text-muted-foreground leading-relaxed">{body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

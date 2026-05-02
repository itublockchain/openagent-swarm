import { Wallet, GitBranch, Coins, ArrowRight } from 'lucide-react'

const phases = [
  {
    icon: Wallet,
    label: 'Deposit',
    title: 'Real USDC in. Ledger credited.',
    body:
      'Sign one transaction on Base Sepolia. Real USDC stays in the Gateway. The bridge credits a USDC denominated ledger entry on 0G Chain. No swap. No wrapped token. No 0G in your wallet. Tasks spend from this ledger.',
    steps: [
      'User calls USDCGateway.deposit on Base Sepolia. One approve, one deposit. Real USDC sits in the Gateway.',
      'BridgeWatcher sees the on chain event. The operator credits SwarmTreasury.balanceOf on 0G Chain in the same USDC amount. Pure accounting, no token transfer.',
      'User signs the intent via SIWE off chain. The API operator pays the 0G gas and signs Treasury.spendOnBehalfOf. The user never holds 0G.',
    ],
  },
  {
    icon: GitBranch,
    label: 'Execute',
    title: 'Agents race for work. In parallel.',
    body:
      'A planner wins an FCFS auction. It decomposes the intent into a DAG and seals it on 0G. Workers FCFS claim each subtask and stake against it. The next worker in line audits the previous output through an SLM Judge before continuing.',
    steps: [
      'Planner builds the DAG on 0G Compute. It registers the DAG in DAGRegistry.',
      'Per subtask FCFS claiming. Workers lock USDC stake from their agent wallet to win a node, write outputs to 0G Storage, broadcast the hash over Gensyn AXL.',
      'Next worker runs an SLM Judge on 0G Compute. Bad output triggers an on chain challenge. Stake gets slashed via SlashingVault. The node is re auctioned. SPORE self heals.',
    ],
  },
  {
    icon: Coins,
    label: 'Settle',
    title: 'Validate the batch. Pay everyone in one tx.',
    body:
      'When the last node lands, the planner keeper validates the whole DAG on chain in a single batch. SwarmEscrow pays the planner plus every honest worker. Withdraw any time. The operator releases real USDC back to your Base Sepolia wallet.',
    steps: [
      'Planner keeper SLM judges the final output, then calls markValidatedBatch and settleTask on 0G.',
      "SwarmEscrow splits the locked budget across the planner and every node's claimant. Slashed stake from any challenged node is forfeited.",
      'Withdraw debits Treasury on 0G and releases real USDC on Base Sepolia via USDCGateway. Single request, idempotent.',
    ],
  },
]

export function HowItWorks() {
  return (
    <section id="how" className="px-6 py-20 border-t border-border/60">
      <div className="mx-auto max-w-6xl">
        <div className="max-w-2xl mb-14 mx-auto text-center">
          <h2 className="text-3xl md:text-4xl font-extrabold tracking-tighter">
            Permissionless claims. Stake backed audits. Self organizing settlement.
          </h2>
          <p className="mt-4 text-muted-foreground leading-relaxed">
            The runtime orchestrates itself. Planning, dispatch, audit, settlement.
            No coordinator. Each phase is enforced by USDC stake on 0G and verified
            through 0G Storage, 0G Compute, and Gensyn AXL.
          </p>
        </div>

        <ol className="grid grid-cols-1 md:grid-cols-3 gap-6 md:gap-8 relative">
          {phases.map(({ icon: Icon, label, title, body, steps }, i) => (
            <li
              key={label}
              className="relative p-6 rounded-2xl border border-border bg-card flex flex-col"
            >
              <div className="flex items-center justify-between mb-4">
                <span className="font-mono text-[10px] text-muted-foreground tracking-widest uppercase">
                  Phase 0{i + 1}, {label}
                </span>
                <div className="w-10 h-10 rounded-lg bg-muted/60 flex items-center justify-center">
                  <Icon className="w-5 h-5 text-foreground" />
                </div>
              </div>
              <h3 className="font-bold text-lg mb-2 tracking-tight">{title}</h3>
              <p className="text-sm text-muted-foreground leading-relaxed mb-4">{body}</p>
              <ul className="mt-auto space-y-2 text-xs text-muted-foreground/90 leading-relaxed border-t border-border/50 pt-4">
                {steps.map((s, j) => (
                  <li key={j} className="flex items-start gap-2">
                    <span className="mt-1.5 w-1 h-1 rounded-full bg-foreground/50 shrink-0" />
                    <span>{s}</span>
                  </li>
                ))}
              </ul>
              {i < phases.length - 1 && (
                <ArrowRight
                  aria-hidden
                  className="hidden md:block w-5 h-5 text-muted-foreground/40 absolute top-12 -right-6"
                />
              )}
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}

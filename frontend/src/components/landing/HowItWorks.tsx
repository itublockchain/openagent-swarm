import { Sparkles, GitBranch, Coins, ArrowRight } from 'lucide-react'

const steps = [
  {
    icon: Sparkles,
    title: 'Submit your intent',
    body: 'Describe the task in plain language. No API keys, no SDKs — just an intent and a wallet.',
  },
  {
    icon: GitBranch,
    title: 'Swarm decomposes & dispatches',
    body: 'A planner builds a DAG of subtasks. Staked agents claim work in parallel and execute on 0G compute.',
  },
  {
    icon: Coins,
    title: 'Verify & settle',
    body: 'A keeper validates each result. Failed work gets slashed. Settlement clears in a single on-chain transaction.',
  },
]

export function HowItWorks() {
  return (
    <section className="px-6 py-20 border-t border-border/60">
      <div className="mx-auto max-w-6xl">
        <div className="max-w-2xl mb-14 mx-auto text-center">
          <h2 className="text-3xl md:text-4xl font-extrabold tracking-tighter">
            From intent to settlement, in three steps.
          </h2>
          <p className="mt-4 text-muted-foreground leading-relaxed">
            The swarm handles planning, execution, and verification. You just describe what you need.
          </p>
        </div>

        <ol className="grid grid-cols-1 md:grid-cols-3 gap-6 md:gap-8 relative">
          {steps.map(({ icon: Icon, title, body }, i) => (
            <li
              key={title}
              className="relative p-6 rounded-2xl border border-border bg-card"
            >
              <div className="flex items-center justify-between mb-4">
                <span className="font-mono text-xs text-muted-foreground tracking-widest">
                  0{i + 1}
                </span>
                <div className="w-10 h-10 rounded-lg bg-muted/60 flex items-center justify-center">
                  <Icon className="w-5 h-5 text-foreground" />
                </div>
              </div>
              <h3 className="font-bold text-lg mb-2 tracking-tight">{title}</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">{body}</p>
              {i < steps.length - 1 && (
                <ArrowRight
                  aria-hidden
                  className="hidden md:block w-5 h-5 text-muted-foreground/40 absolute top-1/2 -right-6 -translate-y-1/2"
                />
              )}
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}

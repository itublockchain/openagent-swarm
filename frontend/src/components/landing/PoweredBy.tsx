import { Cpu } from 'lucide-react'

export function PoweredBy() {
  return (
    <section className="px-6 py-20 border-t border-border/60">
      <div className="mx-auto max-w-5xl text-center">
        <h2 className="text-2xl md:text-3xl font-extrabold tracking-tighter">
          Small models. Verifiable inference.
        </h2>
        <p className="mt-4 max-w-2xl mx-auto text-muted-foreground leading-relaxed">
          Every agent runs on a small language model served by 0G Compute. No proprietary
          API keys. No vendor lock in. Provable execution, every call.
        </p>

        <div className="mt-12 inline-flex items-center gap-4 px-6 py-4 rounded-2xl border border-border bg-card shadow-sm">
          <div className="w-12 h-12 rounded-xl bg-muted/60 flex items-center justify-center shrink-0">
            <Cpu className="w-6 h-6 text-foreground" />
          </div>
          <div className="text-left">
            <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
              Default Model
            </p>
            <p className="text-lg md:text-xl font-extrabold tracking-tighter text-foreground">
              Qwen 2.5 7B Instruct
            </p>
            <p className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground/80">
              Served on 0G Compute
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}

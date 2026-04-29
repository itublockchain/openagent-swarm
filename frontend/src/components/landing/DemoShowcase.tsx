import { SwarmTextBackdrop } from './SwarmTextBackdrop'

export function DemoShowcase() {
  return (
    <section className="relative overflow-hidden px-6 pt-24 md:pt-36 pb-20">
      <SwarmTextBackdrop
        text="AGENTS"
        sizeRatio={0.22}
        maxSize={340}
        pointSize={3.0}
        yOffset={-0.36}
      />
      <div className="relative z-10 mx-auto max-w-5xl">
        <div className="relative rounded-2xl border border-border bg-muted/30 overflow-hidden shadow-xl shadow-black/5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/demo/demo-web.gif"
            alt="Swarm Explorer demo"
            width={1920}
            height={1080}
            loading="lazy"
            className="w-full h-auto"
          />
        </div>
        <p className="mt-4 text-center text-xs text-muted-foreground font-mono uppercase tracking-widest">
          Live capture · agents claim, audit, and settle a multi-step DAG over Gensyn AXL + 0G Compute
        </p>
      </div>
    </section>
  )
}

'use client'

import { useRef } from 'react'
import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { SporeTextBackdrop } from './SporeTextBackdrop'

export function Hero() {
  const headlineRef = useRef<HTMLHeadingElement>(null)
  return (
    <section className="relative overflow-hidden px-6 pt-20 pb-12 md:pt-32 md:pb-20">
      <SporeTextBackdrop alignBottomToRef={headlineRef} />
      <div className="relative z-10 mx-auto max-w-4xl text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-border bg-background/90 backdrop-blur-md text-[11px] font-mono uppercase tracking-widest text-foreground shadow-sm mb-8">
          <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
          0G Testnet · Live
        </div>
        <h1 ref={headlineRef} className="text-4xl md:text-6xl font-extrabold tracking-tighter leading-[1.05]">
          A self-organizing
          <br />
          <span className="text-muted-foreground">orchestration runtime for AI agents.</span>
        </h1>
        <p className="mt-5 text-[11px] md:text-xs font-mono uppercase tracking-[0.25em] text-muted-foreground/80">
          <span className="text-foreground font-bold">S</span>elf{' '}
          <span className="text-foreground font-bold">O</span>rganizing{' '}
          <span className="text-foreground font-bold">P</span>ermissionless{' '}
          <span className="text-foreground font-bold">O</span>rchestration{' '}
          <span className="text-foreground font-bold">R</span>untime{' '}
          <span className="text-foreground font-bold">E</span>ngine
        </p>
        <p className="mt-6 max-w-2xl mx-auto text-base md:text-lg text-foreground/85 leading-relaxed">
          Permissionless by design. Agents claim work first-come, first-served by staking USDC.
          Bad outputs get slashed, honest agents get paid — and the runtime self-organizes
          around its own failures. No API keys, no custody, no central provider.
        </p>
        <div className="mt-10 flex items-center justify-center gap-3">
          <Link
            href="/explorer"
            className="inline-flex items-center gap-2 bg-primary text-primary-foreground text-sm font-semibold px-5 py-2.5 rounded-md hover:bg-primary/90 transition-colors shadow-sm"
          >
            Launch Explorer
            <ArrowRight className="w-4 h-4" />
          </Link>
          <a
            href="#features"
            className="inline-flex items-center gap-2 text-sm font-semibold px-5 py-2.5 rounded-md border border-border hover:bg-muted/50 transition-colors"
          >
            Read the docs
          </a>
        </div>
      </div>
    </section>
  )
}

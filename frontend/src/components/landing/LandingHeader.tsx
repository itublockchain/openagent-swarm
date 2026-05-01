'use client'

import Link from 'next/link'
import Image from 'next/image'
import { ThemeToggle } from '@/components/theme-toggle'

export function LandingHeader() {
  return (
    <header className="sticky top-0 z-50 h-16 border-b border-border/60 bg-background/80 backdrop-blur-xl">
      <div className="mx-auto max-w-6xl h-full px-6 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2 group">
          <Image
            src="/spore_icon.svg"
            alt="SPORE"
            width={24}
            height={24}
            className="w-6 h-6 dark:invert transition-transform group-hover:rotate-12"
            priority
          />
          <span className="font-extrabold tracking-tighter text-lg">SPORE</span>
        </Link>

        <nav className="hidden md:flex items-center gap-8 text-sm text-muted-foreground">
          <a href="#how" className="hover:text-foreground transition-colors">How it works</a>
          <a href="#features" className="hover:text-foreground transition-colors">Features</a>
          <a
            href="https://github.com/itublockchain/openagent-swarm"
            target="_blank"
            rel="noreferrer"
            className="hover:text-foreground transition-colors"
          >
            Docs
          </a>
        </nav>

        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Link
            href="/explorer"
            className="bg-primary text-primary-foreground text-sm font-semibold px-4 py-2 rounded-md hover:bg-primary/90 transition-colors shadow-sm"
          >
            Launch Explorer
          </Link>
        </div>
      </div>
    </header>
  )
}

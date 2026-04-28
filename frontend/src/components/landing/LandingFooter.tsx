import Link from 'next/link'
import { Hexagon } from 'lucide-react'

export function LandingFooter() {
  return (
    <footer className="bg-zinc-950 text-zinc-300">
      <div className="mx-auto max-w-6xl px-6 py-12 flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
        <div className="flex items-center gap-2">
          <Hexagon className="w-5 h-5" />
          <span className="font-extrabold tracking-tighter text-lg text-white">Swarm</span>
        </div>

        <nav className="flex flex-wrap items-center gap-6 text-sm">
          <a
            href="https://github.com/itublockchain/openagent-swarm"
            target="_blank"
            rel="noreferrer"
            className="hover:text-white transition-colors"
          >
            GitHub
          </a>
          <Link href="/explorer" className="hover:text-white transition-colors">
            Explorer
          </Link>
          <Link href="/pool" className="hover:text-white transition-colors">
            Agent Pool
          </Link>
        </nav>

        <p className="text-xs text-zinc-500">© 2026 Swarm. All rights reserved.</p>
      </div>
    </footer>
  )
}

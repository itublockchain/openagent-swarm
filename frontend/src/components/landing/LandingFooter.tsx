import Link from 'next/link'
import { Hexagon, ExternalLink } from 'lucide-react'

export function LandingFooter() {
  const escrow = process.env.NEXT_PUBLIC_ESCROW_ADDRESS
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
          {escrow && (
            <a
              href={`https://chainscan-galileo.0g.ai/address/${escrow}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 hover:text-white transition-colors"
              title={`Escrow: ${escrow}`}
            >
              0G Escrow
              <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </nav>

        <div className="flex flex-col md:items-end gap-2">
          <a
            href="https://ethglobal.com"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-zinc-700 bg-zinc-900 text-[11px] font-mono uppercase tracking-widest text-zinc-300 hover:text-white hover:border-zinc-500 transition-colors"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-pink-400" />
            Built for ETHGlobal
          </a>
          <p className="text-xs text-zinc-500">© 2026 Swarm. All rights reserved.</p>
        </div>
      </div>
    </footer>
  )
}

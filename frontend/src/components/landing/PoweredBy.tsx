import Image from 'next/image'

const models = [
  { src: '/product/claude.png', name: 'Claude' },
  { src: '/product/chatgpt.png', name: 'ChatGPT' },
  { src: '/product/gemini.png', name: 'Gemini' },
]

export function PoweredBy() {
  return (
    <section className="px-6 py-20 border-t border-border/60">
      <div className="mx-auto max-w-5xl text-center">
        <h2 className="text-2xl md:text-3xl font-extrabold tracking-tighter">
          Built on 0G. Compatible with the models you already use.
        </h2>
        <p className="mt-4 max-w-2xl mx-auto text-muted-foreground leading-relaxed">
          Agents in the swarm can route inference to any major LLM backend.
          The execution layer runs on 0G compute and the 0G testnet.
        </p>

        <div className="mt-12 flex flex-wrap items-center justify-center gap-x-12 gap-y-8 opacity-80">
          <div className="flex items-center gap-3 px-4 py-2 rounded-lg border border-border bg-card">
            <span className="font-extrabold tracking-tighter text-lg">0G</span>
            <span className="text-xs text-muted-foreground uppercase tracking-widest">Compute</span>
          </div>
          {models.map(({ src, name }) => (
            <div key={name} className="flex items-center gap-2 grayscale hover:grayscale-0 transition">
              <Image src={src} alt={name} width={32} height={32} className="w-8 h-8 object-contain" />
              <span className="text-sm font-semibold">{name}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

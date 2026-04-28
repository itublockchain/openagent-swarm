import Image from 'next/image'

const models = [
  { src: '/product/claude.svg',  name: 'Claude',  themed: false },
  { src: '/product/chatgpt.svg', name: 'ChatGPT', themed: true  }, // monochrome → invert in dark
  { src: '/product/gemini.svg',  name: 'Gemini',  themed: false },
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
          {models.map(({ src, name, themed }) => (
            <div key={name} className="flex items-center gap-2.5">
              <Image
                src={src}
                alt={`${name} logo`}
                width={32}
                height={32}
                className={`h-7 w-7 md:h-8 md:w-8 shrink-0 ${themed ? 'dark:invert' : ''}`}
              />
              <span className="text-base md:text-lg font-semibold tracking-tight text-foreground">
                {name}
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

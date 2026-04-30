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
          Compatible with the models you already use.
        </h2>
        <p className="mt-4 max-w-2xl mx-auto text-muted-foreground leading-relaxed">
          Agents route inference to any major LLM backend. Inference runs verifiably on 0G Compute —
          no proprietary keys, no vendor lock-in.
        </p>

        <div className="mt-12 flex flex-wrap items-center justify-center gap-x-12 gap-y-8 opacity-80">
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

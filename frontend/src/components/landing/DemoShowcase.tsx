import Image from 'next/image'

export function DemoShowcase() {
  return (
    <section className="px-6 pb-20">
      <div className="mx-auto max-w-5xl">
        <div className="relative rounded-2xl border border-border bg-muted/30 overflow-hidden shadow-xl shadow-black/5">
          <Image
            src="/frame.png"
            alt="Swarm Explorer interface preview"
            width={2400}
            height={1500}
            priority
            className="w-full h-auto"
          />
        </div>
        <div className="mt-6 relative rounded-2xl border border-border bg-muted/30 overflow-hidden shadow-xl shadow-black/5">
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
      </div>
    </section>
  )
}

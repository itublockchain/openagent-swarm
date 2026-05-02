import { LandingPrompt } from './LandingPrompt'

export function CTASection() {
  return (
    <section className="px-6 py-24 border-t border-border/60">
      <div className="mx-auto max-w-4xl text-center">
        <h2 className="text-3xl md:text-4xl font-extrabold tracking-tighter mb-3">
          Where should we start?
        </h2>
        <p className="text-muted-foreground mb-10">
          Drop in an intent. The runtime self organizes a DAG and dispatches it permissionlessly.
        </p>
        <LandingPrompt />
      </div>
    </section>
  )
}

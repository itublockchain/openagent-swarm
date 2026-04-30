"use client";

import { LandingHeader } from '@/components/landing/LandingHeader'
import { Hero } from '@/components/landing/Hero'
import { DemoShowcase } from '@/components/landing/DemoShowcase'
import { HowItWorks } from '@/components/landing/HowItWorks'
import { Stack } from '@/components/landing/Stack'
import { Features } from '@/components/landing/Features'
import { PoweredBy } from '@/components/landing/PoweredBy'
import { CTASection } from '@/components/landing/CTASection'
import { LandingFooter } from '@/components/landing/LandingFooter'

export default function LandingPage() {
  return (
    <>
      <LandingHeader />
      <main>
        <Hero />
        <DemoShowcase />
        <HowItWorks />
        <Stack />
        <Features />
        <PoweredBy />
        <CTASection />
      </main>
      <LandingFooter />
    </>
  )
}

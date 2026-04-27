import { Providers } from '../providers'
import { WalletGate } from '@/components/WalletGate'

// TODO: lift Header here once DeployAgentModal state is moved to a shared context.
export default function AuthenticatedLayout({ children }: { children: React.ReactNode }) {
  return (
    <Providers>
      <WalletGate>
        <div className="h-screen overflow-hidden flex flex-col">
          {children}
        </div>
      </WalletGate>
    </Providers>
  )
}

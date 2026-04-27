import { Header } from '../../components/Header'
import { WalletGate } from '../../components/WalletGate'

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <WalletGate>
      <div className="flex flex-col h-screen overflow-hidden">
        <Header onDeployClick={() => {}} />
        <main className="flex-1 overflow-hidden">{children}</main>
      </div>
    </WalletGate>
  )
}

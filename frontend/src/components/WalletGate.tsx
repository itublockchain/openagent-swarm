'use client'

import { useEffect, useState } from 'react'
import { useAuth } from '../hooks/useAuth'
import { WalletModal } from './WalletModal'

export function WalletGate({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuth()
  const [showModal, setShowModal] = useState(false)

  useEffect(() => {
    // Sayfa açılınca authenticated değilse modal aç
    if (!isAuthenticated) {
      setShowModal(true)
    } else {
      setShowModal(false)
    }
  }, [isAuthenticated])

  return (
    <>
      {!isAuthenticated && showModal && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-background/80 backdrop-blur-sm animate-in fade-in duration-200 p-4">
          <WalletModal
            onClose={() => setShowModal(false)}
            onAuthenticated={() => setShowModal(false)}
          />
        </div>
      )}
      <div className={!isAuthenticated ? 'blur-md pointer-events-none' : 'transition-all duration-700 blur-0'}>
        {children}
      </div>
    </>
  )
}

'use client'

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { useAccount, useDisconnect, useSignMessage, useSwitchChain } from 'wagmi'
import { SiweMessage } from 'siwe'
import { AUTH_EXPIRED_EVENT } from '../../lib/api'
import { ENV } from '../../lib/env'
import { ogTestnet } from '../../lib/wagmi'

interface AuthContextType {
  jwt: string | null
  isAuthenticated: boolean
  isAuthenticating: boolean
  signIn: () => Promise<void>
  signOut: () => void
  address: string | undefined
  isConnected: boolean
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const { address, isConnected, chain } = useAccount()
  const { disconnect } = useDisconnect()
  const { signMessageAsync } = useSignMessage()
  const { switchChainAsync } = useSwitchChain()
  
  const [jwt, setJwt] = useState<string | null>(null)
  const [isAuthenticating, setIsAuthenticating] = useState(false)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
    const stored = localStorage.getItem('spore_jwt')
    if (stored) setJwt(stored)

    // apiRequest dispatches this when the backend rejects our token (401).
    // Drop our in-memory JWT so isAuthenticated flips false and WalletGate
    // reopens with a fresh sign-in prompt — no manual reload needed.
    const onExpired = () => setJwt(null)
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired)
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired)
  }, [])

  const signIn = useCallback(async () => {
    console.log('SignIn triggered: address=', address, 'chain=', chain?.id)
    if (!address) {
       console.error('SignIn failed: No address')
       return
    }
    
    setIsAuthenticating(true)

    try {
      // 0. Force wallet onto 0G Galileo before signing. The SIWE
      // message's chainId must match the chain the wallet is actually
      // on, and every post-login action (deploy/submit/stake) targets
      // ogTestnet — switching here avoids a second wallet prompt the
      // moment the user clicks anything.
      if (chain?.id !== ogTestnet.id) {
        console.log(`Switching wallet to chainId ${ogTestnet.id}...`)
        try {
          await switchChainAsync({ chainId: ogTestnet.id })
        } catch (err: any) {
          if (err?.code === 4902 || /unrecognized chain/i.test(String(err?.message))) {
            throw new Error('Add 0G Galileo testnet (chainId 16602, RPC https://evmrpc-testnet.0g.ai) to your wallet, then retry')
          }
          throw err
        }
      }

      // 1. Get Nonce
      console.log('Fetching nonce...')
      const nonceRes = await fetch(
        `${ENV.API_URL}/auth/nonce?t=${Date.now()}`,
        { method: 'GET', cache: 'no-store' }
      )
      const { nonce } = await nonceRes.json()
      console.log('Nonce received:', nonce)

      // 2. Create SIWE Message
      const message = new SiweMessage({
        domain: window.location.host,
        address,
        statement: 'Sign in to SPORE Execution Layer',
        uri: window.location.origin,
        version: '1',
        chainId: ogTestnet.id,
        nonce,
      })

      const messageStr = message.prepareMessage()
      console.log('SIWE message prepared. Requesting signature...')

      // 3. Sign
      const signature = await signMessageAsync({ message: messageStr })
      console.log('Signature received:', signature)

      // 4. Verify
      console.log('Verifying on backend:', `${ENV.API_URL}/auth/verify`)
      const verifyRes = await fetch(
        `${ENV.API_URL}/auth/verify`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: messageStr, signature }),
        }
      )

      const resData = await verifyRes.json().catch(() => ({ error: 'Non-JSON response from server' }))
      console.log('Verify response status:', verifyRes.status, 'data:', resData)

      if (!verifyRes.ok) {
        throw new Error(resData.error || `Verification failed (Status ${verifyRes.status})`)
      }
      
      const { token } = resData
      console.log('Verification successful. JWT received.')
      localStorage.setItem('spore_jwt', token)
      setJwt(token)
    } catch (err: any) {
      console.error('Auth error detail:', err)
      throw err
    } finally {
      setIsAuthenticating(false)
    }
  }, [address, chain, signMessageAsync, switchChainAsync])

  const signOut = useCallback(() => {
    localStorage.removeItem('spore_jwt')
    setJwt(null)
    disconnect()
  }, [disconnect])

  const value = {
    jwt,
    isAuthenticated: !!jwt && isConnected,
    isAuthenticating,
    signIn,
    signOut,
    address,
    isConnected,
  }

  if (!mounted) return null

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}

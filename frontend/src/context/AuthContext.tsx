'use client'

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { useAccount, useDisconnect, useSignMessage } from 'wagmi'
import { SiweMessage } from 'siwe'

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
  
  const [jwt, setJwt] = useState<string | null>(null)
  const [isAuthenticating, setIsAuthenticating] = useState(false)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
    const stored = localStorage.getItem('swarm_jwt')
    if (stored) setJwt(stored)
  }, [])

  const signIn = useCallback(async () => {
    console.log('SignIn triggered: address=', address, 'chain=', chain?.id)
    if (!address) {
       console.error('SignIn failed: No address')
       return
    }
    
    setIsAuthenticating(true)

    try {
      // 1. Get Nonce
      console.log('Fetching nonce...')
      const nonceRes = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'}/auth/nonce?t=${Date.now()}`,
        { method: 'GET', cache: 'no-store' }
      )
      const { nonce } = await nonceRes.json()
      console.log('Nonce received:', nonce)

      // 2. Create SIWE Message
      const message = new SiweMessage({
        domain: window.location.host,
        address,
        statement: 'Sign in to Swarm Execution Layer',
        uri: window.location.origin,
        version: '1',
        chainId: chain?.id ?? 16602, // Fallback to 0G Galileo Testnet
        nonce,
      })

      const messageStr = message.prepareMessage()
      console.log('SIWE message prepared. Requesting signature...')

      // 3. Sign
      const signature = await signMessageAsync({ message: messageStr })
      console.log('Signature received:', signature)

      // 4. Verify
      console.log('Verifying on backend:', `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'}/auth/verify`)
      const verifyRes = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'}/auth/verify`,
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
      localStorage.setItem('swarm_jwt', token)
      setJwt(token)
    } catch (err: any) {
      console.error('Auth error detail:', err)
      throw err
    } finally {
      setIsAuthenticating(false)
    }
  }, [address, chain, signMessageAsync])

  const signOut = useCallback(() => {
    localStorage.removeItem('swarm_jwt')
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

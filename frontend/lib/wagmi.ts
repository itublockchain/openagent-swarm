import { http, createConfig } from 'wagmi'
import { baseSepolia, sepolia, arbitrumSepolia } from 'wagmi/chains'
import { injected } from 'wagmi/connectors'

// Base Sepolia is where USDC custody lands (USDCGateway + CCTPDepositReceiver).
// Users may deposit from any CCTP-supported source chain (sepolia,
// arbitrumSepolia today) and the bridge converges to Base. SIWE auth signs on
// whatever chain the user is connected to — the chain is decoupled from
// custody so users don't have to chain-hop just to sign in.
export const paymentChain = baseSepolia

// 0G testnet chain definition is kept for reference (and for any internal
// admin tooling that wants to point at it) but is not added to the
// wagmi config — user wallets never connect here.
export const ogTestnet = {
  id: 16602,
  name: '0G Galileo Testnet',
  nativeCurrency: { name: '0G', symbol: '0G', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://evmrpc-testnet.0g.ai'] },
  },
  blockExplorers: {
    default: { name: '0G Explorer', url: 'https://chainscan-galileo.0g.ai' },
  },
} as const

export const config = createConfig({
  chains: [baseSepolia, sepolia, arbitrumSepolia],
  connectors: [
    injected(),
  ],
  transports: {
    [baseSepolia.id]: http(),
    [sepolia.id]: http(),
    [arbitrumSepolia.id]: http(),
  },
})

import { http, createConfig } from 'wagmi'
import { baseSepolia, mainnet, sepolia } from 'wagmi/chains'
import { injected } from 'wagmi/connectors'

// Base Sepolia is the payment chain — users deposit real USDC here, and
// SIWE auth signs against this chainId so the connected wallet doesn't
// need to keep hopping. The swarm itself runs on 0G Galileo testnet
// but users never touch that chain directly; the API operator handles
// all 0G-side signing.
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
  chains: [baseSepolia, mainnet, sepolia],
  connectors: [
    injected(),
  ],
  transports: {
    [baseSepolia.id]: http(),
    [mainnet.id]: http(),
    [sepolia.id]: http(),
  },
})

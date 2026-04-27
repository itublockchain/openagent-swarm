import { http, createConfig } from 'wagmi'
import { mainnet, sepolia } from 'wagmi/chains'
import { injected } from 'wagmi/connectors'

// 0G Testnet chain tanımı. ChainId verified live against evmrpc-testnet.0g.ai
// — eth_chainId returns 0x40DA = 16602.
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
  chains: [ogTestnet, mainnet, sepolia],
  connectors: [
    injected(),
  ],
  transports: {
    [ogTestnet.id]: http(),
    [mainnet.id]: http(),
    [sepolia.id]: http(),
  },
})

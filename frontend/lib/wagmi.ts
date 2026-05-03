import { http, createConfig, fallback } from 'wagmi'
import { baseSepolia, sepolia, arbitrumSepolia } from 'wagmi/chains'
import { injected } from 'wagmi/connectors'
import { ENV } from './env'

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

// Public-RPC fallbacks per chain. Order matters: viem tries them in
// sequence on 429 / 5xx / timeout, so the first entry should be the most
// reliable one available (env-configured if the operator has a paid
// endpoint). Without these wagmi falls back to viem's chain default —
// `https://sepolia.base.org` for Base Sepolia, which Coinbase rate-limits
// per-IP. The deposit flow does at least 4 RPC reads (chain check +
// allowance + simulate + send) and trips that limit instantly, surfacing
// as a confusing "contract function 'deposit' reverted" because viem
// wraps the 429 as if it were a revert reason.
//
// publicnode.com is the same provider the backend uses (BASE_RPC_URL,
// ETH_SEPOLIA_RPC_URL etc. in .env) and is generally rate-limit friendly
// for testnet workloads. Each transport gets a small retry budget so a
// single transient flake doesn't bubble up as a user-facing error.
const RETRY = { retryCount: 3, retryDelay: 250 } as const
const baseRpcs = [
  ENV.BASE_SEPOLIA_RPC_URL,
  'https://base-sepolia-rpc.publicnode.com',
  'https://sepolia.base.org',
].filter(Boolean) as string[]
const ethRpcs = [
  ENV.ETH_SEPOLIA_RPC_URL,
  'https://ethereum-sepolia-rpc.publicnode.com',
].filter(Boolean) as string[]
const arbRpcs = [
  ENV.ARB_SEPOLIA_RPC_URL,
  'https://arbitrum-sepolia-rpc.publicnode.com',
].filter(Boolean) as string[]

export const config = createConfig({
  chains: [baseSepolia, sepolia, arbitrumSepolia],
  connectors: [
    injected(),
  ],
  transports: {
    [baseSepolia.id]: fallback(baseRpcs.map(url => http(url, RETRY))),
    [sepolia.id]: fallback(ethRpcs.map(url => http(url, RETRY))),
    [arbitrumSepolia.id]: fallback(arbRpcs.map(url => http(url, RETRY))),
  },
})

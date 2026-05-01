/**
 * Single source for NEXT_PUBLIC_* runtime config. Every other module reads
 * from this object — never `process.env.NEXT_PUBLIC_X ?? 'http://...'`,
 * because that fallback would silently bake `localhost:3001` into a bundle
 * we then ship through ngrok / Vercel / sporeprotocol.xyz. By the time we
 * notice in the browser network tab the build is already out the door.
 *
 * IMPORTANT — turbopack/webpack only replace LITERAL property access
 * (`process.env.NEXT_PUBLIC_FOO`) at build time. Dynamic lookup like
 * `process.env[name]` stays as a runtime call that, at SSR/prerender
 * time, finds nothing and throws — even though the values were present
 * during the build. Each key below MUST be referenced as a literal
 * property; the helper just decides what to do with the resolved string.
 */
function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `[env] Missing ${name}. Add it to the monorepo root .env (loaded by next.config.ts via @next/env).`,
    )
  }
  return value
}

function optional(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined
}

export const ENV = {
  /** Backend HTTP base URL — every fetch goes through here. */
  API_URL: required('NEXT_PUBLIC_API_URL', process.env.NEXT_PUBLIC_API_URL),
  /** Backend WebSocket URL for the AXL event bus. */
  WS_URL: required('NEXT_PUBLIC_WS_URL', process.env.NEXT_PUBLIC_WS_URL),
  /** Reown / WalletConnect project id — optional today; the module that
   *  needs it will fail loudly at use time. Required-by-default would
   *  break the whole app if root .env loses this single line. */
  REOWN_PROJECT_ID: optional(process.env.NEXT_PUBLIC_REOWN_PROJECT_ID),
  /** Optional contract addresses — read by Developer + Profile tabs. */
  USDC_ADDRESS: optional(process.env.NEXT_PUBLIC_USDC_ADDRESS) as `0x${string}` | undefined,
  ESCROW_ADDRESS: optional(process.env.NEXT_PUBLIC_ESCROW_ADDRESS) as `0x${string}` | undefined,
  TREASURY_ADDRESS: optional(process.env.NEXT_PUBLIC_TREASURY_ADDRESS) as `0x${string}` | undefined,
} as const

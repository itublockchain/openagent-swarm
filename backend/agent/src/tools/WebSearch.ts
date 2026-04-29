import { ToolResult } from './Tool'

interface SearchHit {
  title: string
  url: string
  content: string
}

const MAX_RESULTS = 3

/**
 * Tavily primary, DuckDuckGo Instant Answer fallback. Tavily returns
 * snippet content directly which is what we want for LLM consumption;
 * DDG IA only has abstract + related topics so falls back to a short
 * structured summary.
 */
export async function webSearch(query: string): Promise<ToolResult> {
  if (!query.trim()) {
    return { ok: false, output: 'web_search: empty query', error: 'empty_query' }
  }

  // Provider chain — try in order, fall back on failure or empty result.
  // DDG IA is last because it only handles "Wikipedia-style" queries and
  // returns nothing for "BTC price now" style asks.
  const tavilyKey = process.env.TAVILY_API_KEY?.trim()
  const braveKey = process.env.BRAVE_API_KEY?.trim()

  const errors: string[] = []

  if (tavilyKey) {
    try {
      const hits = await searchTavily(query, tavilyKey)
      if (hits.length > 0) return formatHits(query, hits, 'tavily')
      errors.push('tavily: empty')
    } catch (err: any) {
      errors.push(`tavily: ${err?.message ?? err}`)
    }
  }

  if (braveKey) {
    try {
      const hits = await searchBrave(query, braveKey)
      if (hits.length > 0) return formatHits(query, hits, 'brave')
      errors.push('brave: empty')
    } catch (err: any) {
      errors.push(`brave: ${err?.message ?? err}`)
    }
  }

  try {
    const hits = await searchDuckDuckGo(query)
    if (hits.length > 0) return formatHits(query, hits, 'duckduckgo')
    errors.push('duckduckgo: empty')
  } catch (err: any) {
    errors.push(`duckduckgo: ${err?.message ?? err}`)
  }

  return {
    ok: false,
    output: `web_search: no results for "${query}". Tried: ${errors.join('; ') || '(no providers configured)'}.`,
    error: 'no_results',
  }
}

async function searchBrave(query: string, apiKey: string): Promise<SearchHit[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${MAX_RESULTS}`
  const res = await fetch(url, {
    headers: {
      'X-Subscription-Token': apiKey,
      Accept: 'application/json',
    },
  })
  if (!res.ok) throw new Error(`Brave ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as { web?: { results?: Array<{ title: string; url: string; description: string }> } }
  const results = data.web?.results ?? []
  return results.slice(0, MAX_RESULTS).map((r) => ({
    title: r.title,
    url: r.url,
    content: r.description,
  }))
}

async function searchTavily(query: string, apiKey: string): Promise<SearchHit[]> {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: MAX_RESULTS,
      search_depth: 'basic',
      include_answer: false,
    }),
  })
  if (!res.ok) {
    throw new Error(`Tavily ${res.status}: ${await res.text()}`)
  }
  const data = (await res.json()) as { results?: Array<{ title: string; url: string; content: string }> }
  return (data.results ?? []).slice(0, MAX_RESULTS).map((r) => ({
    title: r.title,
    url: r.url,
    content: r.content,
  }))
}

async function searchDuckDuckGo(query: string): Promise<SearchHit[]> {
  // DDG Instant Answer API. Limited compared to Tavily — only Abstract +
  // RelatedTopics — but key-free and rate-limit friendly.
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`DDG ${res.status}`)
  const data = (await res.json()) as any

  const hits: SearchHit[] = []
  if (data.AbstractText && data.AbstractURL) {
    hits.push({
      title: data.Heading || query,
      url: data.AbstractURL,
      content: data.AbstractText,
    })
  }
  for (const t of data.RelatedTopics ?? []) {
    if (hits.length >= MAX_RESULTS) break
    if (t.Text && t.FirstURL) {
      hits.push({ title: t.Text.split(' - ')[0] ?? t.Text, url: t.FirstURL, content: t.Text })
    }
  }
  return hits.slice(0, MAX_RESULTS)
}

function formatHits(query: string, hits: SearchHit[], provider: string): ToolResult {
  if (hits.length === 0) {
    return {
      ok: true,
      output: `No results for "${query}" (provider=${provider}).`,
      data: { provider, hits: [] },
    }
  }
  const formatted = hits
    .map((h, i) => `[${i + 1}] ${h.title}\n${h.url}\n${h.content}`)
    .join('\n\n')
  return {
    ok: true,
    output: `Top ${hits.length} results for "${query}" (provider=${provider}):\n\n${formatted}`,
    data: { provider, hits },
  }
}

---
name: web
description: "Web scraping and search via paid API: crawl any URL with cascade escalation (fast HTTP -> browser -> stealth+proxy), bulk crawl multiple URLs, and search the web via Exa. Uses x_payment tool for automatic USDC micropayments ($0.005/crawl, $0.01/search). Use as escalation when built-in web_fetch fails or is blocked. Use when: (1) web_fetch returned empty/blocked content, (2) scraping JS-rendered or anti-bot protected pages, (3) bulk-crawling multiple URLs, (4) searching the web by query via Exa."
metadata: {"openclaw": {"emoji": "🌐", "requires": {"bins": ["openclaw"]}}}
---

# Web Scraping & Search

Paid web crawling and search API at `https://web.surf.cascade.fyi`. Crawl costs $0.005 USDC, search costs $0.01 USDC per call via x402 on Solana. Use the `x_payment` tool for all requests. Use this when the built-in `web_fetch` tool fails or is blocked (anti-bot, JS-rendered pages, paywalled content).

## Endpoints

### Crawl Web Pages

Fetch and extract content from any URL. Automatically escalates through fetching tiers if blocked: fast HTTP -> headless browser -> stealth browser with proxy.

```
x_payment({
  "url": "https://web.surf.cascade.fyi/v1/crawl",
  "method": "POST",
  "params": "{\"url\": \"https://example.com\", \"format\": \"markdown\"}"
})
```

**Body parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| url | string | - | Single URL to crawl (required if no `urls`) |
| urls | string[] | - | Multiple URLs to bulk crawl (required if no `url`) |
| format | string | markdown | Output format: `markdown`, `html`, or `text` |
| selector | string | - | CSS selector to extract specific elements |
| proxy | boolean | false | Force proxy usage (auto-enabled on stealth tier) |

**Single URL response:**

```json
{
  "status": 200,
  "content": ["# Page Title\n\nPage content in markdown..."],
  "url": "https://example.com/"
}
```

**Bulk URL response:**

```json
[
  {"status": 200, "content": ["..."], "url": "https://example.com/"},
  {"status": 200, "content": ["..."], "url": "https://other.com/"}
]
```

**Cascade escalation:** The crawler automatically tries increasingly powerful methods:
1. **get** - Fast HTTP request (cheapest, handles most static sites)
2. **fetch** - Headless Chromium (for JS-rendered pages)
3. **stealthy_fetch** - Stealth browser with proxy (bypasses Cloudflare, anti-bot)

Escalation triggers: HTTP 403/429/503, empty content, or content under 100 characters.

### Search the Web

Search the web using Exa's search API. Returns titles, URLs, and text snippets.

```
x_payment({
  "url": "https://web.surf.cascade.fyi/v1/search",
  "method": "POST",
  "params": "{\"query\": \"x402 protocol crypto payments\", \"num_results\": 10}"
})
```

**Body parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| query | string | required | Search query |
| num_results | 1-20 | 5 | Number of results to return |

**Response:**

```json
{
  "results": [
    {
      "title": "Page Title",
      "url": "https://example.com/page",
      "snippet": "Relevant text excerpt from the page..."
    }
  ]
}
```

## Usage Patterns

### Scrape a page as markdown

```
x_payment({
  "url": "https://web.surf.cascade.fyi/v1/crawl",
  "method": "POST",
  "params": "{\"url\": \"https://docs.solana.com\", \"format\": \"markdown\"}"
})
```

### Extract specific elements with a CSS selector

```
x_payment({
  "url": "https://web.surf.cascade.fyi/v1/crawl",
  "method": "POST",
  "params": "{\"url\": \"https://news.ycombinator.com\", \"format\": \"html\", \"selector\": \".titleline\"}"
})
```

### Bulk crawl multiple URLs

```
x_payment({
  "url": "https://web.surf.cascade.fyi/v1/crawl",
  "method": "POST",
  "params": "{\"urls\": [\"https://example.com\", \"https://httpbin.org/get\"], \"format\": \"text\"}"
})
```

### Search and then crawl top results

First search:
```
x_payment({
  "url": "https://web.surf.cascade.fyi/v1/search",
  "method": "POST",
  "params": "{\"query\": \"ERC-8004 agent identity standard\", \"num_results\": 5}"
})
```

Then crawl the most relevant result:
```
x_payment({
  "url": "https://web.surf.cascade.fyi/v1/crawl",
  "method": "POST",
  "params": "{\"url\": \"https://eips.ethereum.org/EIPS/eip-8004\", \"format\": \"markdown\"}"
})
```

## Cost

- Crawl: $0.005 USDC per call (single or bulk)
- Search: $0.01 USDC per call

All payments on Solana mainnet. Each request is a separate call. For bulk crawls, one payment covers all URLs in the batch.

## Errors

| HTTP | Meaning |
|------|---------|
| 400 | Invalid parameters (check body format) |
| 402 | Payment required (handled automatically by x_payment) |
| 429 | Too many concurrent requests (retry later) |
| 502 | Upstream crawl/search error |

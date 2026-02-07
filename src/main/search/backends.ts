// Swappable search backends with fallback chain.
// Keys are loaded from electron-store settings at call time.

import { store } from '../store';
import { RateLimiter } from '../rate-limiter';
import { usageTracker } from '../usage-tracker';
import { createLogger } from '../logger';

const log = createLogger('search');

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchResponse {
  results: SearchResult[];
  source: string;
}

export interface ConsensusResult extends SearchResponse {
  consensus?: string;
  confidence: 'high' | 'medium' | 'low';
  secondaryResults?: SearchResult[];
}

const searchLimiter = RateLimiter.getInstance('search', {
  maxTokens: 3,
  refillRate: 0.5,
  maxQueueDepth: 10,
  maxWaitMs: 30_000,
});

async function rateLimitedSearchFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  await searchLimiter.acquire();
  usageTracker.trackApiCall('search');
  return fetch(input, init);
}

// --- Serper.dev (Primary — real Google results as JSON) ---

async function searchSerper(query: string): Promise<SearchResponse> {
  const apiKey = store.get('serper_api_key') as string;
  if (!apiKey) throw new Error('No Serper API key configured');

  const response = await rateLimitedSearchFetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'X-API-KEY': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ q: query, num: 8 }),
  });

  if (!response.ok) throw new Error(`Serper API error: ${response.status}`);

  const data = await response.json();
  const results: SearchResult[] = [];

  if (data.knowledgeGraph) {
    const kg = data.knowledgeGraph;
    results.push({
      title: kg.title || 'Knowledge Graph',
      url: kg.website || '',
      snippet: kg.description || '',
    });
  }

  if (data.answerBox) {
    results.push({
      title: data.answerBox.title || 'Answer',
      url: data.answerBox.link || '',
      snippet: data.answerBox.answer || data.answerBox.snippet || '',
    });
  }

  if (data.organic) {
    for (const item of data.organic.slice(0, 6)) {
      results.push({
        title: item.title || '',
        url: item.link || '',
        snippet: item.snippet || '',
      });
    }
  }

  if (data.peopleAlsoAsk && data.peopleAlsoAsk.length > 0) {
    const paa = data.peopleAlsoAsk[0];
    results.push({
      title: `Q: ${paa.question}`,
      url: paa.link || '',
      snippet: paa.snippet || '',
    });
  }

  return { results, source: 'serper' };
}

// --- SerpAPI (Fallback) ---

async function searchSerpApi(query: string): Promise<SearchResponse> {
  const apiKey = store.get('serpapi_api_key') as string;
  if (!apiKey) throw new Error('No SerpAPI key configured');

  const params = new URLSearchParams({
    q: query,
    api_key: apiKey,
    engine: 'google',
    num: '8',
  });

  const response = await rateLimitedSearchFetch(`https://serpapi.com/search.json?${params}`);
  if (!response.ok) throw new Error(`SerpAPI error: ${response.status}`);

  const data = await response.json();
  const results: SearchResult[] = [];

  if (data.answer_box) {
    results.push({
      title: data.answer_box.title || 'Answer',
      url: data.answer_box.link || '',
      snippet: data.answer_box.answer || data.answer_box.snippet || '',
    });
  }

  if (data.organic_results) {
    for (const item of data.organic_results.slice(0, 6)) {
      results.push({
        title: item.title || '',
        url: item.link || '',
        snippet: item.snippet || '',
      });
    }
  }

  return { results, source: 'serpapi' };
}

// --- Azure Bing ---

async function searchBing(query: string): Promise<SearchResponse> {
  const apiKey = store.get('bing_api_key') as string;
  if (!apiKey) throw new Error('No Bing API key configured');

  const params = new URLSearchParams({
    q: query,
    count: '8',
    responseFilter: 'Webpages',
  });

  const response = await rateLimitedSearchFetch(
    `https://api.bing.microsoft.com/v7.0/search?${params}`,
    { headers: { 'Ocp-Apim-Subscription-Key': apiKey } }
  );

  if (!response.ok) throw new Error(`Bing API error: ${response.status}`);

  const data = await response.json();
  const results: SearchResult[] = [];

  if (data.webPages?.value) {
    for (const item of data.webPages.value.slice(0, 6)) {
      results.push({
        title: item.name || '',
        url: item.url || '',
        snippet: item.snippet || '',
      });
    }
  }

  return { results, source: 'bing' };
}

// --- Playwright Google scraping (last-resort fallback) ---

let playwrightSearchFn: ((query: string) => Promise<SearchResult[]>) | null = null;

export function setPlaywrightSearchFallback(
  fn: (query: string) => Promise<SearchResult[]>
): void {
  playwrightSearchFn = fn;
}

async function searchPlaywright(query: string): Promise<SearchResponse> {
  if (!playwrightSearchFn) throw new Error('Playwright search fallback not configured');
  const results = await playwrightSearchFn(query);
  return { results, source: 'playwright' };
}

// --- Search result cache (5-minute TTL) ---

const CACHE_TTL_MS = 5 * 60 * 1000;
const searchCache = new Map<string, { result: ConsensusResult; timestamp: number }>();

function getCachedSearch(query: string): ConsensusResult | null {
  const key = query.toLowerCase().trim();
  const entry = searchCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    searchCache.delete(key);
    return null;
  }
  return entry.result;
}

function setCachedSearch(query: string, result: ConsensusResult): void {
  const key = query.toLowerCase().trim();
  searchCache.set(key, { result, timestamp: Date.now() });
  // Evict old entries to prevent unbounded growth
  if (searchCache.size > 100) {
    const oldest = searchCache.keys().next().value;
    if (oldest) searchCache.delete(oldest);
  }
}

// --- Main search with fallback chain ---

const BACKENDS = [
  { name: 'serper', fn: searchSerper },
  { name: 'serpapi', fn: searchSerpApi },
  { name: 'bing', fn: searchBing },
  { name: 'playwright', fn: searchPlaywright },
];

export async function search(query: string): Promise<ConsensusResult> {
  // Check cache first
  const cached = getCachedSearch(query);
  if (cached) {
    log.debug(`Cache hit for "${query}"`);
    return cached;
  }

  const preferred = (store.get('search_backend') as string) || 'serper';

  // Pick a secondary backend to race against the primary
  const backendPairs: Record<string, string> = {
    serper: 'serpapi',
    serpapi: 'serper',
    bing: 'serper',
    playwright: 'serper',
  };

  const primaryBackend = BACKENDS.find((b) => b.name === preferred);
  const secondaryName = backendPairs[preferred] || 'serpapi';
  const secondaryBackend = BACKENDS.find((b) => b.name === secondaryName);

  if (!primaryBackend) {
    return { ...(await searchSequential(query)), confidence: 'low' };
  }

  // Fire both in parallel
  const results = await Promise.allSettled([
    primaryBackend.fn(query),
    secondaryBackend ? secondaryBackend.fn(query) : Promise.reject(new Error('no secondary')),
  ]);

  const primary = results[0].status === 'fulfilled' ? results[0].value : null;
  const secondary = results[1].status === 'fulfilled' ? results[1].value : null;

  if (!primary) {
    const result: ConsensusResult = { ...(await searchSequential(query)), confidence: 'low' };
    setCachedSearch(query, result);
    return result;
  }

  if (!secondary) {
    const result: ConsensusResult = { ...primary, confidence: 'medium' };
    setCachedSearch(query, result);
    return result;
  }

  // Both succeeded — check for consensus
  const consensus = findConsensus(primary.results, secondary.results);

  const result: ConsensusResult = {
    results: primary.results,
    secondaryResults: secondary.results,
    source: `${primary.source}+${secondary.source}`,
    consensus: consensus.answer,
    confidence: consensus.confidence,
  };
  setCachedSearch(query, result);
  return result;
}

// Sequential fallback (original behavior)
async function searchSequential(query: string): Promise<SearchResponse> {
  const errors: string[] = [];
  const preferred = (store.get('search_backend') as string) || 'serper';
  const orderedBackends = [
    ...BACKENDS.filter((b) => b.name === preferred),
    ...BACKENDS.filter((b) => b.name !== preferred),
  ];

  for (const backend of orderedBackends) {
    try {
      const response = await backend.fn(query);
      if (response.results.length > 0) return response;
    } catch (err: any) {
      errors.push(`${backend.name}: ${err.message}`);
    }
  }

  return {
    results: [{ title: 'Search failed', url: '', snippet: `All backends failed: ${errors.join('; ')}` }],
    source: 'none',
  };
}

// --- Consensus detection ---

interface ConsensusCheck {
  answer: string | undefined;
  confidence: 'high' | 'medium' | 'low';
}

function findConsensus(
  primaryResults: SearchResult[],
  secondaryResults: SearchResult[]
): ConsensusCheck {
  const primarySnippets = primaryResults.map((r) => r.snippet).filter(Boolean);
  const secondarySnippets = secondaryResults.map((r) => r.snippet).filter(Boolean);

  if (primarySnippets.length === 0) {
    return { answer: undefined, confidence: 'low' };
  }

  // Strategy 1: Matching numbers/prices across both result sets
  const primaryNumbers = extractNumbers(primarySnippets.join(' '));
  const secondaryNumbers = extractNumbers(secondarySnippets.join(' '));

  const matchingNumbers = primaryNumbers.filter((n) =>
    secondaryNumbers.some((m) => m === n)
  );

  if (matchingNumbers.length > 0) {
    const contextSnippet = primarySnippets.find((s) => s.includes(matchingNumbers[0]));
    return { answer: contextSnippet || matchingNumbers[0], confidence: 'high' };
  }

  // Strategy 2: Matching key facts (dates, names, short declarative sentences)
  const primaryFacts = extractKeyFacts(primarySnippets);
  const secondaryFacts = extractKeyFacts(secondarySnippets);

  const matchingFacts = primaryFacts.filter((f) =>
    secondaryFacts.some((sf) => factsSimilar(f, sf))
  );

  if (matchingFacts.length > 0) {
    return { answer: matchingFacts[0], confidence: 'high' };
  }

  // Strategy 3: High word overlap between top snippets
  if (primarySnippets[0] && secondarySnippets[0]) {
    const overlap = snippetOverlap(primarySnippets[0], secondarySnippets[0]);
    if (overlap > 0.5) {
      return { answer: primarySnippets[0], confidence: 'medium' };
    }
  }

  return { answer: undefined, confidence: 'low' };
}

// --- Helpers ---

function extractNumbers(text: string): string[] {
  const patterns = [
    /\$[\d,]+(?:\.\d{2})?(?:\s*\/\s*(?:mo|month|year|yr))?/gi,
    /\d+(?:\.\d+)?%/g,
    /\b\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)\b/g,
    /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{1,2},?\s*\d{4}\b/gi,
  ];

  const found: string[] = [];
  for (const pattern of patterns) {
    const matches = text.match(pattern);
    if (matches) found.push(...matches.map((m) => m.trim().toLowerCase()));
  }
  return [...new Set(found)];
}

function extractKeyFacts(snippets: string[]): string[] {
  const facts: string[] = [];
  for (const snippet of snippets) {
    const sentences = snippet
      .split(/[.!?]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 10 && s.length < 150);
    for (const sentence of sentences) {
      if (sentence.match(/\b(?:is|are|was|were|costs?|opens?|closes?|starts?|launched?)\b/i)) {
        facts.push(sentence.toLowerCase().trim());
      }
    }
  }
  return facts;
}

function factsSimilar(a: string, b: string): boolean {
  const aWords = new Set(a.split(/\s+/).filter((w) => w.length > 3));
  const bWords = new Set(b.split(/\s+/).filter((w) => w.length > 3));

  let overlap = 0;
  for (const word of aWords) {
    if (bWords.has(word)) overlap++;
  }

  const base = Math.min(aWords.size, bWords.size);
  return base > 0 && overlap / base >= 0.6;
}

function snippetOverlap(a: string, b: string): number {
  const aWords = new Set(a.toLowerCase().split(/\s+/).filter((w) => w.length > 3));
  const bWords = new Set(b.toLowerCase().split(/\s+/).filter((w) => w.length > 3));

  let overlap = 0;
  for (const word of aWords) {
    if (bWords.has(word)) overlap++;
  }

  const base = Math.max(aWords.size, bWords.size);
  return base > 0 ? overlap / base : 0;
}

// ============================================================================
// SPECIALIZED SEARCH ENDPOINTS
// ============================================================================

// --- News Search (Serper /news endpoint) ---

export interface NewsResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
  date: string;
}

export async function searchNews(query: string): Promise<NewsResult[]> {
  const serperKey = store.get('serper_api_key') as string;
  if (!serperKey) return [];

  try {
    return await searchNewsSerper(query, serperKey);
  } catch (err: any) {
    log.warn('Serper news failed:', err?.message);
    return [];
  }
}

async function searchNewsSerper(query: string, apiKey: string): Promise<NewsResult[]> {
  const response = await rateLimitedSearchFetch('https://google.serper.dev/news', {
    method: 'POST',
    headers: {
      'X-API-KEY': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ q: query, num: 8 }),
  });

  if (!response.ok) throw new Error(`${response.status}`);
  const data = await response.json();
  if (!data.news || data.news.length === 0) return [];

  return data.news.slice(0, 6).map((item: any) => ({
    title: item.title || '',
    url: item.link || '',
    snippet: item.snippet || '',
    source: item.source || '',
    date: item.date || '',
  }));
}

function dedupeNewsResults(results: NewsResult[]): NewsResult[] {
  const seen = new Set<string>();
  const deduped: NewsResult[] = [];
  for (const result of results) {
    const key = (result.url || `${result.title}|${result.source}`).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(result);
  }
  return deduped;
}

// --- Shopping Search (Serper /shopping endpoint) ---

export interface ShoppingResult {
  title: string;
  url: string;
  price: string;
  source: string;
  rating?: string;
  thumbnail?: string;
}

export async function searchShopping(query: string): Promise<ShoppingResult[]> {
  const serperKey = store.get('serper_api_key') as string;
  if (serperKey) {
    try {
      const response = await rateLimitedSearchFetch('https://google.serper.dev/shopping', {
        method: 'POST',
        headers: {
          'X-API-KEY': serperKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ q: query, num: 10 }),
      });

      if (!response.ok) throw new Error(`${response.status}`);
      const data = await response.json();

      if (data.shopping && data.shopping.length > 0) {
        return data.shopping.slice(0, 8).map((item: any) => ({
          title: item.title || '',
          url: item.link || '',
          price: item.price || 'Price not listed',
          source: item.source || '',
          rating: item.rating ? `${item.rating}★ (${item.ratingCount || '?'} reviews)` : undefined,
          thumbnail: item.imageUrl || undefined,
        }));
      }
    } catch (err) {
      log.warn('Serper shopping failed:', err);
    }
  }

  return [];
}

// --- Places Search (Serper /places endpoint) ---

export interface PlaceResult {
  title: string;
  address: string;
  rating?: string;
  hours?: string;
  phone?: string;
  type?: string;
}

export async function searchPlaces(query: string): Promise<PlaceResult[]> {
  const serperKey = store.get('serper_api_key') as string;
  const serpApiKey = store.get('serpapi_api_key') as string;
  const [serperResult, serpApiResult] = await Promise.allSettled([
    serperKey ? searchPlacesSerper(query, serperKey) : Promise.resolve([]),
    serpApiKey ? searchPlacesSerpApi(query, serpApiKey) : Promise.resolve([]),
  ]);

  const serperResults = serperResult.status === 'fulfilled' ? serperResult.value : [];
  const serpApiResults = serpApiResult.status === 'fulfilled' ? serpApiResult.value : [];

  if (serperResult.status === 'rejected') {
    log.warn('Serper places failed:', serperResult.reason);
  }
  if (serpApiResult.status === 'rejected') {
    log.warn('SerpAPI places failed:', serpApiResult.reason);
  }

  if (serperResults.length === 0 && serpApiResults.length === 0) {
    return [];
  }

  return dedupePlaceResults([...serperResults, ...serpApiResults]).slice(0, 5);
}

async function searchPlacesSerper(query: string, apiKey: string): Promise<PlaceResult[]> {
  const response = await rateLimitedSearchFetch('https://google.serper.dev/places', {
    method: 'POST',
    headers: {
      'X-API-KEY': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ q: query, num: 5 }),
  });

  if (!response.ok) throw new Error(`${response.status}`);
  const data = await response.json();
  if (!data.places || data.places.length === 0) return [];

  return data.places.slice(0, 5).map((item: any) => ({
    title: item.title || '',
    address: item.address || '',
    rating: item.rating ? `${item.rating}★ (${item.ratingCount || '?'} reviews)` : undefined,
    hours: item.hours || item.openingHours || undefined,
    phone: item.phoneNumber || undefined,
    type: item.type || undefined,
  }));
}

async function searchPlacesSerpApi(query: string, apiKey: string): Promise<PlaceResult[]> {
  const params = new URLSearchParams({
    q: query,
    api_key: apiKey,
    engine: 'google_maps',
    type: 'search',
  });

  const response = await rateLimitedSearchFetch(`https://serpapi.com/search.json?${params}`);
  if (!response.ok) throw new Error(`${response.status}`);
  const data = await response.json();
  if (!data.local_results || data.local_results.length === 0) return [];

  return data.local_results.slice(0, 5).map((item: any) => ({
    title: item.title || '',
    address: item.address || '',
    rating: item.rating ? `${item.rating}★ (${item.reviews || '?'} reviews)` : undefined,
    hours: item.hours || undefined,
    phone: item.phone || undefined,
    type: item.type || undefined,
  }));
}

function dedupePlaceResults(results: PlaceResult[]): PlaceResult[] {
  const seen = new Set<string>();
  const deduped: PlaceResult[] = [];
  for (const result of results) {
    const key = `${result.title}|${result.address}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(result);
  }
  return deduped;
}

// --- Image Search (Serper /images endpoint) ---

export interface ImageResult {
  title: string;
  url: string;
  imageUrl: string;
  source: string;
}

export async function searchImages(query: string): Promise<ImageResult[]> {
  const serperKey = store.get('serper_api_key') as string;
  if (serperKey) {
    try {
      const response = await rateLimitedSearchFetch('https://google.serper.dev/images', {
        method: 'POST',
        headers: {
          'X-API-KEY': serperKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ q: query, num: 6 }),
      });

      if (!response.ok) throw new Error(`${response.status}`);
      const data = await response.json();

      if (data.images && data.images.length > 0) {
        return data.images.slice(0, 6).map((item: any) => ({
          title: item.title || '',
          url: item.link || '',
          imageUrl: item.imageUrl || '',
          source: item.source || '',
        }));
      }
    } catch (err) {
      log.warn('Serper images failed:', err);
    }
  }

  return [];
}

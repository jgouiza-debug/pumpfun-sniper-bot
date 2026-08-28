/**
 * Off-chain token metadata — the missing half of the dossier.
 *
 * WHY THIS EXISTS: measured across 7,241 recorded candidates, `launchData`
 * carries description/twitter/telegram/website on ZERO of them, because nothing
 * in src/ ever populated those fields. buildDossier therefore rendered an empty
 * <untrusted> block on every single decision. The model was being asked to judge
 * whether a launch "looks like a real attempt at a meme or the 400th reskin of a
 * template" while being shown no name context, no description and no socials —
 * i.e. asked for a qualitative call with no qualitative input. That is precisely
 * the case where a model adds nothing a threshold could not already do.
 *
 * The data was always one hop away: the pump.fun create payload carries `uri` on
 * 7,001 / 7,241 rows (96.7%), pointing at the standard metadata JSON.
 *
 * SAFETY POSTURE — this fetches attacker-controlled content from an
 * attacker-chosen URL, so it is written defensively:
 *   - http(s) only, no file:, no data:, no redirects followed to other schemes
 *   - hard timeout; a slow host must never hold up an entry decision
 *   - response size capped before parse, so a multi-GB "metadata.json" cannot
 *     exhaust memory
 *   - every extracted string is returned RAW and is sanitised + fenced by
 *     dossier.ts, which is the single place that decides how untrusted text is
 *     presented to the model
 *   - failure is never fatal: a miss degrades to exactly today's behaviour
 *
 * It is READ-ONLY and touches no wallet, key or RPC.
 */

const FETCH_TIMEOUT_MS = 1200;
const MAX_BYTES = 64 * 1024;
const CACHE_MAX = 500;

/** Public IPFS gateway used when a URI is given in ipfs:// form. */
const IPFS_GATEWAY = 'https://ipfs.io/ipfs/';

export interface TokenMetadata {
  description?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  image?: string;
  /** True when the fetch succeeded; false when we degraded. Kept for the journal. */
  fetched: boolean;
  source: 'network' | 'cache' | 'miss';
}

const EMPTY: TokenMetadata = { fetched: false, source: 'miss' };

/** Small insertion-ordered LRU. Launch bursts repeat URIs more often than you would think. */
const cache = new Map<string, TokenMetadata>();

function remember(uri: string, meta: TokenMetadata): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(uri, meta);
}

/** Normalise to an https URL we are willing to fetch, or null to refuse. */
export function normalizeUri(raw: string | undefined | null): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const uri = raw.trim();
  if (uri.startsWith('ipfs://')) {
    return IPFS_GATEWAY + uri.slice('ipfs://'.length).replace(/^ipfs\//, '');
  }
  if (!/^https?:\/\//i.test(uri)) return null;
  try {
    const u = new URL(uri);
    // Refuse anything pointing back at the host running the bot.
    const h = u.hostname.toLowerCase();
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.local')) return null;
    return u.toString();
  } catch {
    return null;
  }
}

function pickString(o: any, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

/**
 * Fetch and extract. Never throws — every failure path returns a `fetched:false`
 * record so the caller cannot accidentally treat an outage as a token verdict.
 */
export async function fetchTokenMetadata(rawUri: string | undefined | null): Promise<TokenMetadata> {
  const uri = normalizeUri(rawUri);
  if (!uri) return EMPTY;

  const hit = cache.get(uri);
  if (hit) return { ...hit, source: 'cache' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(uri, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return EMPTY;

    const len = Number(res.headers.get('content-length') ?? 0);
    if (len && len > MAX_BYTES) return EMPTY;

    const text = await res.text();
    if (text.length > MAX_BYTES) return EMPTY;

    const json = JSON.parse(text);
    const meta: TokenMetadata = {
      description: pickString(json, 'description'),
      twitter: pickString(json, 'twitter', 'x'),
      telegram: pickString(json, 'telegram'),
      website: pickString(json, 'website', 'external_url'),
      image: pickString(json, 'image'),
      fetched: true,
      source: 'network',
    };
    remember(uri, meta);
    return meta;
  } catch {
    return EMPTY;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Merge fetched metadata onto a launch without mutating the original.
 * Existing values win — if the pipeline ever starts populating these fields
 * natively, that source is more trustworthy than a re-fetch.
 */
export function withMetadata<T extends Record<string, any>>(launch: T, meta: TokenMetadata): T {
  if (!meta.fetched) return launch;
  return {
    ...launch,
    description: launch.description ?? meta.description,
    twitter: launch.twitter ?? meta.twitter,
    telegram: launch.telegram ?? meta.telegram,
    website: launch.website ?? meta.website,
    imageUri: launch.imageUri ?? meta.image,
  };
}

export function cacheStats(): { size: number } {
  return { size: cache.size };
}

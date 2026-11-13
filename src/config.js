// Settings. Plain values live in wrangler.toml [vars]; secrets are set in the Cloudflare dashboard.
//   MLSGRID_TOKEN   (secret)  MLS Grid access token for the Broker Back Office subscription
//   CONNECTOR_KEYS  (secret)  comma-separated "name:key" pairs, one per person, e.g. "pete:abc123,chris:def456"

export const VERSION = '0.1.0';

export function config(env) {
  return {
    base: env.MLSGRID_BASE || 'https://api.mlsgrid.com/v2',
    source: (env.ORIGINATING_SYSTEM || 'mred').toLowerCase(),
    token: env.MLSGRID_TOKEN || '',
    keyPrefix: env.KEY_PREFIX ?? 'MRD', // MLS Grid key prefix for MRED; stripped before display
    aiEnabled: String(env.AI_ACCESS_ENABLED ?? 'true').toLowerCase() !== 'false', // kill switch for the Claude connector (AI Use Addendum 3(c))
    maxResults: num(env.MAX_RESULTS, 25),
    serviceArea: parseServiceArea(env.SERVICE_AREA || 'IA:Scott;IL:Rock Island;IL:Henry'),
    pageSize: num(env.SYNC_PAGE_SIZE, 5000),
    // MLS Grid lets us filter by PropertyType on its side (max 5 'or's). Empty = all types.
    propertyTypes: (env.SYNC_PROPERTY_TYPES ?? 'Residential').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 6),
    maxPages: num(env.SYNC_MAX_PAGES, 10),
    allowLarger: String(env.ALLOW_LARGER_REQUESTS ?? 'false').toLowerCase() === 'true',
    timeBudgetMs: num(env.SYNC_TIME_BUDGET_MS, 12 * 60 * 1000),
    requestGapMs: num(env.SYNC_REQUEST_GAP_MS, 600), // MLS Grid allows 2 requests/second
    adminAgents: (env.ADMIN_AGENTS || 'pete').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    keys: parseKeys(env.CONNECTOR_KEYS || ''),
  };
}

const num = (v, d) => (v === undefined || v === '' || isNaN(Number(v)) ? d : Number(v));

// "IA:Scott;IL:Rock Island" -> { IA: Set{'scott'}, IL: Set{'rock island'} }
export function parseServiceArea(s) {
  const out = {};
  s.split(';').map((x) => x.trim()).filter(Boolean).forEach((pair) => {
    const [st, county] = pair.split(':').map((x) => x.trim());
    if (!st || !county) return;
    const k = st.toUpperCase();
    (out[k] = out[k] || new Set()).add(normCounty(county));
  });
  return out;
}

export function parseKeys(s) {
  return s.split(',').map((x) => x.trim()).filter(Boolean).map((pair) => {
    const i = pair.indexOf(':');
    return i > 0 ? { name: pair.slice(0, i).trim(), key: pair.slice(i + 1).trim() } : null;
  }).filter((k) => k && k.key.length >= 16);
}

export const normCounty = (c) => String(c || '').toLowerCase().replace(/\s+county$/, '').replace(/\s+/g, ' ').trim();

// Quad Cities cities, used only when a record has no county.
export const QC_CITIES = {
  IA: ['davenport', 'bettendorf', 'le claire', 'leclaire', 'eldridge', 'blue grass', 'walcott', 'princeton', 'long grove', 'riverdale', 'park view', 'donahue', 'dixon', 'maysville', 'mccausland', 'buffalo', 'new liberty'],
  IL: ['moline', 'east moline', 'rock island', 'silvis', 'milan', 'coal valley', 'carbon cliff', 'hampton', 'port byron', 'rapids city', 'cordova', 'hillsdale', 'andalusia', 'colona', 'orion', 'geneseo', 'taylor ridge', 'reynolds', 'illinois city', 'oak grove'],
};

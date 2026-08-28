import fs from 'fs';
import { fetchTokenMetadata, withMetadata, normalizeUri } from '../agent/metadataFetcher';
import { buildDossier, renderDossier, estimateTokens } from '../agent/dossier';

async function main() {
  const rows = fs.readFileSync('reports/candidates-2026-08-10.jsonl', 'utf8')
    .split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r: any) => r?.payload?.uri && r?.launchData);

  console.log(`rows with uri: ${rows.length}`);
  console.log('normalizeUri refusals:',
    ['ipfs://QmX', 'http://localhost/x', 'file:///etc/passwd', 'data:text/json,{}', 'https://ipfs.io/ipfs/QmX']
      .map(u => `${u} -> ${normalizeUri(u)}`).join('\n  '));

  let hits = 0, withDesc = 0, withSocial = 0;
  const sample = rows.slice(0, 8);
  for (const r of sample) {
    const meta = await fetchTokenMetadata(r.payload.uri);
    if (meta.fetched) hits++;
    if (meta.description) withDesc++;
    if (meta.twitter || meta.telegram || meta.website) withSocial++;
  }
  console.log(`\nfetched ${hits}/${sample.length} | with description ${withDesc} | with socials ${withSocial}`);

  // Before/after on one token.
  const r = sample.find(Boolean);
  const meta = await fetchTokenMetadata(r.payload.uri);
  const before = renderDossier(buildDossier(r.launchData, r.rug ?? null, false));
  const after = renderDossier(buildDossier(withMetadata(r.launchData, meta) as any, r.rug ?? null, false));
  console.log('\n--- BEFORE (untrusted block) ---');
  console.log(before.split('TOKEN METADATA')[1]?.split('UNVERIFIED FIELDS')[0]);
  console.log('--- AFTER (untrusted block) ---');
  console.log(after.split('TOKEN METADATA')[1]?.split('UNVERIFIED FIELDS')[0]);
  console.log(`tokens: ${estimateTokens(before)} -> ${estimateTokens(after)}`);
}
main().catch(e => { console.error(e); process.exit(1); });

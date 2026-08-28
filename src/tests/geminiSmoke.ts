/** One-shot key + model + schema smoke test. Costs one tiny call. */
import fs from 'fs';
const key = (fs.readFileSync('.env','utf8').match(/^GEMINI_API_KEY=(.+)$/m) || [])[1];
const MODELS = ['gemini-3.1-flash-lite', 'gemini-3-flash', 'gemini-3.7-flash'];
(async () => {
  for (const model of MODELS) {
    const t0 = Date.now();
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key! },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: ok' }] }],
          generationConfig: { responseMimeType: 'application/json',
            responseSchema: { type: 'OBJECT', properties: { w: { type: 'STRING' } }, required: ['w'] },
            thinkingConfig: { thinkingLevel: 'low' } },
        }),
      });
      const body: any = await res.json().catch(() => ({}));
      const text = body?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      console.log(`${model}: HTTP ${res.status} ${Date.now()-t0}ms ${text ? 'schema-ok' : (body?.error?.message ?? '').slice(0,110)}`);
    } catch (e: any) { console.log(`${model}: ERR ${e?.message}`); }
  }
})();

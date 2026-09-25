// narrator.js – der «Director» spricht. Die KI schreibt nur den Kommentar zu einem Burn,
// der bereits nach den Regeln passiert ist. Sie entscheidet nichts über Geld.
//
// mode "auto": Claude-API, wenn ANTHROPIC_API_KEY gesetzt ist – sonst Vorlagen.
// Der Text ist immer auf 160 Zeichen begrenzt, ohne Preisversprechen.

const SCIENTISTS = ['Kofi Adeyemi', 'Yuki Nakamura', '"Big Sal" Moreno', 'Dr. Ada Lindqvist', 'Chief Kowalski'];

const TEMPLATES = {
  ritual: [
    '{sci} logs the hourly feed. {tokens} {sym} into the furnace. Supply only goes one way.',
    'Hourly cycle complete. {sol} SOL of fees became {tokens} {sym} and then heat.',
    'The furnace is fed on schedule. {tokens} {sym} removed from circulation, receipt attached.',
  ],
  dip: [
    'Price dropped {dip}% in an hour. The Director bought the dip and burned it: {tokens} {sym}.',
    'Red candle detected. {sci} feeds {tokens} {sym} to the furnace early. Rules are rules.',
  ],
  surge: [
    'Fee vault crossed {surge} SOL. Surge protocol: {tokens} {sym} burned ahead of schedule.',
    'Heavy volume. {sci} did not wait for the hour: {sol} SOL → {tokens} {sym} → ash.',
  ],
  devburn: [
    'Milestone reached: ${mcap} market cap. The lab burns {tokens} {sym} of its own founding stake.',
    'Founders\' tranche {tranche} released to the furnace: {tokens} {sym}. The team bag shrinks, never sells.',
  ],
};

export function pickScientist(rand = Math.random) {
  return SCIENTISTS[Math.floor(rand() * SCIENTISTS.length)];
}

export function templateNote(entry, rand = Math.random) {
  const list = TEMPLATES[entry.reason] || TEMPLATES.ritual;
  const t = list[Math.floor(rand() * list.length)];
  return fill(t, entry);
}

function fill(t, e) {
  return t
    .replace('{sci}', e.scientist || pickScientist())
    .replace('{tokens}', fmtInt(e.tokens))
    .replace('{sym}', '$' + e.symbol)
    .replace('{sol}', (e.sol ?? 0).toFixed(3))
    .replace('{dip}', e.dipPct != null ? String(Math.round(e.dipPct)) : '15')
    .replace('{surge}', String(e.surgeSol ?? 1))
    .replace('{mcap}', fmtInt(e.mcapUsd ?? 0))
    .replace('{tranche}', String((e.tranche ?? 0) + 1));
}

/**
 * Kommentar erzeugen. Bei Claude-API-Fehlern immer Vorlage – der Bot bleibt nie hängen.
 */
export async function narrate(entry, { apiKey, model, mode = 'auto', rand = Math.random } = {}) {
  const fallback = templateNote(entry, rand);
  if (mode === 'template' || !apiKey) return fallback;
  try {
    const facts = {
      reason: entry.reason, tokensBurned: fmtInt(entry.tokens), symbol: '$' + entry.symbol,
      solFed: entry.sol, dipPct: entry.dipPct, mcapUsd: entry.mcapUsd, scientist: entry.scientist,
      burnCountTotal: entry.burnCountTotal, burnedPctOfSupply: entry.burnedPct,
    };
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model, max_tokens: 120,
        system: 'You are the Director, an AI running Liberty Labs, a lab whose scientists burn a memecoin\'s supply. Write ONE log line (max 150 characters) about the burn described in the JSON. Dry, calm, slightly theatrical. Only state the given facts. Never predict price, never promise gains, never tell anyone to buy. No hashtags, no emojis, no quotes.',
        messages: [{ role: 'user', content: JSON.stringify(facts) }],
      }),
    });
    if (!res.ok) return fallback;
    const j = await res.json();
    const text = (j.content?.[0]?.text || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 200 || /guarantee|moon|100x|will rise|buy now/i.test(text)) return fallback;
    return text;
  } catch { return fallback; }
}

export function fmtInt(n) { return Math.round(n ?? 0).toLocaleString('en-US'); }

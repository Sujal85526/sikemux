export const SUBSEQ_BASE = 1_000_000;

function isWordBoundary(ch: string | undefined): boolean {
    return ch === undefined || !/[a-z0-9]/i.test(ch);
}

function scoreField(q: string, text: string): number {
    const t = text.toLowerCase();
    const idx = t.indexOf(q);
    if (idx >= 0) {
        return (isWordBoundary(t[idx - 1]) ? 0 : 1000) + idx;
    }
    let ti = 0;
    let score = 0;
    let prev = -2;
    for (let qi = 0; qi < q.length; qi += 1) {
        const found = t.indexOf(q[qi], ti);
        if (found === -1) return -1;
        score += found - prev === 1 ? 0 : found;
        prev = found;
        ti = found + 1;
    }
    return SUBSEQ_BASE + score;
}

export function fuzzyScore(query: string, ...fields: string[]): number {
    const q = query.trim().toLowerCase();
    if (!q) return 0;
    let best = -1;
    for (let i = 0; i < fields.length; i += 1) {
        const s = scoreField(q, fields[i]);
        if (s < 0) continue;
        const ranked = s + i; // nudge ties toward earlier fields
        if (best < 0 || ranked < best) best = ranked;
    }
    return best;
}

export function isSubstringMatch(score: number): boolean {
    return score >= 0 && score < SUBSEQ_BASE;
}

export function rankBy<T>(query: string, items: readonly T[], fields: (item: T) => string | string[]): T[] {
    if (!query.trim()) return items.slice();
    const scored: { item: T; score: number }[] = [];
    for (const item of items) {
        const f = fields(item);
        const score = Array.isArray(f) ? fuzzyScore(query, ...f) : fuzzyScore(query, f);
        if (score >= 0) scored.push({ item, score });
    }
    const hasSubstring = scored.some((x) => isSubstringMatch(x.score));
    const kept = hasSubstring ? scored.filter((x) => isSubstringMatch(x.score)) : scored;
    kept.sort((a, b) => a.score - b.score);
    return kept.map((x) => x.item);
}

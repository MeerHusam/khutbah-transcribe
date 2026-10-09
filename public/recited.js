// recited.js — Which words of a verse the imam recited. Shared by the reader page (loaded as a
// plain script) and Node (verse_excerpts.js imports it for its side effect), so the page's
// bolding and the stored recited-part excerpts always agree on the same words.
(function (root) {
  // Mirrors normalizeArabic() in pipeline.js — the ref's detected_text and the transcript
  // differ only in punctuation and diacritics, so both sides must be normalised the same way.
  function normArWord(w) {
    return w
      .replace(/[\u0610-\u061A]/g, '')
      .replace(/\u0670/g, 'ا')
      .replace(/[\u064B-\u065F]/g, '')
      .replace(/\u0640/g, '')
      .replace(/[\u06D6-\u06ED]/g, '')
      .replace(/[\u0671\u0622\u0623\u0625]/g, 'ا')
      .replace(/[.,!?;:؟،؛"'`(){}\[\]«»﴿﴾…—–-]/g, '');
  }

  // Loose word form for aligning the imam's words to the mushaf text: drops every alif and
  // hamza seat and folds ى/ة, so هذا ↔ هَٰذَا and ءامنوا ↔ آمنوا still line up.
  const looseAr = w => normArWord(w).replace(/[\u08F0-\u08FF]/g, '').replace(/[اءأإآٱئؤ]/g, '').replace(/ى/g, 'ي').replace(/ة/g, 'ه');

  // For each verse, the [first, last] canonical word index the imam recited, or null.
  // Longest-common-subsequence alignment, so skipped or misheard words don't break it.
  function recitedSpans(recitedText, verseTexts) {
    const rw = recitedText.split(/\s+/).map(looseAr).filter(Boolean);
    const cw = [];
    verseTexts.forEach((t, v) => t.split(/\s+/).filter(Boolean).forEach((w, i) => cw.push({ v, i, k: looseAr(w) })));
    const n = cw.length, m = rw.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let a = n - 1; a >= 0; a--) for (let b = m - 1; b >= 0; b--) {
      dp[a][b] = cw[a].k && cw[a].k === rw[b] ? dp[a + 1][b + 1] + 1 : Math.max(dp[a + 1][b], dp[a][b + 1]);
    }
    const hit = verseTexts.map(() => []);
    for (let a = 0, b = 0; a < n && b < m;) {
      if (cw[a].k && cw[a].k === rw[b]) { hit[cw[a].v].push([cw[a].i, b]); a++; b++; }
      else if (dp[a + 1][b] >= dp[a][b + 1]) a++; else b++;
    }
    // Enough hits to trust: three, or half of a short verse (Abasa 80:28 is two words).
    return hit.map((h, v) => {
      const kept = withoutStrays(h);
      const need = Math.min(3, Math.ceil(verseTexts[v].split(/\s+/).filter(Boolean).length / 2));
      if (kept.length < need) return null;
      // A recited word matched elsewhere in the verse and dropped as a stray may stand right beside
      // the kept part: on 9 Oct 2026 "لا تحزن إن الله معنا" paired its "لا" with 9:40's opening
      // "إلا" (alef set aside), 18 words earlier, and the card began at "تحزن". Grow the part at
      // both ends while the verse's next word is the imam's next word.
      let [lo, hi] = [Math.min(...kept), Math.max(...kept)];
      const vw = cw.filter(x => x.v === v).map(x => x.k);
      let bLo = h.find(([i]) => i === lo)[1], bHi = h.find(([i]) => i === hi)[1];
      while (lo > 0 && bLo > 0 && vw[lo - 1] && vw[lo - 1] === rw[bLo - 1]) { lo--; bLo--; }
      while (hi + 1 < vw.length && bHi + 1 < m && vw[hi + 1] && vw[hi + 1] === rw[bHi + 1]) { hi++; bHi++; }
      return [lo, hi];
    });
  }

  // A common word matched far from the rest of its verse while the imam's words run on is not
  // where he recited: on 2 Oct 2026 (Madinah) his "من يتق الله…" paired its "من" with 65:4's
  // "من المحيض", 18 words earlier, and the card showed the whole verse as recited. The hits are
  // cut into runs wherever the verse jumps more than 3 words further than the imam's words do;
  // runs of one or two words beside a longer run are dropped. [[verse index, recited index]] ->
  // the verse indexes kept.
  function withoutStrays(h) {
    const runs = [];
    h.forEach(([i, b], j) => {
      if (!j || (i - h[j - 1][0]) - (b - h[j - 1][1]) > 3) runs.push([]);
      runs[runs.length - 1].push(i);
    });
    const long = runs.filter(r => r.length >= 3);
    return [].concat(...(long.length ? long : runs));
  }

  root.KTRecited = { normArWord, looseAr, recitedSpans };
})(typeof window !== 'undefined' ? window : globalThis);

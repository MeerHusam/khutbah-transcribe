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
      if (cw[a].k && cw[a].k === rw[b]) { hit[cw[a].v].push(cw[a].i); a++; b++; }
      else if (dp[a + 1][b] >= dp[a][b + 1]) a++; else b++;
    }
    // Enough hits to trust: three, or half of a short verse (Abasa 80:28 is two words).
    return hit.map((h, v) => {
      const need = Math.min(3, Math.ceil(verseTexts[v].split(/\s+/).filter(Boolean).length / 2));
      return h.length >= need ? [Math.min(...h), Math.max(...h)] : null;
    });
  }

  root.KTRecited = { normArWord, looseAr, recitedSpans };
})(typeof window !== 'undefined' ? window : globalThis);

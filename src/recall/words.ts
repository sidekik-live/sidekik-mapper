/** Words that match nearly every turn in German or English, so they never count as a match. */
const STOPWORDS = new Set(
  (
    'und oder aber der die das den dem des ein eine einen einem einer eines ist sind war waren was wie wer wem wen ' +
    'warum wann wieso ich mir mich wir uns ihr sie ihm ihn ihnen ihre ihren sein seine mit von auf für bei nicht ' +
    'auch dann wenn noch nur hat haben habe hatte wird werden kann können man mein meine dein sich dass als ' +
    'mache machen macht immer schon sehr hier dort denn doch also bitte ' +
    'the and but for with what who whom how why when where did does was were are you your she her his him they ' +
    'them this that these those from have has had not can will would should about into our out just then there'
  ).split(' '),
);

/**
 * Lower-case words of 3+ letters or digits (umlauts and ß included), without stopwords, for simple
 * lexical matching. Digit groups are joined first, so "5.000" and "5,000" both read as "5000".
 */
export function words(text: string): string[] {
  const joined = text.normalize('NFKC').toLowerCase().replace(/(\d)[.,'’](?=\d{3}\b)/g, '$1');
  return (joined.match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => !STOPWORDS.has(w));
}

/** Share of the query's distinct words that appear in `text`: 0 (none) to 1 (all). */
export function overlap(query: string[], text: string): number {
  const distinct = [...new Set(query)];
  if (distinct.length === 0) return 0;
  const have = new Set(words(text));
  return distinct.filter((w) => have.has(w)).length / distinct.length;
}

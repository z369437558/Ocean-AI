/**
 * Text folding for search and sort.
 *
 * SQLite on its own only knows that "a" and "A" are the same letter for the 26 ASCII letters: with
 * LIKE or COLLATE NOCASE a search for "álvarez" would not find "Álvarez", and "Élodie" would sort
 * after "Zoe". Names are therefore folded once, in JavaScript, when a row is written, and the
 * folded form is stored next to the name (the `*_key` columns in the schema). Searching and
 * sorting use that stored key, and the search text goes through the same function, so both sides
 * always agree.
 *
 * The folding ignores case and accents:
 *   - compatibility forms are unified (full-width letters, ligatures, non-breaking spaces),
 *   - accents are dropped ("é" -> "e", "Å" -> "a"), and so is an accent typed on its own ("´", "¨"),
 *   - everything is lower-cased, and the two lower-case forms of the Greek sigma are unified,
 *   - the Latin letters that Unicode does not describe as "a base letter plus an accent" are
 *     replaced by the usual plain spelling ("ø" -> "o", "ł" -> "l", "ß" -> "ss", ...; see below).
 *
 * "Accents" are the combining marks U+0300-036F wherever they occur, so Greek and Cyrillic letters
 * lose theirs as well ("ά" -> "α", "й" -> "и"). The marks of other scripts are not accents and
 * stay (Devanagari vowel signs, kana voicing marks ...): apart from case, those scripts are
 * compared as written.
 */

/**
 * Combining accents (U+0300-036F), together with the space that carries one when an accent stands
 * alone: NFKD turns "´" into a space plus a combining acute. Dropping only the mark would leave
 * that space behind, and a search for "´" would find every name that contains a space.
 */
const ACCENTS = / ?[\u0300-\u036f]+/g;

/** Lower-case Latin letters without a decomposition, and how they are usually written without them. */
const PLAIN_SPELLINGS = new Map([
  ['ß', 'ss'],
  ['æ', 'ae'],
  ['œ', 'oe'],
  ['ø', 'o'],
  ['đ', 'd'],
  ['ð', 'd'],
  ['þ', 'th'],
  ['ł', 'l'],
  ['ħ', 'h'],
  ['ŧ', 't'],
  ['ı', 'i'], // Turkish dotless i ("İ" already folds to "i" through its decomposition)
]);
const LETTERS_WITH_PLAIN_SPELLING = new RegExp(`[${[...PLAIN_SPELLINGS.keys()].join('')}]`, 'g');

export function foldText(text) {
  return String(text)
    .normalize('NFKD')
    .replace(ACCENTS, '')
    .toLowerCase()
    .replaceAll('ς', 'σ')
    .replace(LETTERS_WITH_PLAIN_SPELLING, (letter) => PLAIN_SPELLINGS.get(letter))
    .normalize('NFC');
}

/**
 * Text folding for search and sort.
 *
 * SQLite on its own only knows that "a" and "A" are the same letter for the 26 ASCII letters: with
 * LIKE or COLLATE NOCASE a search for "álvarez" would not find "Álvarez", and "Élodie" would sort
 * after "Zoe". Names are therefore folded once, in JavaScript, when a certificate is issued, and the
 * folded form is stored next to the name (see `learner_name_key` / `course_title_key` in the
 * schema). Searching and sorting use that stored key, and the search text goes through the same
 * function, so both sides always agree.
 *
 * The folding ignores case and accents:
 *   - compatibility forms are unified (full-width letters, ligatures, non-breaking spaces),
 *   - accents written as combining marks are dropped ("é" -> "e", "Å" -> "a"),
 *   - everything is lower-cased, and the two lower-case forms of the Greek sigma are unified.
 *
 * Letters that are not "a base letter plus an accent" in Unicode (ø, ß, ł, ı ...) stay as they are,
 * and so do the marks of scripts in which they are not accents (Devanagari vowel signs, Hangul ...).
 */
const COMBINING_DIACRITICAL_MARKS = /[̀-ͯ]+/g;

export function foldText(text) {
  return String(text)
    .normalize('NFKD')
    .replace(COMBINING_DIACRITICAL_MARKS, '')
    .toLowerCase()
    .replaceAll('ς', 'σ')
    .normalize('NFC');
}

/** RFC 4180 style CSV encoding with spreadsheet formula-injection hardening. */

const NEEDS_QUOTING = /[",\r\n]/;
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

export function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  // A cell that starts with = + - @ is executed as a formula by Excel/Sheets, and so is one that
  // hides such a start behind a tab or a carriage return. Learner names are user-controlled, so
  // neutralise all of those with a leading apostrophe (OWASP CSV-injection guidance).
  if (FORMULA_TRIGGER.test(text)) text = `'${text}`;
  return NEEDS_QUOTING.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function csvRow(cells) {
  let line = '';
  for (let i = 0; i < cells.length; i += 1) {
    if (i > 0) line += ',';
    line += csvCell(cells[i]);
  }
  return `${line}\n`;
}

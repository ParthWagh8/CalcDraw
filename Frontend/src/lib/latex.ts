/** LaTeX display strings for answer chips.
 *
 * Pure functions (no failure modes, no logging needed). TeX math mode eats
 * raw whitespace, so "Who is" would typeset as "Whois" — spaces are escaped
 * as "\ " which math mode honors, while math (^, +, =, ...) is untouched.
 */

export function escapeTexSpaces(s: string): string {
  return s.replace(/\s/g, '\\ ');
}

export function toLatexDisplay(expression: string, answer: string): string {
  return `\\(\\LARGE{${escapeTexSpaces(expression)} = ${escapeTexSpaces(answer)}}\\)`;
}

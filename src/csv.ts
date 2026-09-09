export function csvCell(value: unknown) {
  const text = String(value ?? "");
  const spreadsheetFormula =
    /^[=+\-@\t\r\n]/.test(text) || /^\s+[=+\-@]/.test(text);
  const literal = spreadsheetFormula ? `'${text}` : text;
  return `"${literal.replaceAll('"', '""')}"`;
}

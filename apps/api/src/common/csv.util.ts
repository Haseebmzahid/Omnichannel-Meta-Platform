// A tiny, dependency-free RFC 4180 CSV writer — the customer-export
// endpoint's only consumer today (customers/customers.service.ts), kept
// here as a generic utility rather than inlined there since "safe CSV
// escaping" is a self-contained concern worth testing on its own.

// Any field containing a comma, double-quote, or line break (\n or \r) must
// be wrapped in double quotes, with every internal double quote doubled —
// the exact RFC 4180 rule. A field with none of those characters is written
// as-is: no unnecessary quoting, so a plain CSV stays easy to read/diff.
export function escapeCsvField(value: string): string {
  if (/["\n\r,]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function toCsvRow(fields: string[]): string {
  return fields.map(escapeCsvField).join(',');
}

// CRLF row endings — RFC 4180's own line-ending, and what Excel expects to
// render a CSV cleanly rather than as one run-on line on Windows.
export function toCsv(headers: string[], rows: string[][]): string {
  const lines = [toCsvRow(headers), ...rows.map(toCsvRow)];
  return lines.join('\r\n') + '\r\n';
}

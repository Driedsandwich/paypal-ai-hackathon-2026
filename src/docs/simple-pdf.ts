// Minimal single-page PDF writer (PDF 1.4, built-in Helvetica, no dependencies).
// Used for the optional "invoice summary" attachment in dispute evidence.
// Non-ASCII characters are replaced, because the standard fonts only cover Latin-1.

function escapePdfText(s: string): string {
  return s
    .replace(/[^\x20-\x7e]/g, "?")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

/** Renders up to ~60 short lines of text on one A4 page. */
export function renderTextPdf(title: string, lines: string[]): Uint8Array {
  const all = [title, "", ...lines].slice(0, 60).map((l) => l.slice(0, 95));
  const content = [
    "BT",
    "/F1 11 Tf",
    "14 TL",
    "50 800 Td",
    ...all.map((l, i) => (i === 0 ? `/F1 14 Tf (${escapePdfText(l)}) Tj /F1 11 Tf T*` : `(${escapePdfText(l)}) Tj T*`)),
    "ET",
  ].join("\n");

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
  ];

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}

// Texts that go to PayPal or the buyer as they are (evidence notes, the reply draft) must not
// carry the AI's to-dos for the seller or claim attachments that are not attached (pass 5).
// The prompt and the JSON Schema say so; this module enforces it after the model answers.
// The repair removes the offending parts and moves them to `missing_information`, so the
// seller still sees them.

/** Bracketed placeholders or instructions: "[Seller: attach …]", "[tracking number]". */
const BRACKETED = /\s*\[[^\]\n]{0,400}\]/g;
/** Parenthesised notes addressed to the seller: "(Seller: …)", "(Note to seller: …)", "(TODO …)". */
const SELLER_PAREN = /\s*\((?:note to (?:the )?seller|seller|todo|to do|to-do)\b[^)\n]{0,400}\)/gi;
/** A sentence that says something is attached or enclosed. */
const ATTACHMENT_CLAIM = /\battach(?:ed|ment|ments|ing)?\b|\benclos(?:ed|ure|ing)\b|\bplease find\b|\bsee the (?:attached|enclosed)\b/i;
/** Things a text may claim to attach, and the attachment words that cover each. */
const ATTACHABLE: Array<{ re: RegExp; label: string }> = [
  { re: /\breceipts?\b/i, label: "receipt" },
  { re: /\bscreenshots?\b|\bscreen shots?\b/i, label: "screenshot" },
  { re: /\bphotos?\b|\bphotographs?\b|\bpictures?\b|\bimages?\b/i, label: "photo" },
  { re: /\bproof\b/i, label: "proof" },
  { re: /\btracking\b/i, label: "tracking" },
  { re: /\blabels?\b/i, label: "label" },
  { re: /\bsignatures?\b/i, label: "signature" },
  { re: /\bshipments?\b|\bshipping\b|\bpostage\b/i, label: "shipment" },
  { re: /\bdelivery\b/i, label: "delivery" },
  { re: /\binvoices?\b/i, label: "invoice" },
];

export interface AttachmentInfo {
  name: string;
  description: string;
}

export interface RepairResult {
  text: string;
  /** What was removed, in words for the seller's `missing_information`. */
  removed: string[];
}

function tidy(text: string): string {
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([.,;:!?])/g, "$1")
    .trim();
}

/** Labels of the attachable things an attachment really is (from its name and description). */
function coveredLabels(attachments: AttachmentInfo[]): Set<string> {
  const covered = new Set<string>();
  for (const a of attachments) {
    const words = `${a.name} ${a.description}`;
    for (const { re, label } of ATTACHABLE) if (re.test(words)) covered.add(label);
  }
  return covered;
}

/**
 * True when a sentence claims an attachment that is not in `attachments`: any attachment claim
 * when nothing is attached, or one that names something (receipt, screenshot, proof, tracking …)
 * that no attachment's name or description covers. "Attached: invoice summary" is fine when the
 * invoice summary PDF is attached.
 */
export function claimsMissingAttachment(sentence: string, attachments: AttachmentInfo[]): boolean {
  if (!ATTACHMENT_CLAIM.test(sentence)) return false;
  if (attachments.length === 0) return true;
  const covered = coveredLabels(attachments);
  const named = ATTACHABLE.filter(({ re }) => re.test(sentence)).map((x) => x.label);
  return named.some((label) => !covered.has(label));
}

/** Seller instructions (bracketed or "(Seller: …)") found in a text. */
export function sellerInstructions(text: string): string[] {
  return [...text.matchAll(BRACKETED), ...text.matchAll(SELLER_PAREN)].map((m) => m[0].trim());
}

/** Splits into sentences and lines, keeping the separators so the text can be put back together. */
function pieces(text: string): string[] {
  return text.split(/(?<=[.!?])(?=\s)|(?=\n)/);
}

/**
 * Removes seller instructions and false attachment claims from a text that will be sent as is.
 * Returns the repaired text and what was removed (for `missing_information`).
 */
export function repairSendableText(text: string, attachments: AttachmentInfo[]): RepairResult {
  const removed: string[] = [];
  let out = text.replace(BRACKETED, (m) => {
    removed.push(`To do: ${m.trim().replace(/^\[|\]$/g, "").trim()}`);
    return "";
  });
  out = out.replace(SELLER_PAREN, (m) => {
    removed.push(`To do: ${m.trim().replace(/^\(|\)$/g, "").trim()}`);
    return "";
  });
  out = pieces(out)
    .filter((p) => {
      if (!claimsMissingAttachment(p, attachments)) return true;
      removed.push(`Removed a claim that something is attached, but it is not: "${p.trim().slice(0, 200)}". Attach the file at PayPal yourself if you have it.`);
      return false;
    })
    .join("");
  return { text: tidy(out), removed };
}

/** Problems that make a text unfit to send as is (empty when fine). */
export function sendableTextProblems(text: string, attachments: AttachmentInfo[]): string[] {
  const problems = sellerInstructions(text).map((s) => `contains an instruction or placeholder for the seller: ${s.slice(0, 120)}`);
  for (const p of pieces(text)) if (claimsMissingAttachment(p, attachments)) problems.push(`claims an attachment that is not attached: ${p.trim().slice(0, 120)}`);
  return problems;
}

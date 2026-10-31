#!/usr/bin/env node
// Pre-publish check: scans git-tracked files for things that must not be made public
// (secret-looking strings, absolute local paths, email addresses).
// Extra patterns can be listed in .prepublish-local-patterns (one regex per line,
// lines starting with # are comments). That file is git-ignored and must stay local.
// Exit code: 0 = clean, 1 = findings, 2 = the check itself failed.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LOCAL_PATTERNS_FILE = ".prepublish-local-patterns";
const MAX_FILE_BYTES = 5 * 1024 * 1024;

// Patterns are written so that this file does not match itself.
export const BUILTIN_RULES = [
  { id: "private-key-block", re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/ },
  { id: "aws-access-key-id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/ },
  { id: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { id: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}/ },
  { id: "sk-style-api-key", re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { id: "paypal-access-token", re: /\bA21AA[A-Za-z0-9_-]{20,}/ },
  { id: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { id: "credentials-in-url", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@"'`]+:[^\s/@"'`]+@[^\s/]+/i },
  {
    // name = "value" / name: 'value' (code, JSON, YAML)
    id: "secret-assignment",
    re: /\b[\w.-]*(?:secret|passw(?:or)?d|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)[\w.-]*["']?\s*[:=]\s*["'`]([^"'`\s]{12,})["'`]/i,
    // Obvious placeholders used in docs and tests are not secrets.
    ignoreValue: /(?:fake|test|example|dummy|placeholder|changeme|your[_-]|x{6,}|\.\.\.)/i,
  },
  {
    // NAME=value at line start (.env style)
    id: "secret-env-line",
    re: /^\s*(?:export\s+)?[A-Z0-9_]*(?:SECRET|PASSWORD|API_KEY|TOKEN|PRIVATE_KEY)[A-Z0-9_]*\s*=\s*["']?([^"'\s#]{8,})/,
    ignoreValue: /(?:fake|test|example|dummy|placeholder|changeme|your[_-]|x{6,}|\.\.\.|\$\{)/i,
  },
  { id: "abs-path-macos", re: /\/Users\/[^/\s"'`]+/ },
  { id: "abs-path-linux", re: /\/home\/[^/\s"'`]+/ },
  { id: "abs-path-windows", re: /\b[A-Za-z]:\\{1,2}Users\\{1,2}/i },
  { id: "email-address", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/ },
];

/** Parses the local patterns file. Invalid regexes are treated as literal text. */
export function parseLocalPatterns(text) {
  const rules = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    let re;
    try {
      re = new RegExp(line, "i");
    } catch {
      re = new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    }
    rules.push({ id: "local-pattern", re });
  }
  return rules;
}

function mask(text) {
  if (text.length <= 6) return "*".repeat(text.length);
  return `${text.slice(0, 4)}…(${text.length} chars)`;
}

/** Scans one text. Returns [{ line, rule, preview }]. */
export function scanText(text, rules = BUILTIN_RULES) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const rule of rules) {
      const flags = rule.re.flags.includes("g") ? rule.re.flags : `${rule.re.flags}g`;
      const re = new RegExp(rule.re.source, flags);
      for (const m of line.matchAll(re)) {
        const value = m[1] ?? m[0];
        if (rule.ignoreValue && rule.ignoreValue.test(value)) continue;
        findings.push({ line: i + 1, rule: rule.id, preview: mask(m[0]) });
        break;
      }
    }
  });
  return findings;
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Scans files (paths relative to root). Returns [{ file, line, rule, preview }]. */
export function scanFiles(files, root, rules = BUILTIN_RULES) {
  const findings = [];
  for (const file of files) {
    const abs = path.join(root, file);
    if (!existsSync(abs) || !statSync(abs).isFile()) continue;
    if (statSync(abs).size > MAX_FILE_BYTES) continue;
    const buf = readFileSync(abs);
    if (isBinary(buf)) continue;
    for (const f of scanText(buf.toString("utf8"), rules)) findings.push({ file, ...f });
  }
  return findings;
}

export function listTrackedFiles(root) {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" });
  return out.split("\0").filter(Boolean);
}

export function loadRules(root) {
  const local = path.join(root, LOCAL_PATTERNS_FILE);
  const extra = existsSync(local) ? parseLocalPatterns(readFileSync(local, "utf8")) : [];
  return { rules: [...BUILTIN_RULES, ...extra], localCount: extra.length };
}

export function run(cwd = process.cwd()) {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim();
  const files = listTrackedFiles(root);
  const { rules, localCount } = loadRules(root);
  const findings = scanFiles(files, root, rules);
  console.log(`prepublish-check: scanned ${files.length} tracked files with ${rules.length} rules (${localCount} local).`);
  if (files.includes(LOCAL_PATTERNS_FILE)) {
    findings.push({ file: LOCAL_PATTERNS_FILE, line: 0, rule: "local-patterns-file-tracked", preview: "must not be committed" });
  }
  for (const f of findings) console.log(`  ${f.file}:${f.line}  [${f.rule}]  ${f.preview}`);
  if (findings.length > 0) {
    console.log(`prepublish-check: FAILED with ${findings.length} finding(s).`);
    return 1;
  }
  console.log("prepublish-check: OK");
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    process.exitCode = run();
  } catch (err) {
    console.error(`prepublish-check: error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
  }
}

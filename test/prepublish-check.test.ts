import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { BUILTIN_RULES, parseLocalPatterns, scanText } from "../scripts/prepublish-check.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/prepublish-check.mjs", import.meta.url));

// Bait strings are assembled at runtime so this file itself stays clean.
const j = (...parts: string[]) => parts.join("");
const BAIT: Record<string, string> = {
  "private-key-block": j("-----BEGIN ", "PRIVATE KEY-----"),
  "aws-access-key-id": j("AKIA", "Q3ZK7Y2N5M8P1R4T"),
  "github-token": j("ghp", "_", "a".repeat(20), "B".repeat(16)),
  "slack-token": j("xox", "b-", "123456789012-abcdef"),
  "google-api-key": j("AI", "za", "Sy", "Q".repeat(33)),
  "sk-style-api-key": j("s", "k-", "Zq9", "w".repeat(30)),
  "paypal-access-token": j("A21", "AA", "Kx9".repeat(10)),
  jwt: j("ey", "JhbGciOiJIUzI1NiJ9", ".", "ey", "JzdWIiOiIxMjM0NTY3ODkwIn0", ".", "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV"),
  "credentials-in-url": j("https", "://admin", ":", "hunter2hunter2", "@", "db.internal.invalid/x"),
  "secret-assignment": j("client", "_secret", ': "', "Zx81Qp0Lm2Nv7Rt5Wy", '"'),
  "secret-env-line": j("PAYPAL_CLIENT_", "SECRET=", "EOq81Zr0Lm2Nv7Rt5Wy"),
  "abs-path-macos": j("/Us", "ers/", "alice/project"),
  "abs-path-linux": j("/ho", "me/", "alice/project"),
  "abs-path-windows": j("C:", "\\", "Users", "\\", "alice"),
  "email-address": j("alice", "@", "corp", ".", "invalid"),
};

describe("prepublish-check rules", () => {
  it.each(Object.entries(BAIT))("detects %s", (rule, bait) => {
    const hits = scanText(`before\n  ${bait} trailing\nafter`).map((f) => f.rule);
    expect(hits).toContain(rule);
  });

  it("covers every built-in rule with a bait sample", () => {
    expect(BUILTIN_RULES.map((r) => r.id).sort()).toEqual(Object.keys(BAIT).sort());
  });

  it("ignores ordinary code and obvious placeholders", () => {
    const clean = [
      "const clientSecret = env.PAYPAL_CLIENT_SECRET;",
      'clientSecret: "test-client-secret",',
      "PAYPAL_CLIENT_SECRET=",
      "PAYPAL_CLIENT_SECRET=${{ secrets.PAYPAL_CLIENT_SECRET }}",
      "base URL: https://api-m.sandbox.paypal.com/v2/checkout/orders",
    ].join("\n");
    expect(scanText(clean)).toEqual([]);
  });

  it("does not echo the full secret in its output", () => {
    const [finding] = scanText(BAIT["aws-access-key-id"]!);
    expect(finding!.preview).not.toContain(BAIT["aws-access-key-id"]);
  });

  it("parses local patterns as case-insensitive regexes, skipping comments", () => {
    const rules = parseLocalPatterns("# comment\n\nproject-codename\nacme[- ]corp\n(unclosed\n");
    expect(rules).toHaveLength(3);
    expect(scanText("we work at ACME Corp", rules)).toHaveLength(1);
    expect(scanText("literal (unclosed paren", rules)).toHaveLength(1);
  });
});

describe("prepublish-check CLI", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function makeRepo(files: Record<string, string>): string {
    dir = mkdtempSync(path.join(tmpdir(), "prepublish-check-"));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content);
    execFileSync("git", ["add", "-A"], { cwd: dir });
    return dir;
  }

  function runCli(cwd: string) {
    const r = spawnSync(process.execPath, [SCRIPT], { cwd, encoding: "utf8" });
    return { code: r.status, out: r.stdout + r.stderr };
  }

  it("exits 0 on a clean repo", () => {
    const repo = makeRepo({ "README.md": "# hello\n", "index.ts": "export const x = 1;\n" });
    const { code, out } = runCli(repo);
    expect(out).toContain("OK");
    expect(code).toBe(0);
  });

  it("exits 1 and names the file when tracked files contain bait", () => {
    const repo = makeRepo({
      "README.md": "# hello\n",
      "leak.txt": `${BAIT["private-key-block"]}\n${BAIT["abs-path-linux"]}\n${BAIT["email-address"]}\n`,
    });
    const { code, out } = runCli(repo);
    expect(code).toBe(1);
    expect(out).toContain("leak.txt:1  [private-key-block]");
    expect(out).toContain("leak.txt:2  [abs-path-linux]");
    expect(out).toContain("leak.txt:3  [email-address]");
  });

  it("does not scan untracked files", () => {
    const repo = makeRepo({ "README.md": "# hello\n" });
    writeFileSync(path.join(repo, "untracked.txt"), `${BAIT["aws-access-key-id"]}\n`);
    expect(runCli(repo).code).toBe(0);
  });

  it("reads extra words from the untracked local patterns file", () => {
    const repo = makeRepo({ "notes.md": "Internal codename: bluefalcon\n" });
    expect(runCli(repo).code).toBe(0);
    writeFileSync(path.join(repo, ".prepublish-local-patterns"), "# local only\nbluefalcon\n");
    const { code, out } = runCli(repo);
    expect(code).toBe(1);
    expect(out).toContain("notes.md:1  [local-pattern]");
  });

  it("fails if the local patterns file itself is tracked", () => {
    const repo = makeRepo({ ".prepublish-local-patterns": "nothing-matches-this-zzq\n" });
    const { code, out } = runCli(repo);
    expect(code).toBe(1);
    expect(out).toContain("local-patterns-file-tracked");
  });
});

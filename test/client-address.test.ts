import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { legacySettingWarnings, loadSettings } from "../src/config.js";
import { canonicalIp, clientAddress, limitKey } from "../src/http/client-address.js";

function req(remoteAddress: string | undefined, xff?: string | string[]): IncomingMessage {
  return { socket: { remoteAddress }, headers: xff === undefined ? {} : { "x-forwarded-for": xff } } as unknown as IncomingMessage;
}

describe("canonicalIp", () => {
  it("accepts IPv4/IPv6 and normalizes them", () => {
    expect(canonicalIp("203.0.113.7")).toBe("203.0.113.7");
    expect(canonicalIp(" 203.0.113.7:4711 ")).toBe("203.0.113.7");
    expect(canonicalIp("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(canonicalIp("2001:DB8:0:0:0:0:0:1")).toBe("2001:db8::1");
    expect(canonicalIp("[2001:db8::1]:443")).toBe("2001:db8::1");
    expect(canonicalIp("::ffff:cb00:7107")).toBe("203.0.113.7");
  });

  it("rejects anything that is not an IP", () => {
    for (const bad of ["", "unknown", "example.com", "1.2.3", "999.1.1.1", "fe80::1%eth0", "1.2.3.4, 5.6.7.8", "x".repeat(100)]) {
      expect(canonicalIp(bad)).toBeUndefined();
    }
  });
});

describe("clientAddress (TRUST_PROXY_HOPS)", () => {
  it("uses the socket address by default and ignores X-Forwarded-For", () => {
    expect(clientAddress(req("::ffff:10.0.0.5", "198.51.100.1"), 0)).toBe("10.0.0.5");
  });

  it("takes the N-th entry from the right, so client-supplied entries on the left are ignored", () => {
    // A visitor sends a forged header; the one trusted proxy appends the real address.
    expect(clientAddress(req("10.0.0.5", "1.1.1.1, 2.2.2.2, 198.51.100.9"), 1)).toBe("198.51.100.9");
    expect(clientAddress(req("10.0.0.5", "1.1.1.1, 198.51.100.9, 10.0.0.4"), 2)).toBe("198.51.100.9");
    // Several header lines are joined in order.
    expect(clientAddress(req("10.0.0.5", ["1.1.1.1", "198.51.100.9"]), 1)).toBe("198.51.100.9");
  });

  it("falls back to the socket address when the entry is missing or invalid", () => {
    expect(clientAddress(req("10.0.0.5"), 1)).toBe("10.0.0.5");
    expect(clientAddress(req("10.0.0.5", "198.51.100.9"), 2)).toBe("10.0.0.5");
    expect(clientAddress(req("10.0.0.5", "1.1.1.1, not-an-ip"), 1)).toBe("10.0.0.5");
    expect(clientAddress(req(undefined, "garbage"), 1)).toBe("unknown");
  });

  it("keys IPv6 limits by /64", () => {
    expect(limitKey("203.0.113.7")).toBe("203.0.113.7");
    expect(limitKey("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(limitKey("2001:db8:1:2:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2::/64");
    expect(limitKey("::1")).toBe("0:0:0:0::/64");
  });

  it("parses TRUST_PROXY_HOPS and warns about the old TRUST_PROXY", () => {
    expect(loadSettings({}).trustProxyHops).toBe(0);
    expect(loadSettings({ TRUST_PROXY_HOPS: "1" }).trustProxyHops).toBe(1);
    expect(() => loadSettings({ TRUST_PROXY_HOPS: "1.5" })).toThrow(/TRUST_PROXY_HOPS/);
    expect(() => loadSettings({ TRUST_PROXY_HOPS: "-1" })).toThrow(/TRUST_PROXY_HOPS/);
    expect(legacySettingWarnings({ TRUST_PROXY: "1" })[0]).toMatch(/TRUST_PROXY_HOPS/);
    expect(legacySettingWarnings({})).toEqual([]);
  });
});

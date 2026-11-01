import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";

/**
 * Validates and canonicalizes one IP address string. Accepts plain IPv4/IPv6, IPv6 in
 * brackets (optionally with a port), and IPv4 with a port. IPv4-mapped IPv6 addresses
 * (::ffff:1.2.3.4, as dual-stack sockets report them) become plain IPv4. IPv6 is written in
 * WHATWG URL form (lower case, compressed). Returns undefined for anything else.
 */
export function canonicalIp(raw: string | undefined): string | undefined {
  let s = (raw ?? "").trim();
  if (!s || s.length > 64) return undefined;
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(s);
  if (bracketed) s = bracketed[1]!;
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/.test(s)) s = s.slice(0, s.lastIndexOf(":"));
  if (s.includes("%")) return undefined; // zone ids are never valid client addresses
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(s);
  if (mapped) s = mapped[1]!;
  const family = isIP(s);
  if (family === 4) return s;
  if (family === 6) {
    try {
      const host = new URL(`http://[${s}]/`).hostname;
      const inner = host.slice(1, -1);
      const v4 = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(inner);
      if (v4) {
        const hi = parseInt(v4[1]!, 16);
        const lo = parseInt(v4[2]!, 16);
        return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
      }
      return inner;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * The visitor's address. With hops = 0 (default) it is the socket address. With hops = N > 0
 * (N trusted proxies in front of the app, e.g. 1 on Render), it is the N-th entry from the
 * right of X-Forwarded-For: each trusted proxy appends the address it received the request
 * from, so entries further left are client-controlled. Falls back to the socket address when
 * that entry is missing or not a valid IP.
 */
export function clientAddress(req: IncomingMessage, hops: number): string {
  const socket = canonicalIp(req.socket.remoteAddress) ?? "unknown";
  if (hops <= 0) return socket;
  const header = req.headers["x-forwarded-for"];
  const joined = Array.isArray(header) ? header.join(",") : (header ?? "");
  const entries = joined.split(",").map((e) => e.trim()).filter(Boolean);
  if (entries.length < hops) return socket;
  return canonicalIp(entries[entries.length - hops]) ?? socket;
}

/**
 * Key for per-address limits: IPv4 as is, IPv6 by its /64 prefix (one customer network
 * usually owns a whole /64, so per-address IPv6 limits would be trivial to bypass).
 */
export function limitKey(address: string): string {
  if (!address.includes(":")) return address;
  const parts = expandIpv6(address);
  return parts ? `${parts.slice(0, 4).join(":")}::/64` : address;
}

function expandIpv6(ip: string): string[] | undefined {
  const [head, tail] = ip.split("::") as [string, string | undefined];
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail !== "" ? tail.split(":") : [];
  if (ip.includes("::")) {
    const fill = 8 - h.length - t.length;
    if (fill < 0) return undefined;
    return [...h, ...Array(fill).fill("0"), ...t];
  }
  return h.length === 8 ? h : undefined;
}

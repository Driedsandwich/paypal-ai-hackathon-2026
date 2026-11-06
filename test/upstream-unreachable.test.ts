import type { ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { sendError } from "../src/http/util.js";

function fakeRes() {
  const out: { status?: number; body?: string } = {};
  const res = {
    writeHead(status: number) {
      out.status = status;
      return res;
    },
    setHeader() {},
    end(body?: string) {
      out.body = body;
    },
  } as unknown as ServerResponse;
  return { res, out };
}

describe("sendError: network-level failures", () => {
  it("answers 502 upstream_unreachable when fetch itself fails (DNS, connection refused)", () => {
    const { res, out } = fakeRes();
    sendError(res, new TypeError("fetch failed"));
    expect(out.status).toBe(502);
    expect(JSON.parse(out.body ?? "{}").error.code).toBe("upstream_unreachable");
  });

  it("keeps other unexpected errors as a plain 500", () => {
    const { res, out } = fakeRes();
    sendError(res, new TypeError("x is not a function"));
    expect(out.status).toBe(500);
    expect(JSON.parse(out.body ?? "{}").error.code).toBe("internal_error");
  });
});

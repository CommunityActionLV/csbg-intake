import { describe, expect, it } from "vitest";
import {
  CTAPI_MAX_PAGE_SIZE, HmisAuthError, HmisHttpError, crqlRows, effectivePageSize,
  fetchHmisClients, hmisAuthTest, hmisEnvironmentName, type HmisConfig,
} from "../src/lib/hmis";

/* CTAPI transport tests. The HTTP layer is stubbed through the fetchImpl option
   — nothing here touches api.clienttrack.net, and the credentials are
   placeholders, never the MOU-issued keys. */

const cfg = (over: Partial<HmisConfig> = {}): HmisConfig => ({
  baseUrl: "https://api.clienttrack.net",
  subscriptionKey: "sub-key-placeholder",
  apiKey: "api-key-placeholder",
  orgId: "",
  pageSize: 200,
  ...over,
});

interface Call { url: URL; headers: Record<string, string> }

/** Records every request and answers with the queued bodies in order (the last
    body repeats once the queue is drained). */
function stub(bodies: unknown[], status = 200) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const headers = { ...(init?.headers as Record<string, string>) };
    calls.push({ url: new URL(String(input)), headers });
    const body = bodies[Math.min(calls.length - 1, bodies.length - 1)];
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, opts: { fetchImpl, retryDelayMs: 0 } };
}

/** One CRQL page in the shape CTAPI actually returns. */
const page = (rows: Array<Record<string, unknown>>, recordCount = rows.length) =>
  ({ recordCount, cacheExpirationDate: null, data: { Table1: rows } });

const client = (id: number, over: Record<string, unknown> = {}) =>
  ({ ClientID: id, FirstName: "Test", LastName: `Person${id}`, ActiveStatus: "A", __crql_rid: id, ...over });

describe("CTAPI auth headers", () => {
  it("sends both static keys, with the literal ApiKey prefix", async () => {
    const { calls, opts } = stub([page([])]);
    await fetchHmisClients(cfg(), opts);
    expect(calls[0].headers["Ocp-Apim-Subscription-Key"]).toBe("sub-key-placeholder");
    expect(calls[0].headers.Authorization).toBe("ApiKey api-key-placeholder");
    expect(calls[0].headers.Authorization).not.toContain("Bearer");
  });

  it("omits OrgId unless it is configured", async () => {
    const unset = stub([page([])]);
    await fetchHmisClients(cfg({ orgId: "" }), unset.opts);
    expect(unset.calls[0].headers).not.toHaveProperty("OrgId");

    const blank = stub([page([])]);
    await fetchHmisClients(cfg({ orgId: "   " }), blank.opts);
    expect(blank.calls[0].headers).not.toHaveProperty("OrgId");

    const set = stub([page([])]);
    await fetchHmisClients(cfg({ orgId: "1234" }), set.opts);
    expect(set.calls[0].headers.OrgId).toBe("1234");
  });

  it("refuses a plain-HTTP base URL instead of sending the keys over it", async () => {
    const { calls, opts } = stub([page([])]);
    await expect(fetchHmisClients(cfg({ baseUrl: "http://api.clienttrack.net" }), opts)).rejects.toThrow(/https/i);
    expect(calls).toHaveLength(0);
  });
});

describe("page size and SELECT TOP", () => {
  it("clamps to CTAPI's maximum and floors at 1", () => {
    expect(effectivePageSize(1000)).toBe(CTAPI_MAX_PAGE_SIZE);
    expect(effectivePageSize(0)).toBe(1);
    expect(effectivePageSize(-5)).toBe(1);
    expect(effectivePageSize(200)).toBe(200);
    expect(effectivePageSize("not a number")).toBe(200);
    // a cleared form field is "unset", not zero — Number("") is 0
    expect(effectivePageSize("")).toBe(200);
    expect(effectivePageSize("   ")).toBe(200);
    expect(effectivePageSize(undefined)).toBe(200);
  });

  it("always emits SELECT TOP n, bounded to the effective page size", async () => {
    const { calls, opts } = stub([page([])]);
    await fetchHmisClients(cfg({ pageSize: 1000 }), opts);
    const q = calls[0].url.searchParams.get("q") ?? "";
    expect(q).toMatch(/^SELECT TOP 500 /);
    expect(calls[0].url.searchParams.get("pageSize")).toBe("500");
    expect(calls[0].url.searchParams.get("pageNo")).toBe("1");
    expect(calls[0].url.searchParams.get("shouldCache")).toBe("true");
    // TOP and pageSize come from one value, so they cannot disagree
    expect(q).toContain(`TOP ${calls[0].url.searchParams.get("pageSize")}`);
  });

  it("keeps TOP aligned with a small page size too", async () => {
    const { calls, opts } = stub([page([])]);
    await fetchHmisClients(cfg({ pageSize: 5 }), opts);
    expect(calls[0].url.searchParams.get("q")).toMatch(/^SELECT TOP 5 /);
  });
});

describe("CRQL response envelope", () => {
  it("treats a bare {} as an empty page rather than throwing", () => {
    expect(crqlRows({})).toEqual([]);
    expect(crqlRows({ data: {} })).toEqual([]);
    expect(crqlRows({ data: { Table1: [] } })).toEqual([]);
    expect(crqlRows(null)).toEqual([]);
  });

  it("unwraps data.Table1 when there are matches", () => {
    expect(crqlRows(page([client(1)]))).toHaveLength(1);
  });

  it("pulls nothing — and does not throw — when CTAPI answers {}", async () => {
    const { calls, opts } = stub([{}]);
    const pull = await fetchHmisClients(cfg({ pageSize: 25 }), opts);
    expect(pull.rows).toEqual([]);
    expect(calls).toHaveLength(1); // empty page ends the pull
  });
});

describe("pagination", () => {
  it("stops on a short page and ignores a recordCount that disagrees", async () => {
    const full = page([client(1), client(2)], 10);   // recordCount lies
    const short = page([client(3)], 10);
    const { calls, opts } = stub([full, short]);
    const pull = await fetchHmisClients(cfg({ pageSize: 2 }), opts);
    expect(calls).toHaveLength(2);
    expect(pull.rows.map((r) => r.hmisId)).toEqual(["1", "2", "3"]);
    expect(pull.pages).toBe(2);
  });

  it("flags a pull that filled exactly one page and then went empty", async () => {
    const { opts } = stub([page([client(1), client(2)]), {}]);
    const pull = await fetchHmisClients(cfg({ pageSize: 2 }), opts);
    expect(pull.rows).toHaveLength(2);
    expect(pull.singlePageCapped).toBe(true);
  });

  it("does not flag a pull that ended on a genuinely short page", async () => {
    const { opts } = stub([page([client(1)])]);
    const pull = await fetchHmisClients(cfg({ pageSize: 2 }), opts);
    expect(pull.singlePageCapped).toBe(false);
  });

  it("skips ClientID 0, the system/template row", async () => {
    const { opts } = stub([page([client(0), client(83318)])]);
    const pull = await fetchHmisClients(cfg({ pageSize: 25 }), opts);
    expect(pull.rows.map((r) => r.hmisId)).toEqual(["83318"]);
  });
});

describe("error handling", () => {
  it("fails a 401 immediately, without retrying the rejected credentials", async () => {
    const { calls, opts } = stub(["unauthorized"], 401);
    await expect(fetchHmisClients(cfg(), opts)).rejects.toBeInstanceOf(HmisAuthError);
    expect(calls).toHaveLength(1);
  });

  it("retries a 502 to the attempt limit, then surfaces the status", async () => {
    const { calls, opts } = stub(["gateway down"], 502);
    await expect(fetchHmisClients(cfg(), opts)).rejects.toBeInstanceOf(HmisHttpError);
    expect(calls).toHaveLength(3);
  });

  it("does not retry a 400 — a bad column name is not transient", async () => {
    const { calls, opts } = stub(["Unknown column: Nope"], 400);
    await expect(fetchHmisClients(cfg(), opts)).rejects.toBeInstanceOf(HmisHttpError);
    expect(calls).toHaveLength(1);
  });
});

describe("auth test", () => {
  it("reads the environment name from both the live and documented greetings", () => {
    expect(hmisEnvironmentName("Hello CER from from the PA_HMIS ClientTrack environment.")).toBe("PA_HMIS");
    expect(hmisEnvironmentName("Hello ADB from the Prod ClientTrack environment.")).toBe("Prod");
    expect(hmisEnvironmentName("something else entirely")).toBeNull();
  });

  it("reports the environment on success", async () => {
    const { calls, opts } = stub([{ message: "Hello CER from from the PA_HMIS ClientTrack environment." }]);
    const res = await hmisAuthTest(cfg(), opts);
    expect(res.ok).toBe(true);
    expect(res.environment).toBe("PA_HMIS");
    expect(calls[0].url.pathname).toBe("/auth/test");
  });

  it("distinguishes rejected credentials from CTAPI being down", async () => {
    const rejected = await hmisAuthTest(cfg(), stub(["nope"], 401).opts);
    expect(rejected.ok).toBe(false);
    expect(rejected.message).toMatch(/transpose/);

    const down = await hmisAuthTest(cfg(), stub(["gateway down"], 502).opts);
    expect(down.ok).toBe(false);
    expect(down.message).toMatch(/502/);
    expect(down.message).not.toMatch(/transpose/);
  });

  it("never echoes either key back in a message", async () => {
    const res = await hmisAuthTest(cfg(), stub(["nope"], 401).opts);
    expect(res.message).not.toContain("sub-key-placeholder");
    expect(res.message).not.toContain("api-key-placeholder");
  });
});

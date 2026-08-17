import { describe, expect, it } from "vitest";
import {
  HmisAuthError, authFailureMessage, classifyAuthFailure, columnNames, crqlRows,
  fetchHmisClients, hmisProcedureTest, normalizeProcedureName, parseProcedureParams,
  procedurePath, procedureResult, unmappedColumns, valueCounts, type HmisConfig,
} from "../src/lib/hmis";

/* Stored-procedure client source. The HTTP layer is stubbed through fetchImpl —
   nothing here touches api.clienttrack.net — and the procedure name and
   credentials are placeholders, never the real ones. The procedure's true
   output shape is unknown, so these fixtures assert how we handle shapes, not
   what the columns are. */

const PROC = "dbo.C_Report_Placeholder_API";

const cfg = (over: Partial<HmisConfig> = {}): HmisConfig => ({
  baseUrl: "https://api.clienttrack.net",
  subscriptionKey: "sub-key-placeholder",
  apiKey: "api-key-placeholder",
  orgId: "",
  pageSize: 200,
  storedProcedure: PROC,
  storedProcedureParams: {},
  ...over,
});

interface Call { url: URL; method: string; headers: Record<string, string>; body?: string }

function stub(bodies: unknown[], status = 200) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({
      url: new URL(String(input)),
      method: init?.method ?? "GET",
      headers: { ...(init?.headers as Record<string, string>) },
      body: typeof init?.body === "string" ? init.body : undefined,
    });
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

/** The stored-procedure envelope as CTAPI actually returns it: `result`, not
    `data`, and lowercase `table1`. No recordCount, no __crql_rid. */
const envelope = (rows: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) =>
  ({ output: [], result: { table1: rows, ...extra } });

/** A row in the procedure's real key style: camelCase, a lowercase-first
    `clientID`, and space-separated names in the same object. Values are
    placeholders, never real client data. */
const person = (id: number, over: Record<string, unknown> = {}) => ({
  clientID: id,
  enrollDate: "2026-01-05T00:00:00",
  exitDate: null,
  programName: "Example Shelter Project",
  firstName: "Test",
  lastName: `Person${id}`,
  relationship: "Self",
  dob: "1990-02-03T00:00:00",
  sex: "Female",
  gender: null,
  sexGender: "Female",
  race: "Black, African American, or African",
  veteranStatus: "No",
  age: 36,
  "age at Enrollment": 35,
  insurance: "Medicaid",
  income: 1421.0,
  "source of Cash Income": null,
  "source of NonCash Income": "Supplemental Nutrition Assistance Program (SNAP)",
  "enrolled Family Members": "Person, Test | 02/03/1990",
  "enrolled Member Count": 1,
  ...over,
});

describe("the setting is the switch", () => {
  it("pulls from the stored procedure when one is set", async () => {
    const { calls, opts } = stub([envelope([person(1)])]);
    const pull = await fetchHmisClients(cfg(), opts);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url.pathname).toBe(`/crql/storedprocedures/${PROC}`);
    expect(pull.source).toBe("procedure");
    expect(pull.procedure).toBe(PROC);
    expect(pull.rows.map((r) => r.hmisId)).toEqual(["1"]);
  });

  it("falls back to the CRQL query when the field is blank — unchanged behaviour", async () => {
    const { calls, opts } = stub([envelope([person(1)])]);
    const pull = await fetchHmisClients(cfg({ storedProcedure: "" }), opts);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url.pathname).toBe("/crql");
    expect(calls[0].url.searchParams.get("q")).toMatch(/^SELECT TOP 200 /);
    expect(pull.source).toBe("crql");
    expect(pull.procedure).toBeNull();
    expect(pull.rows).toHaveLength(1);
  });
});

describe("procedure name validation — the schema prefix is optional", () => {
  it("stores exactly what was typed, adding and stripping nothing", () => {
    // both forms are accepted by the API and return identical payloads
    expect(normalizeProcedureName("C_Report_Example")).toEqual({ ok: true, value: "C_Report_Example" });
    expect(normalizeProcedureName("dbo.C_Report_Example")).toEqual({ ok: true, value: "dbo.C_Report_Example" });
    expect(normalizeProcedureName("custom.Thing")).toEqual({ ok: true, value: "custom.Thing" });
    // trimmed, and nothing else
    expect(normalizeProcedureName("  C_Report_Example  ")).toEqual({ ok: true, value: "C_Report_Example" });
  });

  it("is idempotent — a saved value survives a re-save unchanged", () => {
    for (const name of ["C_Report_Example", "dbo.C_Report_Example"]) {
      const once = normalizeProcedureName(name);
      expect(once.ok && normalizeProcedureName(once.value)).toEqual({ ok: true, value: name });
    }
  });

  it("sends the bare name through to the path, un-prefixed", async () => {
    const { calls, opts } = stub([envelope([person(1)])]);
    await fetchHmisClients(cfg({ storedProcedure: "C_Report_Example" }), opts);
    expect(calls[0].url.pathname).toBe("/crql/storedprocedures/C_Report_Example");
  });

  it("treats blank and whitespace-only as empty, not invalid", () => {
    expect(normalizeProcedureName("")).toEqual({ ok: true, value: "" });
    expect(normalizeProcedureName("   ")).toEqual({ ok: true, value: "" });
    expect(normalizeProcedureName("\t \n")).toEqual({ ok: true, value: "" });
  });

  it("rejects every path-escaping class rather than sanitizing it", () => {
    for (const bad of [
      "dbo./etc/passwd", "dbo.\\share", "dbo.a?b", "dbo.a#b", "dbo.a%2e", "../secret",
      "dbo..Thing", "dbo.a.b", "dbo.has space", "dbo.semi;colon", "dbo.quote'", "1bad.Start",
      "dbo.", ".Thing", "a/b", "..", "%2e%2e",
    ]) {
      expect(normalizeProcedureName(bad).ok, bad).toBe(false);
    }
  });

  it("URL-encodes the name into the path", () => {
    expect(procedurePath("dbo.C_Report_Example")).toBe("/crql/storedprocedures/dbo.C_Report_Example");
    // belt and braces: validation already forbids these, encoding still applies
    expect(procedurePath("a/b")).toBe("/crql/storedprocedures/a%2Fb");
  });
});

describe("procedure parameters", () => {
  it("defaults blank to {} and accepts a JSON object", () => {
    expect(parseProcedureParams("")).toEqual({ ok: true, value: {} });
    expect(parseProcedureParams("   ")).toEqual({ ok: true, value: {} });
    expect(parseProcedureParams("{}")).toEqual({ ok: true, value: {} });
    expect(parseProcedureParams('{"Year": 2026}')).toEqual({ ok: true, value: { Year: 2026 } });
  });

  it("rejects invalid JSON and non-objects at save time", () => {
    expect(parseProcedureParams("{oops}").ok).toBe(false);
    expect(parseProcedureParams("[1,2]").ok).toBe(false);
    expect(parseProcedureParams('"a string"').ok).toBe(false);
    expect(parseProcedureParams("42").ok).toBe(false);
    expect(parseProcedureParams("null").ok).toBe(false);
  });

  it("posts the configured parameters as the body, defaulting to {}", async () => {
    const none = stub([envelope([person(1)])]);
    await fetchHmisClients(cfg(), none.opts);
    expect(none.calls[0].body).toBe("{}");

    const some = stub([envelope([person(1)])]);
    await fetchHmisClients(cfg({ storedProcedureParams: { Year: 2026 } }), some.opts);
    expect(some.calls[0].body).toBe('{"Year":2026}');
  });
});

describe("procedure request shape", () => {
  it("sends exactly one Content-Type, plus both auth headers", async () => {
    const { calls, opts } = stub([envelope([person(1)])]);
    await fetchHmisClients(cfg(), opts);
    const names = Object.keys(calls[0].headers).filter((h) => h.toLowerCase() === "content-type");
    expect(names).toHaveLength(1);
    expect(calls[0].headers["Content-Type"]).toBe("application/json");
    expect(calls[0].headers["Ocp-Apim-Subscription-Key"]).toBe("sub-key-placeholder");
    expect(calls[0].headers.Authorization).toBe("ApiKey api-key-placeholder");
  });

  it("omits OrgId unless configured, and includes it when set", async () => {
    const unset = stub([envelope([])]);
    await fetchHmisClients(cfg(), unset.opts);
    expect(unset.calls[0].headers).not.toHaveProperty("OrgId");

    const set = stub([envelope([])]);
    await fetchHmisClients(cfg({ orgId: "1234" }), set.opts);
    expect(set.calls[0].headers.OrgId).toBe("1234");
  });

  it("sends no paging parameters — they are documented for /crql only", async () => {
    const { calls, opts } = stub([envelope([person(1)])]);
    await fetchHmisClients(cfg({ pageSize: 500 }), opts);
    expect(calls[0].url.searchParams.get("pageSize")).toBeNull();
    expect(calls[0].url.searchParams.get("pageNo")).toBeNull();
    expect([...calls[0].url.searchParams.keys()]).toEqual([]);
  });
});

describe("the stored-procedure envelope — result.table1, not data.Table1", () => {
  it("unwraps result.table1 as the live endpoint returns it", async () => {
    expect(procedureResult(envelope([person(1)])).rows).toHaveLength(1);
    const { opts } = stub([envelope([person(1)])]);
    const pull = await fetchHmisClients(cfg(), opts);
    expect(pull.rows.map((r) => r.hmisId)).toEqual(["1"]);
  });

  it("does NOT read the CRQL envelope here — the two endpoints differ", () => {
    // the shape /crql returns, handed to the procedure parser, is not a match:
    // reading data.Table1 here is what produced a silent zero-row sync
    expect(procedureResult({ data: { Table1: [person(1)] } }).rows).toEqual([]);
    // and the CRQL parser is equally uninterested in the procedure envelope
    expect(crqlRows(envelope([person(1)]))).toEqual([]);
    expect(crqlRows({ data: { Table1: [person(1)] } })).toHaveLength(1);
  });

  it("surfaces the top-level output array rather than dropping it", async () => {
    expect(procedureResult({ output: [], result: { table1: [] } }).output).toEqual([]);
    const { opts } = stub([{ output: [{ RowsAffected: 3 }], result: { table1: [] } }]);
    const pull = await fetchHmisClients(cfg(), opts);
    expect(pull.note).toContain("output parameter");
  });

  it("treats a bare {} as zero rows without throwing", async () => {
    expect(procedureResult({}).rows).toEqual([]);
    expect(procedureResult({}).message).toBeNull();
    const { opts } = stub([{}]);
    const pull = await fetchHmisClients(cfg(), opts);
    expect(pull.rows).toEqual([]);
    expect(pull.rawRowCount).toBe(0);
  });

  it("treats a message-only body as zero rows and keeps the message", async () => {
    const { opts } = stub([{ message: "Client merged." }]);
    const pull = await fetchHmisClients(cfg(), opts);
    expect(pull.rows).toEqual([]);
    expect(pull.note).toContain("Client merged.");
  });

  it("reads table1 and names the other result sets rather than dropping them", async () => {
    const { opts } = stub([envelope([person(1)], { table2: [{ Other: 1 }], table3: [] })]);
    const pull = await fetchHmisClients(cfg(), opts);
    expect(pull.rows).toHaveLength(1);
    expect(pull.extraTables).toEqual(["table2", "table3"]);
    expect(pull.note).toContain("table2");
  });

  it("survives a capitalization change on table1", () => {
    expect(procedureResult({ result: { Table1: [person(1)] } }).rows).toHaveLength(1);
  });

  it("counts rows it got, with no recordCount in this envelope to mislead it", async () => {
    const { opts } = stub([{ recordCount: 999, output: [], result: { table1: [person(1), person(2)] } }]);
    const pull = await fetchHmisClients(cfg(), opts);
    expect(pull.rawRowCount).toBe(2);
    expect(pull.rows).toHaveLength(2);
  });
});

describe("the real 21-column payload", () => {
  it("reads clientID — the spelling the CRQL-era key list missed", async () => {
    const { opts } = stub([envelope([person(83318)])]);
    const pull = await fetchHmisClients(cfg(), opts);
    expect(pull.rows).toHaveLength(1);
    expect(pull.rows[0].hmisId).toBe("83318");
    expect(pull.droppedRows).toBe(0);
  });

  it("maps the fields that have a home, including the space-separated keys", async () => {
    const { opts } = stub([envelope([person(1, {
      "source of Cash Income": "Employment",
      "source of NonCash Income": "SNAP (1421.00)",
    })])]);
    const [row] = (await fetchHmisClients(cfg(), opts)).rows;
    expect(row.first).toBe("Test");
    expect(row.last).toBe("Person1");
    expect(row.dob).toBe("1990-02-03");      // ISO datetime trimmed to a date
    expect(row.sex).toBe("Female");
    expect(row.race).toBe("Black, African American, or African");
    expect(row.veteran).toBe("No");
    expect(row.insurance).toBe("Medicaid");
    expect(row.incomeSrc).toBe("Employment");
    expect(row.nonCash).toBe("SNAP (1421.00)");
  });

  it("never parses enrolled Family Members — the comma is ambiguous", async () => {
    const { opts } = stub([envelope([person(1, {
      "enrolled Family Members": "Doe, Jane | 01/02/1990, Doe, John | 03/04/2012",
      "enrolled Member Count": 2,
    })])]);
    const [row] = (await fetchHmisClients(cfg(), opts)).rows;
    expect(row.household).toEqual([]);
  });

  it("reports the columns it received but does not store", async () => {
    const { opts } = stub([envelope([person(1)])]);
    const pull = await fetchHmisClients(cfg(), opts);
    expect(pull.knownUnstoredColumns).toContain("income");
    expect(pull.knownUnstoredColumns).toContain("enrolled Family Members");
    expect(pull.knownUnstoredColumns).toContain("age at Enrollment");
    expect(pull.note).toContain("not stored");
    // known-but-unstored is not the same as unrecognized
    expect(pull.unmappedColumns).toEqual([]);
  });

  it("reports labels the CSBG instrument doesn't recognize, storing them as-is", async () => {
    const { opts } = stub([envelope([person(1), person(2)])]);
    const pull = await fetchHmisClients(cfg(), opts);
    const race = pull.labelDrift.find((d) => d.code === "C6");
    expect(race).toMatchObject({ value: "Black, African American, or African", count: 2 });
    expect(pull.note).toContain("outside the CSBG instrument");
    // stored as reported — never coerced to a default
    expect(pull.rows[0].race).toBe("Black, African American, or African");
  });
});

describe("one row per client, or one per household?", () => {
  it("reports the distinct relationship values instead of assuming", async () => {
    const { opts } = stub([envelope([
      person(1), person(2, { relationship: "Self" }), person(3, { relationship: "Daughter" }),
    ])]);
    const pull = await fetchHmisClients(cfg(), opts);
    expect(pull.rawRowCount).toBe(3);
    expect(pull.relationships).toEqual([
      { value: "Self", count: 2 },
      { value: "Daughter", count: 1 },
    ]);
    expect(pull.note).toContain("relationship values");
  });

  it("counts values on any column, blanks included", () => {
    const counts = valueCounts([{ relationship: "Self" }, { relationship: null }], "relationship");
    expect(counts).toHaveLength(2);
    expect(counts.find((c) => c.value === "Self")).toEqual({ value: "Self", count: 1 });
    expect(counts.find((c) => c.value === "(blank)")).toEqual({ value: "(blank)", count: 1 });
  });
});

describe("unknown columns are reported, not guessed at", () => {
  it("lists columns the mapping doesn't consume, ignoring __crql_rid", () => {
    expect(unmappedColumns([{ clientID: 1, firstName: "A", HUDRace: "x", __crql_rid: 3 }]))
      .toEqual(["HUDRace"]);
    expect(unmappedColumns([{ clientID: 1 }])).toEqual([]);
    // known-but-unstored columns are not "unrecognized"
    expect(unmappedColumns([{ clientID: 1, income: 5, "enrolled Member Count": 2 }])).toEqual([]);
  });

  it("reports unmapped columns on the pull", async () => {
    const { opts } = stub([envelope([{ ...person(1), DisablingCondition: "No", PriorLivingSituation: "Street" }])]);
    const pull = await fetchHmisClients(cfg(), opts);
    expect(pull.unmappedColumns).toEqual(["DisablingCondition", "PriorLivingSituation"]);
    expect(pull.note).toContain("DisablingCondition");
  });

  it("says so loudly when rows came back but none carried a usable ID and name", async () => {
    const { opts } = stub([envelope([{ PersonKey: 55, GivenName: "Ada", Surname: "Lovelace" }])]);
    const pull = await fetchHmisClients(cfg(), opts);
    expect(pull.rows).toEqual([]);
    expect(pull.rawRowCount).toBe(1);
    expect(pull.droppedRows).toBe(1);
    expect(pull.note).toMatch(/recognizable client ID and name/);
    // the columns that WERE there, so the real mapping can be written from them
    expect(pull.note).toContain("PersonKey");
    expect(columnNames([{ PersonKey: 1, GivenName: "A" }])).toEqual(["GivenName", "PersonKey"]);
  });
});

describe("401s say which of the three problems it is", () => {
  it("classifies each documented body", () => {
    expect(classifyAuthFailure("Access denied due to missing subscription key.")).toBe("subscription");
    expect(classifyAuthFailure("Access denied due to missing or incorrect ApiKey.")).toBe("apikey");
    expect(classifyAuthFailure("dbo.Whatever is not available at this time.")).toBe("procedureNotEnabled");
    expect(classifyAuthFailure("something else")).toBe("unknown");
  });

  it("gives each cause its own message, and does not blame credentials for a disabled procedure", () => {
    expect(authFailureMessage("subscription")).toMatch(/Subscription key rejected/);
    expect(authFailureMessage("apikey")).toMatch(/API key rejected/);
    const notEnabled = authFailureMessage("procedureNotEnabled", PROC);
    expect(notEnabled).toContain(PROC);
    expect(notEnabled).toMatch(/NOT a credential problem/);
    expect(notEnabled).toMatch(/CaseWorthy support/);
    expect(authFailureMessage("unknown")).toMatch(/transpose/);
  });

  it("surfaces the distinct message through Test connection, and never retries a 401", async () => {
    const missingSub = stub(["Access denied due to missing subscription key."], 401);
    const subRes = await hmisProcedureTest(cfg(), missingSub.opts);
    expect(subRes.ok).toBe(false);
    expect(subRes.message).toMatch(/Subscription key rejected/);
    expect(missingSub.calls).toHaveLength(1);

    const badKey = stub(["Access denied due to missing or incorrect ApiKey."], 401);
    expect((await hmisProcedureTest(cfg(), badKey.opts)).message).toMatch(/API key rejected/);

    const disabled = stub([`${PROC} is not available at this time.`], 401);
    const disabledRes = await hmisProcedureTest(cfg(), disabled.opts);
    expect(disabledRes.message).toMatch(/NOT a credential problem/);
    expect(disabledRes.message).not.toMatch(/transpose/);
  });

  it("carries the kind on the thrown error so the sync path can tell them apart too", async () => {
    const { opts } = stub([`${PROC} is not available at this time.`], 401);
    await expect(fetchHmisClients(cfg(), opts)).rejects.toMatchObject({
      name: "HmisAuthError", kind: "procedureNotEnabled",
    });
    expect(new HmisAuthError("Access denied due to missing subscription key.").kind).toBe("subscription");
  });
});

describe("Test connection reports the procedure step honestly", () => {
  it("names the columns it found so the output shape can be read off a live run", async () => {
    const { opts } = stub([envelope([{ ClientID: 1, FirstName: "A", LastName: "B", HUDRace: "x" }])]);
    const res = await hmisProcedureTest(cfg(), opts);
    expect(res.ok).toBe(true);
    expect(res.rowCount).toBe(1);
    expect(res.columns).toEqual(["ClientID", "FirstName", "HUDRace", "LastName"]);
    expect(res.message).toContain("HUDRace");
  });

  it("distinguishes an empty result from a message-only answer", async () => {
    expect((await hmisProcedureTest(cfg(), stub([{}]).opts)).message).toMatch(/empty result/);
    const msg = await hmisProcedureTest(cfg(), stub([{ message: "Nothing to do." }]).opts);
    expect(msg.ok).toBe(true);
    expect(msg.message).toContain("Nothing to do.");
  });

  it("says plainly when no procedure is configured instead of skipping quietly", async () => {
    const res = await hmisProcedureTest(cfg({ storedProcedure: "" }), stub([{}]).opts);
    expect(res.ok).toBe(true);
    expect(res.configured).toBe(false);
    expect(res.message).toMatch(/No stored procedure set; sync will use the CRQL query/);
  });

  it("reports a 500 as ambiguous rather than as a bad name or a fault", async () => {
    const res = await hmisProcedureTest(cfg(), stub([""], 500).opts);
    expect(res.ok).toBe(false);
    expect(res.message).toContain("500");
    expect(res.message).toMatch(/invalid procedure name and a server fault look identical/);
  });

  it("never echoes either key into a message", async () => {
    const res = await hmisProcedureTest(cfg(), stub(["nope"], 401).opts);
    expect(res.message).not.toContain("sub-key-placeholder");
    expect(res.message).not.toContain("api-key-placeholder");
  });
});

import { describe, expect, it } from "vitest";
import { hmisDate, normalizeHmisClient } from "../src/lib/hmis";

describe("hmisDate", () => {
  it("accepts ISO, ISO datetime, and US formats", () => {
    expect(hmisDate("2001-05-14")).toBe("2001-05-14");
    expect(hmisDate("2001-05-14T00:00:00")).toBe("2001-05-14");
    expect(hmisDate("5/14/2001")).toBe("2001-05-14");
    expect(hmisDate("garbage")).toBeNull();
  });
});

describe("normalizeHmisClient", () => {
  it("reads PascalCase (ClientTrack-style) fields", () => {
    const row = normalizeHmisClient({
      ClientID: "20636", FirstName: "Jordan", LastName: "Wells", DOB: "5/14/2001",
      Gender: "Woman", Race: "White", Ethnicity: "Hispanic/Latina",
      VeteranStatus: "No", HealthInsuranceType: "Medicaid",
      SourceOfIncome: "Employment", NonCashBenefits: "SNAP",
      Email: "j@example.org", Telephone: "(610) 555-0100",
      Services: [{ Service: "Case Management", BeginDate: "2026-01-15" }],
      FamilyMembers: [{ FirstName: "Sam", LastName: "Wells", DOB: "2010-02-01" }],
    })!;
    expect(row.hmisId).toBe("20636");
    expect(row.dob).toBe("2001-05-14");
    expect(row.sex).toBe("Woman");
    expect(row.race).toBe("White · Hispanic/Latina");
    expect(row.veteran).toBe("No");
    expect(row.insurance).toBe("Medicaid");
    expect(row.incomeSrc).toBe("Employment");
    expect(row.nonCash).toBe("SNAP");
    expect(row.services).toEqual([{ name: "Case Management", date: "2026-01-15" }]);
    expect(row.household).toEqual([{ first: "Sam", last: "Wells", dob: "2010-02-01" }]);
  });

  it("reads camelCase / snake_case variants", () => {
    const row = normalizeHmisClient({
      clientId: "A-1", firstName: "Ana", last_name: "Reyes", date_of_birth: "1990-01-02",
    })!;
    expect(row.hmisId).toBe("A-1");
    expect(row.first).toBe("Ana");
    expect(row.last).toBe("Reyes");
    expect(row.dob).toBe("1990-01-02");
  });

  it("keeps distinct gender and sex values (both MOU elements)", () => {
    const row = normalizeHmisClient({ ClientID: "1", FirstName: "A", LastName: "B", Gender: "Woman", Sex: "Female" })!;
    expect(row.sex).toBe("Woman / Female");
  });

  it("rejects rows without an ID or a name", () => {
    expect(normalizeHmisClient({ FirstName: "A", LastName: "B" })).toBeNull();
    expect(normalizeHmisClient({ ClientID: "1", FirstName: "A" })).toBeNull();
    expect(normalizeHmisClient({ ClientID: "1", LastName: "B" })).toBeNull();
  });

  it("treats missing optional elements as nulls, not empty strings", () => {
    const row = normalizeHmisClient({ ClientID: "1", FirstName: "A", LastName: "B" })!;
    expect(row.dob).toBeNull();
    expect(row.email).toBeNull();
    expect(row.phone).toBeNull();
    expect(row.services).toEqual([]);
    expect(row.household).toEqual([]);
  });
});

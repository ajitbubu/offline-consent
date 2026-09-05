import { describe, expect, it } from "vitest";
import {
  DRAFT_STATUSES,
  allowedDraftTransitions,
  canTransitionDraft,
  roleAtLeast,
  noticeOwed,
  type DraftStatus,
} from "@/lib/consent";
import { normalisePhone, normaliseEmail, maskName } from "@/lib/phone";

describe("draft state machine", () => {
  it("permits exactly the transitions in the table and no others", () => {
    for (const from of DRAFT_STATUSES) {
      for (const to of DRAFT_STATUSES) {
        expect(canTransitionDraft(from, to)).toBe(
          (allowedDraftTransitions[from] as readonly DraftStatus[]).includes(to),
        );
      }
    }
  });

  it("treats committed and rejected as terminal", () => {
    // A committed draft that turns out to be wrong is corrected by a new draft
    // superseding it, never by reopening this one - the artifact it produced
    // cannot be edited.
    expect(allowedDraftTransitions.committed).toEqual([]);
    expect(allowedDraftTransitions.rejected).toEqual([]);
  });

  it("lets a draft under review be edited repeatedly", () => {
    expect(canTransitionDraft("needs_review", "needs_review")).toBe(true);
  });
});

describe("role ranking", () => {
  it("gives a DPO everything an operator has, and an admin everything", () => {
    expect(roleAtLeast("operator", "operator")).toBe(true);
    expect(roleAtLeast("operator", "dpo")).toBe(false);
    expect(roleAtLeast("dpo", "operator")).toBe(true);
    expect(roleAtLeast("admin", "dpo")).toBe(true);
  });
});

describe("notice obligation", () => {
  it("counts a missing or unrecorded notice as owed under s.5(2)", () => {
    expect(noticeOwed("none")).toBe(true);
    expect(noticeOwed("unknown")).toBe(true);
    expect(noticeOwed("attached")).toBe(false);
    expect(noticeOwed("printed_on_form")).toBe(false);
  });
});

describe("phone normalisation", () => {
  it("accepts the ways an Indian mobile is actually written on paper", () => {
    for (const written of [
      "9876543210",
      "98765 43210",
      "098765-43210",
      "+91 98765 43210",
      "0091 9876543210",
      "919876543210",
    ]) {
      expect(normalisePhone(written)).toBe("+919876543210");
    }
  });

  it("returns null rather than guessing", () => {
    // A number stored wrong makes the person permanently unreachable, so an
    // unparseable one has to fail loudly at review instead.
    for (const bad of ["", "  ", "98765", "12345678901234567890", "abcd", "1234567890"]) {
      expect(normalisePhone(bad)).toBeNull();
    }
  });

  it("does not fold distinct email addresses together", () => {
    // Stripping Gmail dots or +tags would merge two real people and leak one
    // person's consent state into the other's record.
    expect(normaliseEmail("A.B+tag@Example.org")).toBe("a.b+tag@example.org");
    expect(normaliseEmail("ab@example.org")).not.toBe(normaliseEmail("a.b@example.org"));
    expect(normaliseEmail("no-at-sign")).toBeNull();
  });

  it("masks a name without giving away the household", () => {
    expect(maskName("Ravi Shankar Menon")).toBe("R••• S•••••• M••••");
  });
});

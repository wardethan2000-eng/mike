import { describe, expect, it } from "vitest";
import {
    daysUntil,
    formatDay,
    formatNearness,
    isPressing,
    parseFactDate,
    upcomingDates,
} from "./matterDates";

/** A fixed "now" so nothing here depends on the day the suite is run. */
const NOW = new Date(2026, 7, 20); // 20 August 2026

function parsed(body: string) {
    return parseFactDate(body, NOW);
}

describe("parseFactDate", () => {
    it("reads a month written out, with a year", () => {
        const result = parsed("Answer due September 2, 2026");
        expect(result?.date).toEqual(new Date(2026, 8, 2));
        expect(result?.label).toBe("Answer due");
    });

    it("reads a shortened month with no year, taking the next one to come", () => {
        expect(parsed("Scheduling conference Sept 18")?.date).toEqual(
            new Date(2026, 8, 18),
        );
    });

    it("rolls a long-past day without a year into next year", () => {
        // February is six months behind this "now", so it means next February.
        expect(parsed("Trial setting Feb 3")?.date).toEqual(new Date(2027, 1, 3));
    });

    it("leaves a date just gone in this year rather than jumping a year ahead", () => {
        expect(parsed("Discovery served August 4")?.date).toEqual(
            new Date(2026, 7, 4),
        );
    });

    it("reads a day written before the month", () => {
        const result = parsed("Mediation 14 October 2026");
        expect(result?.date).toEqual(new Date(2026, 9, 14));
        expect(result?.label).toBe("Mediation");
    });

    it("reads slashes as month then day", () => {
        expect(parsed("Pretrial 11/6/2026")?.date).toEqual(new Date(2026, 10, 6));
    });

    it("reads a two-digit year", () => {
        expect(parsed("Fee application 1/9/27")?.date).toEqual(new Date(2027, 0, 9));
    });

    it("reads a plain calendar date", () => {
        expect(parsed("Expert reports 2026-11-30")?.date).toEqual(
            new Date(2026, 10, 30),
        );
    });

    it("drops the word that only introduced the date", () => {
        expect(parsed("Hearing on 9/18/2026")?.label).toBe("Hearing");
        expect(parsed("Response is due by October 1")?.label).toBe(
            "Response is due",
        );
    });

    it("keeps the whole fact when nothing but the date is left", () => {
        expect(parsed("September 2, 2026")?.label).toBe("September 2, 2026");
    });

    it("says nothing when there is no date to read", () => {
        expect(parsed("Opposing counsel is Coyle & Fenn")).toBeNull();
        expect(parsed("")).toBeNull();
    });

    it("refuses a day the month does not have", () => {
        expect(parsed("Filed February 31, 2026")).toBeNull();
    });

    it("does not read a statute number as a date", () => {
        expect(parsed("Claim brought under K.S.A. 60-206")).toBeNull();
    });
});

describe("upcomingDates", () => {
    const bodies = [
        "Answer due September 2, 2026",
        "Fence was built in June 2019",
        "Scheduling conference Sept 18",
        "Board meeting was 8/4/2026",
        "Opposing counsel is Coyle & Fenn",
        "Discovery closes November 14, 2026",
    ];

    it("keeps only what is still to come, soonest first", () => {
        const result = upcomingDates(bodies, NOW);
        expect(result.map((entry) => entry.label)).toEqual([
            "Answer due",
            "Scheduling conference",
            "Discovery closes",
        ]);
    });

    it("counts today as still to come", () => {
        expect(upcomingDates(["Hearing 8/20/2026"], NOW)).toHaveLength(1);
    });

    it("shows no more than it was asked for", () => {
        expect(upcomingDates(bodies, NOW, 2)).toHaveLength(2);
    });
});

describe("how a date is put into words", () => {
    it("counts the days between", () => {
        expect(daysUntil(new Date(2026, 8, 2), NOW)).toBe(13);
        expect(daysUntil(new Date(2026, 7, 19), NOW)).toBe(-1);
    });

    it("names the near ones and lets the far ones speak for themselves", () => {
        expect(formatNearness(new Date(2026, 7, 20), NOW)).toBe("today");
        expect(formatNearness(new Date(2026, 7, 21), NOW)).toBe("tomorrow");
        expect(formatNearness(new Date(2026, 8, 2), NOW)).toBe("in 13 days");
        expect(formatNearness(new Date(2026, 10, 14), NOW)).toBeNull();
    });

    it("marks a date inside a week as pressing", () => {
        expect(isPressing(new Date(2026, 7, 25), NOW)).toBe(true);
        expect(isPressing(new Date(2026, 8, 2), NOW)).toBe(false);
    });

    it("adds the year only when it is not this one", () => {
        expect(formatDay(new Date(2026, 8, 2), NOW)).not.toContain("2026");
        expect(formatDay(new Date(2027, 1, 3), NOW)).toContain("2027");
    });
});

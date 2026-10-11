import { describe, expect, it } from "vitest";
import { calendarDates, googleCalendarUrl } from "./calendar";

describe("calendarDates", () => {
  it("books a timed show for three hours in floating local time", () => {
    expect(calendarDates("2026-12-12", "18:30")).toBe("20261212T183000/20261212T213000");
  });

  it("runs a late show past midnight into the next day", () => {
    expect(calendarDates("2026-12-31", "22:00")).toBe("20261231T220000/20270101T010000");
  });

  it("makes a show with no time an all-day event, end exclusive", () => {
    expect(calendarDates("2026-10-31", null)).toBe("20261031/20261101");
  });

  it("rejects a date that isn't one", () => {
    expect(() => calendarDates("someday", null)).toThrow();
  });
});

describe("googleCalendarUrl", () => {
  it("prefills a Google Calendar event", () => {
    const url = new URL(
      googleCalendarUrl({
        title: "PUP & Friends at The Majestic",
        date: "2026-11-01",
        time: "20:00",
        location: "The Majestic, Detroit",
        details: "https://www.jambase.com/show/1",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://calendar.google.com/calendar/render");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      action: "TEMPLATE",
      text: "PUP & Friends at The Majestic",
      dates: "20261101T200000/20261101T230000",
      location: "The Majestic, Detroit",
      details: "https://www.jambase.com/show/1",
    });
  });
});

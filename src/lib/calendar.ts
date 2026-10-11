/**
 * "Add to Google Calendar" links. Google's event template URL opens a
 * prefilled new event in whatever Google account the browser is signed in
 * to, so it needs no API key or sign-in here, and nothing is saved until the
 * user presses Save there.
 */

/** How long a timed show is booked for when the source gives only a start. */
const SHOW_HOURS = 3;

export type CalendarShow = {
  title: string;
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM at the venue, or null for an all-day event. */
  time: string | null;
  location: string;
  details?: string;
};

const compact = (d: Date, withTime: boolean) =>
  d.toISOString().slice(0, withTime ? 16 : 10).replace(/[-:]/g, "") + (withTime ? "00" : "");

/**
 * The `dates` value: "20261212T183000/20261212T213000" for a timed show,
 * "20261212/20261213" (end exclusive) for a whole day. Times carry no zone,
 * so Google reads them in the calendar's own time zone, which for a show
 * near home is the venue's.
 */
export function calendarDates(date: string, time: string | null): string {
  const timed = time !== null && /^\d\d:\d\d$/.test(time);
  // Date arithmetic in UTC stands in for wall-clock time; only the digits are used.
  const start = new Date(`${date}T${timed ? time : "00:00"}:00Z`);
  if (Number.isNaN(start.getTime())) throw new Error(`not a date: ${date}`);
  const end = new Date(start.getTime() + (timed ? SHOW_HOURS * 3600_000 : 24 * 3600_000));
  return `${compact(start, timed)}/${compact(end, timed)}`;
}

export function googleCalendarUrl(show: CalendarShow): string {
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: show.title,
    dates: calendarDates(show.date, show.time),
    location: show.location,
  });
  if (show.details) params.set("details", show.details);
  return `https://calendar.google.com/calendar/render?${params}`;
}

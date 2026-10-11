import { googleCalendarUrl, type CalendarShow } from "@/lib/calendar";

/** A "+" that opens Google Calendar with the show filled in, ready to save. */
export function AddToCalendar({ show, className = "add-cal" }: { show: CalendarShow; className?: string }) {
  const label = `Add ${show.title} to Google Calendar`;
  return (
    <a href={googleCalendarUrl(show)} target="_blank" rel="noopener noreferrer" className={className} title={label} aria-label={label}>
      <span aria-hidden="true">+</span>
    </a>
  );
}

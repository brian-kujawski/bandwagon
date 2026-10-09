"use client";

export default function Error({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="notice">
      <p>
        <strong>Something went wrong fetching show data.</strong> One of our sources may be
        down or out of quota.
      </p>
      <p style={{ marginTop: "0.5rem" }}>
        <button onClick={reset}>Try again</button>
      </p>
    </div>
  );
}

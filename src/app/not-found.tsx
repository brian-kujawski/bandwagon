import Link from "next/link";

export default function NotFound() {
  return (
    <p className="notice">
      We couldn&apos;t find that artist. <Link href="/">Search again</Link>.
    </p>
  );
}

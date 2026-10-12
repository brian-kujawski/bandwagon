"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";

/** A modal that opens as soon as it renders. Closing it goes back to plain Settings. */
export function CostDialog({ title, children }: { title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const router = useRouter();
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog ref={ref} className="cost-dialog" aria-labelledby="cost-title" onClose={() => router.replace("/settings")}>
      <h2 id="cost-title">{title}</h2>
      {children}
    </dialog>
  );
}

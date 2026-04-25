"use client";

import { useEffect } from "react";
import { Button } from "./_components/Button";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex-1 grid place-items-center px-6 py-16 text-center">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight">Something went wrong</h1>
        <p className="text-sm text-[color:var(--color-muted)] mt-1.5 max-w-[300px] mx-auto">
          An unexpected error happened. Try again or head back to the map.
        </p>
        <div className="mt-5 flex justify-center gap-2">
          <Button size="md" onClick={reset}>
            Try again
          </Button>
        </div>
      </div>
    </div>
  );
}

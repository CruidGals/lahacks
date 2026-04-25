"use client";

import { useEffect, useRef, useState } from "react";
import { pingSession } from "./api";
import type { GeoPing, Session } from "./types";

const PING_INTERVAL_MS = 10_000;

export function useTaskSession(session: Session | null) {
  const [pings, setPings] = useState<GeoPing[]>(session?.pings ?? []);
  const [denied, setDenied] = useState(false);
  const watchRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!session || session.status !== "active") return;
    if (typeof window === "undefined") return;
    if (!("geolocation" in navigator)) return;

    let lastPing = 0;
    const handle = (pos: GeolocationPosition) => {
      const now = Date.now();
      if (now - lastPing < PING_INTERVAL_MS) return;
      lastPing = now;
      const ping: GeoPing = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy_m: pos.coords.accuracy ?? 0,
        ts: new Date().toISOString(),
      };
      setPings((p) => [...p, ping]);
      pingSession(session.id, ping).catch(() => {});
    };

    watchRef.current = navigator.geolocation.watchPosition(
      handle,
      () => setDenied(true),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
    );

    // ensure we always have an initial ping after ~1s
    timerRef.current = window.setTimeout(() => {
      if (pings.length === 0) {
        navigator.geolocation.getCurrentPosition(handle, () => {});
      }
    }, 1000) as unknown as number;

    return () => {
      if (watchRef.current !== null) {
        navigator.geolocation.clearWatch(watchRef.current);
        watchRef.current = null;
      }
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, session?.status]);

  return { pings, denied };
}

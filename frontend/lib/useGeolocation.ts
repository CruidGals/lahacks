"use client";

import { useEffect, useState } from "react";
import { DEFAULT_LOCATION } from "./mock-data";

export type GeolocationState = {
  location: { lat: number; lng: number } | null;
  accuracy: number | null;
  status: "idle" | "loading" | "granted" | "denied" | "unavailable";
  error?: string;
};

export function useGeolocation(): GeolocationState {
  const [state, setState] = useState<GeolocationState>({
    location: null,
    accuracy: null,
    status: "loading",
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("geolocation" in navigator)) {
      setState({
        location: DEFAULT_LOCATION,
        accuracy: null,
        status: "unavailable",
      });
      return;
    }

    let cancelled = false;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (cancelled) return;
        setState({
          location: { lat: pos.coords.latitude, lng: pos.coords.longitude },
          accuracy: pos.coords.accuracy,
          status: "granted",
        });
      },
      (err) => {
        if (cancelled) return;
        setState({
          location: DEFAULT_LOCATION,
          accuracy: null,
          status: "denied",
          error: err.message,
        });
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
    );

    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}

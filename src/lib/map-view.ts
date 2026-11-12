import { useSyncExternalStore } from "react";

export type MapView = "map" | "board";

let view: MapView = "map";
const listeners = new Set<() => void>();

export function setMapView(next: MapView): void {
  view = next;
  for (const listener of listeners) listener();
}

export function useMapView(): MapView {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => view, () => view);
}

import type { ReactNode } from "react";
import type { RoomCardView } from "@/lib/room-card";

export type UpgradeUi = { busy: "preview" | "change" | null; note: { tone: "good" | "info" | "bad"; text: string } | null; onUpgrade: (tier?: string) => void };
export type Restart = "asking" | "restarting" | "current" | "failed";

export function CloudRoomCardView(_props: {
  view: RoomCardView | null; upgrade: UpgradeUi; browser: boolean; upgraded: string | null; restart: Restart | null;
  onNotNow: () => void; onRestart: () => void; children?: ReactNode;
}) {
  return <>{_props.children}</>;
}

export function useCloudRoom(): { snapshot: null; bridge: undefined; teamHome: boolean } {
  return { snapshot: null, bridge: undefined, teamHome: false };
}

export function CloudRoomCard() {
  return null;
}

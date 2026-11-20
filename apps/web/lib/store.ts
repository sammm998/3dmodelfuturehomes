import { create } from "zustand";
import type { ViewMode } from "./types";

export interface ViewerState {
  mode: ViewMode;
  floorIndex: number;
  /** dollhouse wall cut height above the selected floor, metres */
  cutHeight: number;
  showFurniture: boolean;
  showHotspots: boolean;
  photoreal: boolean;
  panoRoomId: string | null;
  selectedHotspot: string | null;
  sunHour: number;
  booth: boolean;
  tourPaused: boolean;
  /** pending walk teleport (plan metres) */
  walkTarget: [number, number] | null;
  /** room the walk camera is in (plan room id on a floor) */
  walkRoom: { floorId: string; planRoomId: string } | null;
  setMode: (m: ViewMode) => void;
  setFloor: (i: number) => void;
  set: (p: Partial<ViewerState>) => void;
}

export const useViewer = create<ViewerState>((set) => ({
  mode: "exterior",
  floorIndex: 0,
  cutHeight: 1.6,
  showFurniture: true,
  showHotspots: true,
  photoreal: false,
  panoRoomId: null,
  selectedHotspot: null,
  sunHour: 15,
  booth: false,
  tourPaused: false,
  walkTarget: null,
  walkRoom: null,
  setMode: (mode) => set({ mode, selectedHotspot: null }),
  setFloor: (floorIndex) => set({ floorIndex }),
  set: (p) => set(p),
}));

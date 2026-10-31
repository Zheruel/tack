export type DevicePlatform = "ios" | "android";

export interface DeviceInfo {
  id: string;
  platform: DevicePlatform;
  name: string;
  version?: string;
  booted: boolean;
}

export interface DevicePreview {
  available: boolean;
  devices: DeviceInfo[];
  open: DeviceInfo[];
  currentDeviceId?: string;
  image?: string;
  width?: number;
  height?: number;
  snapshotId?: string;
  status: "idle" | "starting" | "ready" | "error";
  error?: string;
}

export type DeviceAction =
  | { kind: "tap"; x: number; y: number }
  | {
      kind: "swipe";
      fromX: number;
      fromY: number;
      toX: number;
      toY: number;
      durationMs?: number;
    }
  | { kind: "type"; text: string }
  | {
      kind: "key";
      key: "home" | "back" | "recents" | "enter" | "delete" | "escape" | "tab";
    }
  | { kind: "openApp"; app: string }
  | { kind: "fill"; ref: string; text: string };

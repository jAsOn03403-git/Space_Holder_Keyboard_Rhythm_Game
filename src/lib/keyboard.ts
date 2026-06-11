import type { LaneConfig } from "../types";

export const PLAYABLE_CODES = [
  "KeyA",
  "KeyS",
  "KeyD",
  "KeyF",
  "KeyG",
  "KeyH",
  "KeyJ",
  "KeyK",
  "KeyL",
  "Semicolon",
] as const;

export const SPACE_SIDE_CODES = [
  "KeyQ",
  "KeyW",
  "KeyE",
  "KeyR",
  "KeyT",
  "KeyA",
  "KeyS",
  "KeyD",
  "KeyF",
  "KeyG",
  "KeyZ",
  "KeyX",
  "KeyC",
  "KeyV",
  "KeyN",
  "KeyM",
  "KeyY",
  "KeyU",
  "KeyI",
  "KeyO",
  "KeyP",
  "KeyH",
  "KeyJ",
  "KeyK",
  "KeyL",
  "Semicolon",
  "Quote",
  "Comma",
  "Period",
  "Slash",
  "BracketLeft",
  "BracketRight",
  "Backslash",
  "Minus",
  "Equal",
] as const;

const KEY_LABELS: Record<string, string> = {
  KeyA: "A",
  KeyS: "S",
  KeyD: "D",
  KeyF: "F",
  KeyG: "G",
  KeyH: "H",
  KeyJ: "J",
  KeyK: "K",
  KeyL: "L",
  Semicolon: ";",
};

export function getPlayableCodeIndex(code: string): number {
  return (PLAYABLE_CODES as readonly string[]).indexOf(code);
}

export const CONTROL_CODES = new Set([
  "Escape",
  "Tab",
  "CapsLock",
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
  "ContextMenu",
  "Backspace",
  "Enter",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
]);

const LANE_COLOR = "#79e7f2";
export function isPlayableKey(code: string): boolean {
  return code === "Space"
    || (PLAYABLE_CODES as readonly string[]).includes(code)
    || (SPACE_SIDE_CODES as readonly string[]).includes(code);
}

export function shouldIgnoreKey(code: string): boolean {
  return CONTROL_CODES.has(code) || !isPlayableKey(code);
}

export function createLaneConfigs(laneCount: number, _includeSpace = true): LaneConfig[] {
  const safeLaneCount = clampLaneCount(laneCount);
  const lanes: LaneConfig[] = [];
  const start = Math.floor((PLAYABLE_CODES.length - safeLaneCount) / 2);
  const selectedCodes = PLAYABLE_CODES.slice(start, start + safeLaneCount);

  for (let index = 0; index < safeLaneCount; index += 1) {
    const keyCode = selectedCodes[index];

    lanes.push({
      id: `lane-${keyCode}`,
      index,
      label: KEY_LABELS[keyCode],
      color: LANE_COLOR,
      keyCodes: [keyCode],
      isSpace: false,
      widthUnits: 1,
    });
  }

  return lanes;
}

export function findLaneForKey(lanes: LaneConfig[], code: string): LaneConfig | undefined {
  if (shouldIgnoreKey(code)) {
    return undefined;
  }

  return lanes.find((lane) => lane.keyCodes.includes(code));
}

export function getKeyboardSegments(lanes: LaneConfig[]) {
  return lanes.map((lane) => ({
    id: lane.id,
    label: lane.label,
    widthUnits: 1,
  }));
}

export function clampLaneCount(value: number): number {
  return Math.min(10, Math.max(2, Math.round(value / 2) * 2));
}

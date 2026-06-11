export type NoteType = "tap" | "hold" | "lane";
export type HoldDensityPosition = "head" | "middle" | "tail";
export type SpaceSide = "left" | "right";
export type TimingEventType = "speed" | "freeze" | "opacity";

export interface SongMeta {
  title: string;
  artist?: string;
  audioUrl?: string;
  audioFileName?: string;
  coverUrl?: string;
  coverFileName?: string;
  durationMs: number;
}

export interface LaneConfig {
  id: string;
  index: number;
  label: string;
  color: string;
  keyCodes: string[];
  isSpace: boolean;
  widthUnits: number;
}

export interface Note {
  id: string;
  timeMs: number;
  laneId: string;
  type: NoteType;
  isSpace?: boolean;
  spaceSide?: SpaceSide;
  span?: number;
  anchorLaneIndex?: number;
  targetLaneCount?: number;
  timingGroupId?: string;
  durationMs?: number;
  holdDensity?: number;
  holdDensityPosition?: HoldDensityPosition;
  judged?: boolean;
  result?: JudgeResult;
}

export interface BarLine {
  timeMs: number;
  beat: number;
  bar: number;
  isBarStart: boolean;
}

export interface TimingEvent {
  id: string;
  type: TimingEventType;
  timeMs: number;
  multiplier?: number;
  durationMs?: number;
  opacity?: number;
  transitionMs?: number;
}

export interface TimingGroup {
  id: string;
  name: string;
  events: TimingEvent[];
}

export interface Chart {
  id: string;
  version: 1;
  meta: SongMeta;
  bpm: number;
  beatsPerBar: number;
  initialLaneCount: number;
  laneCount: number;
  lanes: LaneConfig[];
  notes: Note[];
  barLines: BarLine[];
  timingGroups: TimingGroup[];
}

export type JudgeResult = "great" | "good" | "bad" | "miss";

export interface GenerateChartOptions {
  bpm: number;
  durationMs: number;
  laneCount: number;
  density: number;
  difficulty: number;
  includeSpace: boolean;
  title: string;
  artist?: string;
  audioUrl?: string;
  coverUrl?: string;
}

export interface LeadEvent {
  timeMs: number;
  frequencyHz: number;
  confidence: number;
  energy: number;
}

export type RhythmSource = "kick" | "onset" | "lead" | "grid";

export interface RhythmEvent {
  timeMs: number;
  source: RhythmSource;
  energy: number;
  confidence: number;
}

export interface GenerateLeadChartOptions extends GenerateChartOptions {
  leadEvents: LeadEvent[];
  rhythmEvents?: RhythmEvent[];
}

export interface PlayStats {
  score: number;
  combo: number;
  maxCombo: number;
  great: number;
  good: number;
  bad: number;
  miss: number;
}

export interface AudioAnalysis {
  bpm: number;
  durationMs: number;
  confidence: number;
  leadEvents?: LeadEvent[];
  rhythmEvents?: RhythmEvent[];
}

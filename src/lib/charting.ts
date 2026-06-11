import type { BarLine, Chart, GenerateChartOptions, GenerateLeadChartOptions, LeadEvent, Note, RhythmEvent, TimingGroup } from "../types";
import { clampLaneCount, createLaneConfigs } from "./keyboard";

const DEFAULT_BPM = 128;
const DEFAULT_DURATION_MS = 90_000;
export const DEFAULT_TIMING_GROUP_ID = "default";

interface LayoutState {
  recentLanes: number[];
  pitchRepeats: Map<number, number>;
}

interface CandidateEvent {
  timeMs: number;
  source: RhythmEvent["source"];
  energy: number;
  confidence: number;
  leadEvent?: LeadEvent;
}

export function createStarterChart(): Chart {
  return createManualChart({
    bpm: DEFAULT_BPM,
    durationMs: DEFAULT_DURATION_MS,
    laneCount: 4,
    title: "占位符-spaceholder",
    audioUrl: undefined,
  });
}

export function createManualChart(options: {
  bpm: number;
  durationMs: number;
  laneCount: number;
  initialLaneCount?: number;
  title: string;
  artist?: string;
  audioUrl?: string;
  audioFileName?: string;
  coverUrl?: string;
  coverFileName?: string;
  notes?: Note[];
}): Chart {
  const bpm = sanitizeBpm(options.bpm);
  const durationMs = Math.max(10_000, options.durationMs || DEFAULT_DURATION_MS);
  const laneCount = clampLaneCount(options.laneCount);
  const initialLaneCount = Math.min(laneCount, clampLaneCount(options.initialLaneCount ?? laneCount));
  const lanes = createLaneConfigs(laneCount);

  return {
    id: `manual-chart-${Date.now()}`,
    version: 1,
    meta: {
      title: options.title || "Untitled Track",
      artist: options.artist,
      durationMs,
      audioUrl: options.audioUrl,
      audioFileName: options.audioFileName,
      coverUrl: options.coverUrl || "/cover.svg",
      coverFileName: options.coverFileName,
    },
    bpm,
    beatsPerBar: 4,
    initialLaneCount,
    laneCount,
    lanes,
    notes: assignDefaultTimingGroup(options.notes ?? []),
    barLines: createBarLines(bpm, durationMs, 4),
    timingGroups: createDefaultTimingGroups(),
  };
}

export function createDefaultTimingGroups(): TimingGroup[] {
  return [{ id: DEFAULT_TIMING_GROUP_ID, name: "Default", events: [] }];
}

export function assignDefaultTimingGroup(notes: Note[]): Note[] {
  return notes.map((note) => ({
    ...note,
    timingGroupId: note.timingGroupId ?? DEFAULT_TIMING_GROUP_ID,
  }));
}

export function normalizeTimingGroups(groups?: TimingGroup[]): TimingGroup[] {
  const seen = new Set<string>();
  const normalized = (groups ?? [])
    .filter((group) => group && typeof group.id === "string" && group.id.trim())
    .map((group) => ({
      ...group,
      id: group.id.trim(),
      name: group.name?.trim() || group.id.trim(),
      events: (group.events ?? [])
        .filter((event) => Number.isFinite(event.timeMs))
        .map((event) => ({
          ...event,
          id: event.id || `timing-event-${Date.now()}-${Math.round(event.timeMs)}`,
          timeMs: Math.max(0, Math.round(event.timeMs)),
        }))
        .sort((a, b) => a.timeMs - b.timeMs),
    }))
    .filter((group) => {
      if (seen.has(group.id)) return false;
      seen.add(group.id);
      return true;
    });

  if (!normalized.some((group) => group.id === DEFAULT_TIMING_GROUP_ID)) {
    normalized.unshift(createDefaultTimingGroups()[0]);
  }

  return normalized;
}

export function createBarLines(bpm: number, durationMs: number, beatsPerBar = 4): BarLine[] {
  const safeBpm = sanitizeBpm(bpm);
  const beatMs = 60_000 / safeBpm;
  const totalBeats = Math.ceil(durationMs / beatMs);

  return Array.from({ length: totalBeats + 1 }, (_, beat) => ({
    timeMs: Math.round(beat * beatMs),
    beat,
    bar: Math.floor(beat / beatsPerBar) + 1,
    isBarStart: beat % beatsPerBar === 0,
  }));
}

export function generateRuleChart(options: GenerateChartOptions): Chart {
  const bpm = sanitizeBpm(options.bpm);
  const durationMs = Math.max(10_000, options.durationMs || DEFAULT_DURATION_MS);
  const laneCount = clampLaneCount(options.laneCount);
  const lanes = createLaneConfigs(laneCount);
  const barLines = createBarLines(bpm, durationMs, 4);
  const beatMs = 60_000 / bpm;
  const stepMs = beatMs / getSubdivision(options.difficulty);
  const seed = hashString(`${options.title}:${bpm}:${laneCount}:${options.difficulty}`);
  const random = seededRandom(seed);
  const notes: Note[] = [];
  const layoutState = createLayoutState();

  for (let timeMs = beatMs * 2; timeMs < durationMs - beatMs; timeMs += stepMs) {
    const beatIndex = Math.round(timeMs / beatMs);
    const isDownbeat = beatIndex % 4 === 0;
    const isHalfBeat = Math.round((timeMs / beatMs) * 2) % 2 === 1;
    const threshold = Math.min(0.88, options.density + (isDownbeat ? 0.18 : 0) - (isHalfBeat ? 0.08 : 0));

    if (random() > threshold) {
      continue;
    }

    const createSpaceChord = options.includeSpace && laneCount >= 2 && isDownbeat && random() < 0.16;
    const span = createSpaceChord ? Math.min(laneCount, Math.max(2, laneCount >= 4 ? 3 : 2)) : 1;
    const rawLaneIndex = createSpaceChord
      ? Math.floor(random() * (laneCount - span + 1))
      : Math.floor(random() * laneCount);
    const laneIndex = createSpaceChord
      ? resolveSpaceStart(rawLaneIndex, span, laneCount, layoutState)
      : resolveLaneIndex(rawLaneIndex, laneCount, layoutState, random);

    const lane = lanes[laneIndex];
    recordLayoutLane(layoutState, laneIndex);
    notes.push({
      id: `note-${notes.length + 1}`,
      timeMs: Math.round(timeMs),
      laneId: lane.id,
      type: "tap",
      isSpace: createSpaceChord,
      span,
    });
  }

  return {
    id: `chart-${Date.now()}`,
    version: 1,
    meta: {
      title: options.title || "Untitled Track",
      artist: options.artist,
      durationMs,
      audioUrl: options.audioUrl,
      coverUrl: options.coverUrl || "/cover.svg",
    },
    bpm,
    beatsPerBar: 4,
    initialLaneCount: laneCount,
    laneCount,
    lanes,
    notes: assignDefaultTimingGroup(notes),
    barLines,
    timingGroups: createDefaultTimingGroups(),
  };
}

export function generateLeadChart(options: GenerateLeadChartOptions): Chart {
  const cleanedEvents = cleanLeadEvents(options.leadEvents);

  if (cleanedEvents.length < 8) {
    return generateRuleChart(options);
  }

  const bpm = sanitizeBpm(options.bpm);
  const durationMs = Math.max(10_000, options.durationMs || DEFAULT_DURATION_MS);
  const laneCount = clampLaneCount(options.laneCount);
  const lanes = createLaneConfigs(laneCount);
  const barLines = createBarLines(bpm, durationMs, 4);
  const beatMs = 60_000 / bpm;
  const subdivision = options.difficulty >= 4 ? 4 : options.difficulty >= 3 ? 2 : 1;
  const gridMs = beatMs / subdivision;
  const pitchLaneMap = createPitchLaneMap(cleanedEvents, laneCount);
  const density = Math.max(0.15, Math.min(0.95, options.density));
  const notes: Note[] = [];
  const occupiedTimes = new Set<number>();
  const leadByGrid = groupLeadEventsByGrid(cleanedEvents, gridMs);
  const candidateEvents = buildLeadChartCandidates(cleanedEvents, options.rhythmEvents ?? [], bpm, durationMs, gridMs, density, options.difficulty);
  const layoutState = createLayoutState();
  const sectionMemory = new Map<string, number[]>();
  const sectionUseCount = new Map<string, number>();

  candidateEvents.forEach((candidate) => {
    const roundedTimeMs = Math.round(Math.max(beatMs, Math.min(durationMs - beatMs, Math.round(candidate.timeMs / gridMs) * gridMs)));
    if (occupiedTimes.has(roundedTimeMs)) {
      return;
    }

    const event = candidate.leadEvent ?? pickLeadEventForGrid(cleanedEvents, leadByGrid, roundedTimeMs, gridMs);
    if (!event) {
      return;
    }

    const beatIndex = Math.round(roundedTimeMs / beatMs);
    const sectionIndex = Math.floor(beatIndex / 4);
    const slotInSection = beatIndex % 4;
    const isDownbeat = beatIndex % 4 === 0;
    const isHalfBeat = subdivision > 1 && Math.round((roundedTimeMs / beatMs) * 2) % 2 === 1;
    const sourceWeight = candidate.source === "kick" ? 0.34 : candidate.source === "onset" ? 0.18 : 0;
    const localConfidence = Math.min(1, candidate.confidence * 0.72 + event.confidence * 0.34 + event.energy * 1.2 + sourceWeight);
    const keepThreshold = density + (isDownbeat ? 0.25 : 0) - (isHalfBeat ? 0.14 : 0);

    if (!isDownbeat && localConfidence < keepThreshold * 0.72) {
      return;
    }

    const pitchKey = frequencyToMidi(event.frequencyHz);
    const rawLaneIndex = pitchLaneMap.get(pitchKey) ?? Math.floor(laneCount / 2);
    const isStrongBeat = Math.round(roundedTimeMs / beatMs) % 4 === 0;
    const makeSpaceChord = options.includeSpace && laneCount >= 2 && isStrongBeat && event.confidence > 0.5 && shouldUseSpaceChord(pitchKey, beatIndex, laneCount);
    const laneIndex = resolveLeadLaneIndex(rawLaneIndex, pitchKey, laneCount, layoutState);
    const span = makeSpaceChord ? Math.min(laneCount - laneIndex, Math.max(2, laneCount >= 4 ? 3 : 2)) : 1;
    let safeLaneIndex = makeSpaceChord
      ? resolveSpaceStart(Math.min(laneIndex, laneCount - span), span, laneCount, layoutState)
      : laneIndex;
    const signature = getSectionSignature(candidateEvents, sectionIndex, beatMs);
    const mirror = shouldMirrorSection(signature, sectionMemory, sectionUseCount);
    if (mirror) {
      safeLaneIndex = mirrorLaneIndex(safeLaneIndex, span, laneCount);
    }

    notes.push({
      id: `lead-note-${notes.length + 1}`,
      timeMs: roundedTimeMs,
      laneId: lanes[safeLaneIndex].id,
      type: "tap",
      isSpace: makeSpaceChord,
      span,
    });
    occupiedTimes.add(roundedTimeMs);
    recordLayoutLane(layoutState, safeLaneIndex);
    rememberSectionLane(signature, sectionMemory, slotInSection, safeLaneIndex);
  });

  if (notes.length < 8) {
    return generateRuleChart(options);
  }

  return {
    id: `lead-chart-${Date.now()}`,
    version: 1,
    meta: {
      title: options.title || "Untitled Track",
      artist: options.artist,
      durationMs,
      audioUrl: options.audioUrl,
      coverUrl: options.coverUrl || "/cover.svg",
    },
    bpm,
    beatsPerBar: 4,
    initialLaneCount: laneCount,
    laneCount,
    lanes,
    notes: assignDefaultTimingGroup(notes),
    barLines,
    timingGroups: createDefaultTimingGroups(),
  };
}

export function rebuildChartGrid(chart: Chart, bpm: number, laneCount = chart.laneCount): Chart {
  const safeBpm = sanitizeBpm(bpm);
  const safeLaneCount = clampLaneCount(laneCount);
  const lanes = createLaneConfigs(safeLaneCount);
  const initialLaneCount = Math.min(safeLaneCount, clampLaneCount(chart.initialLaneCount ?? safeLaneCount));

  return {
    ...chart,
    bpm: safeBpm,
    initialLaneCount,
    laneCount: safeLaneCount,
    lanes,
    barLines: createBarLines(safeBpm, chart.meta.durationMs, chart.beatsPerBar),
    notes: assignDefaultTimingGroup(chart.notes),
    timingGroups: normalizeTimingGroups(chart.timingGroups),
  };
}

export function sanitizeBpm(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_BPM;
  }

  return Math.min(240, Math.max(60, Math.round(value)));
}

export function getJudgeResult(offsetMs: number) {
  const abs = Math.abs(offsetMs);
  if (abs <= 70) return "great";
  if (abs <= 125) return "good";
  if (abs <= 180) return "bad";
  return "miss";
}

function getSubdivision(difficulty: number): number {
  if (difficulty >= 4) return 4;
  if (difficulty >= 2) return 2;
  return 1;
}

function createLayoutState(): LayoutState {
  return {
    recentLanes: [],
    pitchRepeats: new Map(),
  };
}

function resolveLaneIndex(candidate: number, laneCount: number, state: LayoutState, random: () => number) {
  const recent = state.recentLanes;
  const last = recent[recent.length - 1];
  const secondLast = recent[recent.length - 2];
  const wouldTripleJack = candidate === last && candidate === secondLast;
  const wouldImmediateJack = candidate === last;

  if (!wouldTripleJack && (!wouldImmediateJack || random() < 0.18)) {
    return candidate;
  }

  const alternatives = orderedLaneAlternatives(candidate, laneCount);
  const preferred = alternatives.find((lane) => lane !== last && !sameHandHeavy(lane, recent, laneCount));
  return preferred ?? alternatives.find((lane) => lane !== last) ?? candidate;
}

function resolveLeadLaneIndex(baseLane: number, pitchKey: number, laneCount: number, state: LayoutState) {
  const repeatCount = state.pitchRepeats.get(pitchKey) ?? 0;
  state.pitchRepeats.set(pitchKey, repeatCount + 1);

  const offsetPattern = [0, 1, -1, 2, -2];
  const preferred = clampLane(baseLane + offsetPattern[repeatCount % offsetPattern.length], laneCount);
  const recent = state.recentLanes;
  const last = recent[recent.length - 1];
  const secondLast = recent[recent.length - 2];

  if (preferred !== last || preferred !== secondLast) {
    return preferred;
  }

  return orderedLaneAlternatives(baseLane, laneCount).find((lane) => lane !== last) ?? preferred;
}

function resolveSpaceStart(candidate: number, span: number, laneCount: number, state: LayoutState) {
  const safeCandidate = Math.min(Math.max(0, candidate), Math.max(0, laneCount - span));
  const recent = state.recentLanes;
  const last = recent[recent.length - 1];

  if (last === undefined || last < safeCandidate || last >= safeCandidate + span) {
    return safeCandidate;
  }

  const options = Array.from({ length: Math.max(1, laneCount - span + 1) }, (_, index) => index);
  return options.find((start) => last < start || last >= start + span) ?? safeCandidate;
}

function recordLayoutLane(state: LayoutState, laneIndex: number) {
  state.recentLanes.push(laneIndex);
  if (state.recentLanes.length > 6) {
    state.recentLanes.shift();
  }
}

function orderedLaneAlternatives(candidate: number, laneCount: number) {
  return Array.from({ length: laneCount }, (_, lane) => lane)
    .filter((lane) => lane !== candidate)
    .sort((a, b) => Math.abs(a - candidate) - Math.abs(b - candidate) || a - b);
}

function sameHandHeavy(lane: number, recent: number[], laneCount: number) {
  const hand = lane < laneCount / 2 ? "left" : "right";
  const lastTwo = recent.slice(-2);
  return lastTwo.length === 2 && lastTwo.every((recentLane) => (recentLane < laneCount / 2 ? "left" : "right") === hand);
}

function clampLane(lane: number, laneCount: number) {
  return Math.min(laneCount - 1, Math.max(0, lane));
}

function cleanLeadEvents(events: LeadEvent[]) {
  return events
    .filter((event) => Number.isFinite(event.timeMs) && Number.isFinite(event.frequencyHz) && event.frequencyHz >= 80 && event.frequencyHz <= 1200 && event.confidence >= 0.35)
    .sort((a, b) => a.timeMs - b.timeMs);
}

function buildLeadChartCandidates(
  leadEvents: LeadEvent[],
  rhythmEvents: RhythmEvent[],
  bpm: number,
  durationMs: number,
  gridMs: number,
  density: number,
  difficulty: number,
): CandidateEvent[] {
  const beatMs = 60_000 / bpm;
  const candidates: CandidateEvent[] = [];
  const sourcePriority = { kick: 4, lead: 3, onset: 2, grid: 1 };

  rhythmEvents.forEach((event) => {
    const leadEvent = event.source === "lead"
      ? nearestLeadEvent(leadEvents, event.timeMs, gridMs * 1.3)
      : nearestLeadEvent(leadEvents, event.timeMs, beatMs * 1.25);
    candidates.push({
      timeMs: event.timeMs,
      source: event.source,
      energy: event.energy,
      confidence: event.confidence,
      leadEvent,
    });
  });

  leadEvents.forEach((event) => {
    candidates.push({
      timeMs: event.timeMs,
      source: "lead",
      energy: event.energy,
      confidence: event.confidence,
      leadEvent: event,
    });
  });

  const maxGapMs = beatMs * (density > 0.65 || difficulty >= 3 ? 1.5 : 2.25);
  for (let timeMs = beatMs; timeMs <= durationMs - beatMs; timeMs += gridMs) {
    const nearest = nearestCandidate(candidates, timeMs, maxGapMs);
    const isStrongBeat = Math.round(timeMs / beatMs) % 4 === 0;
    const shouldFill = !nearest || Math.abs(nearest.timeMs - timeMs) > maxGapMs;
    const shouldDecorate = difficulty >= 4 && density > 0.58 && Math.round((timeMs / beatMs) * 4) % 4 !== 0 && hashString(`grid:${Math.round(timeMs)}`) % 4 === 0;

    if (isStrongBeat || shouldFill || shouldDecorate) {
      const leadEvent = nearestLeadEvent(leadEvents, timeMs, beatMs * 2);
      if (leadEvent) {
        candidates.push({
          timeMs,
          source: "grid",
          energy: leadEvent.energy * 0.72,
          confidence: Math.max(0.3, leadEvent.confidence * 0.68),
          leadEvent,
        });
      }
    }
  }

  const byGrid = new Map<number, CandidateEvent>();
  candidates.forEach((candidate) => {
    const key = Math.round(Math.round(candidate.timeMs / gridMs) * gridMs);
    const previous = byGrid.get(key);
    if (!previous || sourcePriority[candidate.source] > sourcePriority[previous.source] || candidate.confidence > previous.confidence + 0.2) {
      byGrid.set(key, { ...candidate, timeMs: key });
    }
  });

  return [...byGrid.values()].sort((a, b) => a.timeMs - b.timeMs);
}

function nearestLeadEvent(events: LeadEvent[], timeMs: number, maxDistanceMs: number) {
  let best: LeadEvent | undefined;
  let bestDistance = Infinity;
  events.forEach((event) => {
    const distance = Math.abs(event.timeMs - timeMs);
    if (distance <= maxDistanceMs && distance < bestDistance) {
      best = event;
      bestDistance = distance;
    }
  });
  return best;
}

function nearestCandidate(events: CandidateEvent[], timeMs: number, maxDistanceMs: number) {
  let best: CandidateEvent | undefined;
  let bestDistance = Infinity;
  events.forEach((event) => {
    const distance = Math.abs(event.timeMs - timeMs);
    if (distance <= maxDistanceMs && distance < bestDistance) {
      best = event;
      bestDistance = distance;
    }
  });
  return best;
}

function getSectionSignature(events: CandidateEvent[], sectionIndex: number, beatMs: number) {
  const sectionStart = sectionIndex * beatMs * 4;
  const sectionEnd = sectionStart + beatMs * 4;
  const slots = events
    .filter((event) => event.timeMs >= sectionStart && event.timeMs < sectionEnd)
    .map((event) => `${Math.round((event.timeMs - sectionStart) / (beatMs / 2))}:${event.source}`)
    .slice(0, 12);
  return slots.join("|") || `empty-${sectionIndex}`;
}

function shouldMirrorSection(signature: string, memory: Map<string, number[]>, useCount: Map<string, number>) {
  if (!memory.has(signature)) {
    return false;
  }
  const count = useCount.get(signature) ?? 0;
  useCount.set(signature, count + 1);
  return count % 2 === 0;
}

function rememberSectionLane(signature: string, memory: Map<string, number[]>, slotInSection: number, laneIndex: number) {
  const lanes = memory.get(signature) ?? [];
  lanes[slotInSection] = laneIndex;
  memory.set(signature, lanes);
}

function mirrorLaneIndex(laneIndex: number, span: number, laneCount: number) {
  if (span <= 1) {
    return laneCount - 1 - laneIndex;
  }
  return Math.max(0, laneCount - laneIndex - span);
}

function groupLeadEventsByGrid(events: LeadEvent[], gridMs: number) {
  const groups = new Map<number, LeadEvent[]>();
  events.forEach((event) => {
    const gridTime = Math.round(event.timeMs / gridMs) * gridMs;
    const key = Math.round(gridTime);
    const group = groups.get(key) ?? [];
    group.push(event);
    groups.set(key, group);
  });
  return groups;
}

function pickLeadEventForGrid(events: LeadEvent[], groupedEvents: Map<number, LeadEvent[]>, timeMs: number, gridMs: number) {
  const direct = groupedEvents.get(Math.round(timeMs));
  if (direct?.length) {
    return strongestLeadEvent(direct);
  }

  const lookbackMs = gridMs * 1.6;
  let best: LeadEvent | undefined;
  let bestScore = -Infinity;

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const age = timeMs - event.timeMs;
    if (age < -gridMs * 0.45) {
      continue;
    }
    if (age > lookbackMs) {
      break;
    }

    const score = event.confidence * 0.72 + event.energy * 2 - Math.max(0, age) / lookbackMs * 0.25;
    if (score > bestScore) {
      bestScore = score;
      best = event;
    }
  }

  return best;
}

function strongestLeadEvent(events: LeadEvent[]) {
  return events.reduce((best, event) => (
    event.confidence * 0.7 + event.energy * 2 > best.confidence * 0.7 + best.energy * 2 ? event : best
  ), events[0]);
}

function createPitchLaneMap(events: LeadEvent[], laneCount: number) {
  const pitchKeys = [...new Set(events.map((event) => frequencyToMidi(event.frequencyHz)).filter((pitch) => pitch > 0))]
    .sort((a, b) => a - b);
  const map = new Map<number, number>();

  if (!pitchKeys.length) {
    return map;
  }

  const low = pitchKeys[Math.floor(pitchKeys.length * 0.08)] ?? pitchKeys[0];
  const high = pitchKeys[Math.floor(pitchKeys.length * 0.92)] ?? pitchKeys[pitchKeys.length - 1];

  pitchKeys.forEach((pitch) => {
    const normalized = high <= low ? 0.5 : Math.max(0, Math.min(1, (pitch - low) / (high - low)));
    map.set(pitch, Math.min(laneCount - 1, Math.max(0, Math.round(normalized * (laneCount - 1)))));
  });

  return map;
}

function frequencyToMidi(frequencyHz: number) {
  if (!Number.isFinite(frequencyHz) || frequencyHz <= 0) {
    return 0;
  }
  return Math.round(69 + 12 * Math.log2(frequencyHz / 440));
}

function shouldUseSpaceChord(pitchKey: number, beatIndex: number, laneCount: number) {
  if (laneCount < 2) {
    return false;
  }
  return hashString(`${pitchKey}:${beatIndex % 16}:space`) % 5 === 0;
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed: number) {
  let state = seed || 1;
  return () => {
    state = Math.imul(1664525, state) + 1013904223;
    return ((state >>> 0) / 4294967296);
  };
}

import { ChangeEvent, Fragment, KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import type { Chart, HoldDensityPosition, JudgeResult, LaneConfig, Note, PlayStats, SpaceSide, TimingEvent, TimingEventType, TimingGroup } from "./types";
import { DEFAULT_TIMING_GROUP_ID, assignDefaultTimingGroup, createDefaultTimingGroups, createManualChart, createStarterChart, getJudgeResult, normalizeTimingGroups, rebuildChartGrid, sanitizeBpm } from "./lib/charting";
import { clampLaneCount, findLaneForKey, getKeyboardSegments, getPlayableCodeIndex, shouldIgnoreKey } from "./lib/keyboard";

type Page = "play" | "editor";
type PlayPhase = "menu" | "game";
type PlacementMode = "select" | "tap" | "tap-hold" | "space-left" | "space-right" | "space-hold" | "lane";

interface SelectionRange {
  startMs: number;
  endMs: number;
}

interface PlacementTarget {
  laneId: string;
  timeMs: number;
  anchorLaneIndex: number;
}

const BASE_FALL_MS = 1800;
const JUDGE_LINE_PERCENT = 87;
const HIT_WINDOW_MS = 180;
const MAX_SCORE = 10_000_000;
const KEY_SOUND_LOOKAHEAD_MS = 90;
const TOUCH_SPACE_GRACE_MS = 100;
const PLAY_PREROLL_MS = 700;
const TOUCH_LEFT_ZONE_RATIO = 0.47;
const TOUCH_RIGHT_ZONE_RATIO = 0.53;
const CALIBRATION_TAP_COUNT = 15;
const CALIBRATION_FIRST_TAP_MS = 1500;
const CALIBRATION_INTERVAL_MS = 900;
const CALIBRATION_HIT_WINDOW_MS = 360;
const FIXED_WIDTH_LANES = 7;
const DEFAULT_HOLD_DURATION_MS = 1000;
const DEFAULT_HOLD_DENSITY = 4;
const DEFAULT_HOLD_DENSITY_POSITION: HoldDensityPosition = "middle";
const LEFT_SPACE_INPUT_CODES = new Set([
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
]);
const RIGHT_SPACE_INPUT_CODES = new Set([
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
]);
const INITIAL_STATS: PlayStats = {
  score: 0,
  combo: 0,
  maxCombo: 0,
  great: 0,
  good: 0,
  bad: 0,
  miss: 0,
};

interface JudgeBurst {
  id: string;
  result: JudgeResult;
  laneId: string;
  span: number;
  anchorLaneIndex?: number;
  spaceSide?: SpaceSide;
}

interface TouchInputState {
  pointerId: number;
  x: number;
  y: number;
  laneId?: string;
  laneIndex?: number;
  lanePressMs?: number;
  startedAtMs: number;
}

interface TouchStartInput {
  pointerId: number;
  x: number;
  y: number;
  laneId?: string;
  laneIndex?: number;
  side?: SpaceSide;
}

interface TouchHoldInputSnapshot {
  activeTouches: Map<number, TouchInputState>;
  lastTouchReleaseMs: number | null;
  spaceGraceMs: number;
}

interface HoldInputState {
  isHeld: boolean;
  isEligible: boolean;
  code?: string;
  pressMs?: number;
}

interface MusicGainChain {
  source: MediaElementAudioSourceNode;
  gain: GainNode;
}

type MusicGainWindow = Window & {
  __spaceholderMusicGainChains?: WeakMap<HTMLMediaElement, MusicGainChain>;
};

const AUDIO_FILE_ACCEPT = [
  "audio/*",
  "video/quicktime",
  "video/mp4",
  ".mp3",
  ".m4a",
  ".aac",
  ".wav",
  ".flac",
  ".ogg",
  ".mov",
  ".mp4",
].join(",");

export default function App() {
  const [page, setPage] = useState<Page>(() => getPageFromPath(window.location.pathname));
  const [chart, setChart] = useState<Chart>(() => createStarterChart());
  const [musicVolume, setMusicVolume] = useStoredNumber("keyboard-beat-lab:music-volume", 0.82);
  const [keyVolume, setKeyVolume] = useStoredNumber("keyboard-beat-lab:key-volume", 0.9);
  const [playSpeed, setPlaySpeed] = useStoredNumber("keyboard-beat-lab:play-speed", 1);
  const [noteSize, setNoteSize] = useStoredNumber("keyboard-beat-lab:note-size", 100);
  const [editorSpeed, setEditorSpeed] = useStoredNumber("keyboard-beat-lab:editor-speed", 1);
  const [snapDivision, setSnapDivision] = useStoredNumber("keyboard-beat-lab:snap-division", 4);
  const [holdDensity, setHoldDensity] = useStoredNumber("keyboard-beat-lab:hold-density", DEFAULT_HOLD_DENSITY);
  const [offsetMs, setOffsetMs] = useStoredNumber("keyboard-beat-lab:key-offset-ms", 0);
  const [autoplay, setAutoplay] = useStoredBoolean("keyboard-beat-lab:autoplay", false);

  useEffect(() => {
    const handlePopState = () => setPage(getPageFromPath(window.location.pathname));
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  return (
    <main className={`app-shell ${page === "play" ? "play-shell" : ""}`}>
      {page === "editor" ? (
        <header className="topbar">
          <div className="brand">
            <img className="brand-artwork" src={chart.meta.coverUrl || "/cover.svg"} alt="" />
            <div>
              <strong>{chart.meta.title}</strong>
              <span>{chart.meta.artist || "Unknown Artist"}</span>
            </div>
          </div>
        </header>
      ) : null}

      {page === "play" ? (
        <PlayView
          chart={chart}
          onChartChange={setChart}
          musicVolume={musicVolume}
          keyVolume={keyVolume}
          noteSpeed={playSpeed}
          noteSize={noteSize}
          offsetMs={offsetMs}
          autoplay={autoplay}
          onMusicVolumeChange={setMusicVolume}
          onKeyVolumeChange={setKeyVolume}
          onNoteSpeedChange={setPlaySpeed}
          onNoteSizeChange={setNoteSize}
          onOffsetChange={setOffsetMs}
          onAutoplayChange={setAutoplay}
        />
      ) : (
        <EditorView
          chart={chart}
          onChartChange={setChart}
          musicVolume={musicVolume}
          keyVolume={keyVolume}
          noteSize={noteSize}
          editorSpeed={editorSpeed}
          snapDivision={snapDivision}
          holdDensity={holdDensity}
          onMusicVolumeChange={setMusicVolume}
          onKeyVolumeChange={setKeyVolume}
          onEditorSpeedChange={setEditorSpeed}
          onSnapDivisionChange={setSnapDivision}
          onHoldDensityChange={setHoldDensity}
        />
      )}
    </main>
  );
}

function useStoredNumber(key: string, fallback: number) {
  const [value, setValue] = useState(() => {
    const stored = window.localStorage.getItem(key);
    const parsed = stored === null ? NaN : Number(stored);
    return Number.isFinite(parsed) ? parsed : fallback;
  });

  useEffect(() => {
    window.localStorage.setItem(key, String(value));
  }, [key, value]);

  return [value, setValue] as const;
}

function useStoredBoolean(key: string, fallback: boolean) {
  const [value, setValue] = useState(() => {
    const stored = window.localStorage.getItem(key);
    return stored === null ? fallback : stored === "true";
  });

  useEffect(() => {
    window.localStorage.setItem(key, String(value));
  }, [key, value]);

  return [value, setValue] as const;
}

function getPageFromPath(pathname: string): Page {
  return pathname.replace(/\/+$/, "") === "/editor" ? "editor" : "play";
}

function PlaySettingsControls({
  musicVolume,
  keyVolume,
  noteSpeed,
  noteSize,
  offsetMs,
  autoplay,
  onMusicVolumeChange,
  onKeyVolumeChange,
  onNoteSpeedChange,
  onNoteSizeChange,
  onOffsetChange,
  onAutoplayChange,
}: {
  musicVolume: number;
  keyVolume: number;
  noteSpeed: number;
  noteSize: number;
  offsetMs: number;
  autoplay: boolean;
  onMusicVolumeChange: (volume: number) => void;
  onKeyVolumeChange: (volume: number) => void;
  onNoteSpeedChange: (speed: number) => void;
  onNoteSizeChange: (size: number) => void;
  onOffsetChange: (offsetMs: number) => void;
  onAutoplayChange: (enabled: boolean) => void;
}) {
  return (
    <div className="play-settings-controls">
      <label className="speed-control">
        <span>Speed {noteSpeed.toFixed(1)}x</span>
        <input
          type="range"
          min={0.6}
          max={2.2}
          step={0.1}
          value={noteSpeed}
          onChange={(event) => onNoteSpeedChange(Number(event.target.value))}
        />
      </label>
      <label className="speed-control">
        <span>Note Width {Math.round(noteSize)}%</span>
        <input
          type="range"
          min={50}
          max={100}
          step={1}
          value={noteSize}
          onChange={(event) => onNoteSizeChange(Number(event.target.value))}
        />
      </label>
      <label className="speed-control">
        <span>Music {Math.round(musicVolume * 100)}%</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={musicVolume}
          onChange={(event) => onMusicVolumeChange(Number(event.target.value))}
        />
      </label>
      <label className="speed-control">
        <span>Key {Math.round(keyVolume * 100)}%</span>
        <input
          type="range"
          min={0}
          max={2.5}
          step={0.01}
          value={keyVolume}
          onChange={(event) => onKeyVolumeChange(Number(event.target.value))}
        />
      </label>
      <label className="speed-control">
        <span>Chart Offset {Math.round(offsetMs)}ms</span>
        <input
          type="range"
          min={-200}
          max={200}
          step={1}
          value={offsetMs}
          onChange={(event) => onOffsetChange(Number(event.target.value))}
        />
      </label>
      <label className="speed-control toggle-control">
        <span>Autoplay</span>
        <input
          type="checkbox"
          checked={autoplay}
          onChange={(event) => onAutoplayChange(event.target.checked)}
        />
      </label>
    </div>
  );
}

function PlayView({
  chart,
  onChartChange,
  musicVolume,
  keyVolume,
  noteSpeed,
  noteSize,
  offsetMs,
  autoplay,
  onMusicVolumeChange,
  onKeyVolumeChange,
  onNoteSpeedChange,
  onNoteSizeChange,
  onOffsetChange,
  onAutoplayChange,
}: {
  chart: Chart;
  onChartChange: (chart: Chart) => void;
  musicVolume: number;
  keyVolume: number;
  noteSpeed: number;
  noteSize: number;
  offsetMs: number;
  autoplay: boolean;
  onMusicVolumeChange: (volume: number) => void;
  onKeyVolumeChange: (volume: number) => void;
  onNoteSpeedChange: (speed: number) => void;
  onNoteSizeChange: (size: number) => void;
  onOffsetChange: (offsetMs: number) => void;
  onAutoplayChange: (enabled: boolean) => void;
}) {
  const [playPhase, setPlayPhase] = useState<PlayPhase>("menu");
  const [menuStatus, setMenuStatus] = useState("导入包含音乐和曲绘的 JSON 后开始游玩");
  const playAudioInputRef = useRef<HTMLInputElement | null>(null);
  const playArtworkInputRef = useRef<HTMLInputElement | null>(null);
  const playChartInputRef = useRef<HTMLInputElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [judgedIds, setJudgedIds] = useState<Set<string>>(() => new Set());
  const [judgedHoldTickIds, setJudgedHoldTickIds] = useState<Set<string>>(() => new Set());
  const [activeLaneIds, setActiveLaneIds] = useState<Set<string>>(() => new Set());
  const [activeSpaceSides, setActiveSpaceSides] = useState<Set<SpaceSide>>(() => new Set());
  const [judgeBursts, setJudgeBursts] = useState<JudgeBurst[]>([]);
  const [stats, setStats] = useState<PlayStats>(INITIAL_STATS);
  const [showPauseMenu, setShowPauseMenu] = useState(false);
  const [calibrationActive, setCalibrationActive] = useState(false);
  const [calibrationSamples, setCalibrationSamples] = useState<number[]>([]);
  const [calibrationResultMs, setCalibrationResultMs] = useState<number | null>(null);
  const [currentLaneCount, setCurrentLaneCount] = useState(() => getInitialLaneCount(chart));
  const [triggeredLaneNoteIds, setTriggeredLaneNoteIds] = useState<Set<string>>(() => new Set());
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const musicGainRef = useRef<GainNode | null>(null);
  const currentMsRef = useRef(0);
  const playbackActiveRef = useRef(false);
  const playbackTokenRef = useRef(0);
  const audioStartPendingRef = useRef(false);
  const startAtRef = useRef(0);
  const animationRef = useRef<number | null>(null);
  const pressedCodesRef = useRef<Set<string>>(new Set());
  const keyPressTimesRef = useRef<Map<string, number>>(new Map());
  const armedHoldInputsRef = useRef<Map<string, number>>(new Map());
  const startedTapHoldIdsRef = useRef<Set<string>>(new Set());
  const failedTapHoldIdsRef = useRef<Set<string>>(new Set());
  const caughtSpaceHoldIdsRef = useRef<Set<string>>(new Set());
  const activeSpaceLaneIdsRef = useRef<string[]>([]);
  const laneFieldRef = useRef<HTMLDivElement | null>(null);
  const activeTouchesRef = useRef<Map<number, TouchInputState>>(new Map());
  const touchStartQueueRef = useRef<TouchStartInput[]>([]);
  const touchBatchRafRef = useRef<number | null>(null);
  const lastTouchReleaseMsRef = useRef<number | null>(null);

  const chartDuration = chart.meta.durationMs;
  const playDuration = chartDuration + PLAY_PREROLL_MS;
  const calibrationDurationMs = CALIBRATION_FIRST_TAP_MS + (CALIBRATION_TAP_COUNT - 1) * CALIBRATION_INTERVAL_MS + 1600;
  const fallMs = BASE_FALL_MS / noteSpeed;
  const chartMs = calibrationActive ? currentMs : currentMs - PLAY_PREROLL_MS - offsetMs;
  const activeLanes = useMemo(
    () => getActiveLaneSlice(chart.lanes, currentLaneCount),
    [chart.lanes, currentLaneCount],
  );
  const timingGroups = useMemo(() => getTimingGroups(chart), [chart]);
  const noteDisplayOrder = useMemo(
    () => new Map(chart.notes.map((note, index) => [note.id, index])),
    [chart.notes],
  );
  const keyboardSegments = useMemo(() => getKeyboardSegments(activeLanes), [activeLanes]);
  const chartLaneIndexById = useMemo(
    () => new Map(chart.lanes.map((lane, index) => [lane.id, index])),
    [chart.lanes],
  );
  const playableNotes = useMemo(
    () => chart.notes.filter((note) => !isLaneNote(note) && isNoteVisibleOnLanes(note, activeLanes)),
    [activeLanes, chart.notes],
  );
  const judgementWindowNotes = useMemo(
    () => playableNotes.filter((note) => (
      getNoteEndTimeMs(note) >= chartMs - HIT_WINDOW_MS * 2
      && note.timeMs <= chartMs + HIT_WINDOW_MS
    )),
    [chartMs, playableNotes],
  );
  const visiblePlayableNotes = useMemo(
    () => playableNotes.filter((note) => isNoteVisuallyInWindow(note, chartMs, fallMs, getTimingGroupForNote(note, timingGroups))),
    [chartMs, fallMs, playableNotes, timingGroups],
  );
  const visibleSpaceNoteList = useMemo(
    () => calibrationActive ? [] : visibleSpaceNotes(visiblePlayableNotes, chartMs, fallMs, timingGroups),
    [calibrationActive, chartMs, fallMs, timingGroups, visiblePlayableNotes],
  );
  const scoreUnit = useMemo(
    () => MAX_SCORE / Math.max(1, countScoringJudgements(chart)),
    [chart],
  );
  const visibleLaneEventNotes = useMemo(
    () => chart.notes.filter((note) => isLaneNote(note) && isNoteVisuallyInWindow(note, chartMs, fallMs, getTimingGroupForNote(note, timingGroups))),
    [chart.notes, chartMs, fallMs, timingGroups],
  );
  const calibrationLane = activeLanes[Math.floor(activeLanes.length / 2)] ?? activeLanes[0];
  const calibrationNotes = useMemo<Note[]>(() => {
    if (!calibrationActive || !calibrationLane) return [];
    return Array.from({ length: CALIBRATION_TAP_COUNT }, (_, index) => ({
      id: `calibration-${index}`,
      timeMs: CALIBRATION_FIRST_TAP_MS + index * CALIBRATION_INTERVAL_MS,
      laneId: calibrationLane.id,
      type: "tap" as const,
    }));
  }, [calibrationActive, calibrationLane]);
  const calibrationHitIds = useMemo(
    () => new Set(calibrationSamples.map((_, index) => `calibration-${index}`)),
    [calibrationSamples],
  );
  const visibleTapNotesByLane = useMemo(() => {
    const next = new Map<string, Note[]>();
    const source = calibrationActive ? calibrationNotes : visiblePlayableNotes;
    source.forEach((note) => {
      if (note.isSpace || isLaneNote(note)) return;
      const laneNotes = next.get(note.laneId) ?? [];
      laneNotes.push(note);
      next.set(note.laneId, laneNotes);
    });
    return next;
  }, [calibrationActive, calibrationNotes, visiblePlayableNotes]);

  const stopRaf = useCallback(() => {
    if (animationRef.current !== null) {
      cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }
  }, []);

  const readPlayheadMs = useCallback(() => {
    const audio = audioRef.current;
    const next = audio && !audio.paused
      ? audio.currentTime * 1000 + (calibrationActive ? 0 : PLAY_PREROLL_MS)
      : playbackActiveRef.current
        ? performance.now() - startAtRef.current
        : currentMsRef.current;
    return Math.min(calibrationActive ? calibrationDurationMs : playDuration, Math.max(0, next));
  }, [calibrationActive, calibrationDurationMs, playDuration]);

  const startAudioForTimeline = useCallback(async (timelineMs: number, token: number) => {
    const audio = audioRef.current;
    if (!audio) return true;
    unlockAudioForPlayback(audio, musicVolume);
    const audioMs = calibrationActive ? timelineMs : Math.max(0, timelineMs - PLAY_PREROLL_MS);
    audio.currentTime = audioMs / 1000;
    try {
      await audio.play();
    } catch {
      return playbackTokenRef.current === token && !audio.paused;
    }
    if (playbackTokenRef.current !== token) {
      audio.pause();
      return false;
    }
    return true;
  }, [calibrationActive, musicVolume]);

  const tick = useCallback(() => {
    const next = readPlayheadMs();
    currentMsRef.current = next;
    setCurrentMs(next);
    const shouldStartAudio = !calibrationActive
      && playbackActiveRef.current
      && next >= PLAY_PREROLL_MS
      && audioRef.current
      && audioRef.current.paused
      && !audioStartPendingRef.current;
    if (shouldStartAudio) {
      const token = playbackTokenRef.current;
      audioStartPendingRef.current = true;
      void startAudioForTimeline(next, token).then((started) => {
        audioStartPendingRef.current = false;
        if (!started && playbackTokenRef.current === token) {
          playbackActiveRef.current = false;
          setIsPlaying(false);
          stopRaf();
        }
      });
    }
    animationRef.current = requestAnimationFrame(tick);
  }, [calibrationActive, readPlayheadMs, startAudioForTimeline, stopRaf]);

  useEffect(() => {
    currentMsRef.current = currentMs;
  }, [currentMs]);

  const clearTouchInputs = useCallback(() => {
    activeTouchesRef.current.clear();
    touchStartQueueRef.current = [];
    lastTouchReleaseMsRef.current = null;
    if (touchBatchRafRef.current !== null) {
      cancelAnimationFrame(touchBatchRafRef.current);
      touchBatchRafRef.current = null;
    }
  }, []);

  const getLiveTimes = useCallback(() => {
    const liveMs = isPlaying ? readPlayheadMs() : currentMs;
    return {
      liveMs,
      liveChartMs: calibrationActive ? liveMs : liveMs - offsetMs,
    };
  }, [calibrationActive, currentMs, isPlaying, offsetMs, readPlayheadMs]);

  const getTouchLaneTarget = useCallback((x: number, y: number) => (
    getTouchLaneTargetFromPoint(x, y, laneFieldRef.current, activeLanes)
  ), [activeLanes]);

  const updateTouchFeedback = useCallback(() => {
    const nextActiveLaneIds = getPressedLaneFeedback(pressedCodesRef.current, activeLanes, activeSpaceLaneIdsRef.current);
    getTouchLaneIds(activeTouchesRef.current).forEach((laneId) => nextActiveLaneIds.add(laneId));
    setActiveLaneIds(nextActiveLaneIds);
    setActiveSpaceSides(getPressedSpaceSideFeedback(pressedCodesRef.current, activeTouchesRef.current));
  }, [activeLanes]);

  const updateTouchLaneState = useCallback((touch: TouchInputState, x: number, y: number, liveChartMs: number): TouchInputState => {
    const target = getTouchLaneTarget(x, y);
    if (!target) {
      return {
        ...touch,
        x,
        y,
        laneId: undefined,
        laneIndex: undefined,
        lanePressMs: undefined,
      };
    }

    const laneChanged = touch.laneId !== target.lane.id;
    return {
      ...touch,
      x,
      y,
      laneId: target.lane.id,
      laneIndex: target.index,
      lanePressMs: laneChanged ? liveChartMs : touch.lanePressMs ?? liveChartMs,
    };
  }, [getTouchLaneTarget]);

  const getTouchHoldSnapshot = useCallback((): TouchHoldInputSnapshot => ({
    activeTouches: activeTouchesRef.current,
    lastTouchReleaseMs: lastTouchReleaseMsRef.current,
    spaceGraceMs: TOUCH_SPACE_GRACE_MS,
  }), []);

  const clearInputFeedback = useCallback(() => {
    pressedCodesRef.current.clear();
    keyPressTimesRef.current.clear();
    armedHoldInputsRef.current.clear();
    activeSpaceLaneIdsRef.current = [];
    clearTouchInputs();
    setActiveLaneIds(new Set());
    setActiveSpaceSides(new Set());
  }, [clearTouchInputs]);

  const pausePlayback = useCallback((nextMs?: number) => {
    const liveMs = typeof nextMs === "number" ? nextMs : readPlayheadMs();
    stopRaf();
    playbackActiveRef.current = false;
    setIsPlaying(false);
    currentMsRef.current = liveMs;
    setCurrentMs(liveMs);
    audioRef.current?.pause();
    clearInputFeedback();
  }, [clearInputFeedback, readPlayheadMs, stopRaf]);

  const resetJudgementState = useCallback(() => {
    setJudgedIds(new Set());
    setJudgedHoldTickIds(new Set());
    setTriggeredLaneNoteIds(new Set());
    setCurrentLaneCount(getInitialLaneCount(chart));
    startedTapHoldIdsRef.current.clear();
    failedTapHoldIdsRef.current.clear();
    caughtSpaceHoldIdsRef.current.clear();
    setStats(INITIAL_STATS);
    setJudgeBursts([]);
  }, [chart]);

  const startPlaybackAt = useCallback(async (timeMs: number) => {
    const resumeMs = Math.min(playDuration, Math.max(0, timeMs));
    const token = playbackTokenRef.current + 1;
    playbackTokenRef.current = token;
    audioStartPendingRef.current = false;
    const audio = audioRef.current;
    unlockAudioForPlayback(audio, musicVolume);
    if (resumeMs <= 0) {
      resetJudgementState();
    }
    currentMsRef.current = resumeMs;
    setCurrentMs(resumeMs);
    setShowPauseMenu(false);
    if (audio) {
      audio.pause();
      audio.currentTime = Math.max(0, resumeMs - PLAY_PREROLL_MS) / 1000;
    }
    startAtRef.current = performance.now() - resumeMs;
    playbackActiveRef.current = true;
    setIsPlaying(true);
    stopRaf();
    animationRef.current = requestAnimationFrame(tick);
    if (resumeMs >= PLAY_PREROLL_MS) {
      audioStartPendingRef.current = true;
      const started = await startAudioForTimeline(resumeMs, token);
      audioStartPendingRef.current = false;
      if (!started && playbackTokenRef.current === token) {
        playbackActiveRef.current = false;
        setIsPlaying(false);
        stopRaf();
      }
    }
  }, [musicVolume, playDuration, resetJudgementState, startAudioForTimeline, stopRaf, tick]);

  const resetRun = useCallback(() => {
    playbackTokenRef.current += 1;
    audioStartPendingRef.current = false;
    stopRaf();
    playbackActiveRef.current = false;
    setIsPlaying(false);
    setShowPauseMenu(false);
    setCalibrationActive(false);
    setCalibrationSamples([]);
    currentMsRef.current = 0;
    setCurrentMs(0);
    resetJudgementState();
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
    }
    clearInputFeedback();
  }, [clearInputFeedback, resetJudgementState, stopRaf]);

  const startGame = useCallback(() => {
    resetRun();
    setPlayPhase("game");
    void startPlaybackAt(0);
  }, [resetRun, startPlaybackAt]);

  const returnToMenu = useCallback(() => {
    resetRun();
    setPlayPhase("menu");
  }, [resetRun]);

  const restartFromPause = useCallback(() => {
    resetRun();
    void startPlaybackAt(0);
  }, [resetRun, startPlaybackAt]);

  const togglePlay = useCallback(async () => {
    if (isPlaying) {
      pausePlayback();
      return;
    }
    const resumeMs = currentMsRef.current >= playDuration - 100 ? 0 : currentMsRef.current;
    await startPlaybackAt(resumeMs);
  }, [isPlaying, pausePlayback, playDuration, startPlaybackAt]);

  const openPauseMenu = useCallback(() => {
    const liveMs = readPlayheadMs();
    pausePlayback(liveMs);
    setShowPauseMenu(true);
  }, [pausePlayback, readPlayheadMs]);

  const resumeFromPause = useCallback(() => {
    void startPlaybackAt(currentMsRef.current);
  }, [startPlaybackAt]);

  useEffect(() => {
    if (!showPauseMenu) return;
    pausePlayback(currentMsRef.current);
  }, [pausePlayback, showPauseMenu]);

  useEffect(() => {
    const durationMs = calibrationActive ? calibrationDurationMs : playDuration;
    if (!isPlaying || currentMs < durationMs) return;
    stopRaf();
    setIsPlaying(false);
    playbackActiveRef.current = false;
    playbackTokenRef.current += 1;
    audioRef.current?.pause();
    if (calibrationActive) {
      setCalibrationActive(false);
    }
  }, [calibrationActive, calibrationDurationMs, currentMs, isPlaying, playDuration, stopRaf]);

  const startCalibration = useCallback(() => {
    playbackTokenRef.current += 1;
    audioStartPendingRef.current = false;
    stopRaf();
    audioRef.current?.pause();
    playbackActiveRef.current = true;
    setCalibrationActive(true);
    setCalibrationSamples([]);
    setCalibrationResultMs(null);
    setJudgedIds(new Set());
    setJudgedHoldTickIds(new Set());
    setTriggeredLaneNoteIds(new Set());
    setCurrentLaneCount(getInitialLaneCount(chart));
    setJudgeBursts([]);
    setStats(INITIAL_STATS);
    setShowPauseMenu(false);
    clearInputFeedback();
    currentMsRef.current = 0;
    setCurrentMs(0);
    startAtRef.current = performance.now();
    setIsPlaying(true);
    animationRef.current = requestAnimationFrame(tick);
  }, [chart, clearInputFeedback, stopRaf, tick]);

  useEffect(() => {
    return stopRaf;
  }, [stopRaf]);

  useEffect(() => {
    if (audioRef.current) {
      musicGainRef.current = setupMusicGainForAudio(audioRef.current, musicVolume) ?? musicGainRef.current;
      setAudioOutputVolume(audioRef.current, musicGainRef.current, musicVolume);
    }
  }, [chart.meta.audioUrl, musicVolume]);

  useEffect(() => {
    const pauseIfHidden = () => {
      if (document.visibilityState === "hidden") {
        pausePlayback(currentMsRef.current);
      }
    };
    const pauseOnBlur = () => {
      pausePlayback(currentMsRef.current);
    };
    document.addEventListener("visibilitychange", pauseIfHidden);
    window.addEventListener("blur", pauseOnBlur);
    return () => {
      document.removeEventListener("visibilitychange", pauseIfHidden);
      window.removeEventListener("blur", pauseOnBlur);
    };
  }, [pausePlayback]);

  useEffect(() => {
    stopRaf();
    playbackActiveRef.current = false;
    audioRef.current?.pause();
    if (audioRef.current) audioRef.current.currentTime = 0;
    setJudgedIds(new Set());
    setJudgedHoldTickIds(new Set());
    setTriggeredLaneNoteIds(new Set());
    setCurrentLaneCount(getInitialLaneCount(chart));
    setStats(INITIAL_STATS);
    setCurrentMs(0);
    currentMsRef.current = 0;
    setIsPlaying(false);
    setJudgeBursts([]);
    setShowPauseMenu(false);
    setCalibrationActive(false);
    setCalibrationSamples([]);
    clearInputFeedback();
  }, [chart.id, chart.initialLaneCount, chart.laneCount, clearInputFeedback, stopRaf]);

  useEffect(() => {
    if (!isPlaying || calibrationActive) return;
    const dueLaneNotes = chart.notes
      .filter((note) => isLaneNote(note) && !triggeredLaneNoteIds.has(note.id) && chartMs >= note.timeMs)
      .sort((a, b) => a.timeMs - b.timeMs);
    if (!dueLaneNotes.length) return;

    const latest = dueLaneNotes[dueLaneNotes.length - 1];
    setCurrentLaneCount(getLaneNoteTargetCount(latest, chart.laneCount));
    setTriggeredLaneNoteIds((previous) => {
      const next = new Set(previous);
      dueLaneNotes.forEach((note) => next.add(note.id));
      return next;
    });
    activeSpaceLaneIdsRef.current = [];
    setActiveLaneIds(new Set());
    setActiveSpaceSides(new Set());
  }, [calibrationActive, chart.laneCount, chart.notes, chartMs, isPlaying, triggeredLaneNoteIds]);

  useEffect(() => {
    if (!activeTouchesRef.current.size) return;
    const { liveChartMs } = getLiveTimes();
    activeTouchesRef.current.forEach((touch, pointerId) => {
      activeTouchesRef.current.set(pointerId, updateTouchLaneState(touch, touch.x, touch.y, liveChartMs));
    });
    updateTouchFeedback();
  }, [activeLanes, getLiveTimes, updateTouchFeedback, updateTouchLaneState]);

  useEffect(() => {
    if (!isPlaying) return;
    if (calibrationActive) return;
    if (autoplay) return;

    const misses = judgementWindowNotes.filter((note) => {
      if (note.type === "hold") return false;
      if (judgedIds.has(note.id) || note.timeMs >= chartMs - HIT_WINDOW_MS) return false;
      if (note.isSpace && !getSpaceProjection(note, activeLanes, chartLaneIndexById).isJudgeable) return false;
      return true;
    });
    if (!misses.length) return;

    setJudgedIds((previous) => {
      const next = new Set(previous);
      misses.forEach((note) => next.add(note.id));
      return next;
    });
    setStats((previous) => applyJudges(previous, misses.map(() => "miss"), scoreUnit));
    showJudgeBursts(misses.map((note) => ({ note, result: "miss" as const })), setJudgeBursts);
  }, [activeLanes.length, autoplay, calibrationActive, chart.lanes.length, chartLaneIndexById, chartMs, isPlaying, judgedIds, judgementWindowNotes, scoreUnit]);

  useEffect(() => {
    if (!isPlaying || !autoplay) return;
    if (calibrationActive) return;

    const dueNotes = judgementWindowNotes.filter((note) => {
      if (note.type === "hold" || judgedIds.has(note.id) || chartMs < note.timeMs) return false;
      if (note.isSpace && !getSpaceProjection(note, activeLanes, chartLaneIndexById).isJudgeable) return false;
      return true;
    });
    if (!dueNotes.length) return;

    setJudgedIds((previous) => {
      const next = new Set(previous);
      dueNotes.forEach((note) => next.add(note.id));
      return next;
    });
    const playedKeySounds = new Set<string>();
    setStats((previous) => applyJudges(previous, dueNotes.map(() => "great"), scoreUnit));
    showJudgeBursts(dueNotes.map((note) => ({ note, result: "great" as const })), setJudgeBursts);
    dueNotes.forEach((note) => {
      playHitKeySoundOnce(note, activeLanes, chartLaneIndexById, keyVolume, playedKeySounds);
    });
  }, [activeLanes, autoplay, calibrationActive, chartLaneIndexById, chartMs, isPlaying, judgedIds, judgementWindowNotes, keyVolume, scoreUnit]);

  useEffect(() => {
    if (!isPlaying) return;
    if (calibrationActive) return;

    const dueTicks: Array<{ note: Note; tickId: string; timeMs: number }> = [];
    const headMisses: Note[] = [];
    judgementWindowNotes.forEach((note) => {
      if (note.type !== "hold" || judgedIds.has(note.id)) return;
      if (note.isSpace && !getSpaceProjection(note, activeLanes, chartLaneIndexById).isJudgeable) {
        if (chartMs >= getNoteEndTimeMs(note)) {
          setJudgedIds((previous) => new Set(previous).add(note.id));
        }
        return;
      }
      if (!note.isSpace && autoplay) {
        startedTapHoldIdsRef.current.add(note.id);
      }
      if (!note.isSpace && !startedTapHoldIdsRef.current.has(note.id)) {
        if (!failedTapHoldIdsRef.current.has(note.id) && chartMs > note.timeMs + HIT_WINDOW_MS) {
          failedTapHoldIdsRef.current.add(note.id);
          headMisses.push(note);
        }
        if (!failedTapHoldIdsRef.current.has(note.id)) {
          return;
        }
      }
      getHoldDensityTimes(note).forEach((timeMs, tickIndex) => {
        const tickId = getHoldTickId(note, tickIndex);
        if (!judgedHoldTickIds.has(tickId) && chartMs >= timeMs) {
          dueTicks.push({ note, tickId, timeMs });
        }
      });
    });

    const nextTickIds = new Set(judgedHoldTickIds);
    const judgedTickResults: Array<{ note: Note; result: JudgeResult }> = [];
    const playedKeySounds = new Set<string>();
    dueTicks.forEach(({ note, tickId, timeMs }) => {
      const input = (!note.isSpace && failedTapHoldIdsRef.current.has(note.id))
        ? { isHeld: false, isEligible: false, code: undefined, pressMs: undefined }
        : autoplay
          ? { isHeld: true, isEligible: true, code: undefined, pressMs: undefined }
          : getHoldInputState(
            note,
            pressedCodesRef.current,
            activeLanes,
            chartLaneIndexById,
            keyPressTimesRef.current,
            armedHoldInputsRef.current,
            timeMs,
            chartMs,
            getTouchHoldSnapshot(),
          );
      if (!autoplay && !input.isEligible && chartMs <= timeMs + HIT_WINDOW_MS) {
        return;
      }
      nextTickIds.add(tickId);
      const result: JudgeResult = input.isEligible ? "great" : "miss";
      judgedTickResults.push({ note, result });
      if (input.isEligible && input.code && typeof input.pressMs === "number") {
        armedHoldInputsRef.current.set(input.code, input.pressMs);
      }
      if (input.isEligible) {
        if (note.isSpace) {
          caughtSpaceHoldIdsRef.current.add(note.id);
        }
        playHitKeySoundOnce(note, activeLanes, chartLaneIndexById, keyVolume, playedKeySounds);
      }
    });

    const completedHoldIds = new Set<string>();
    judgementWindowNotes.forEach((note) => {
      if (note.type !== "hold" || judgedIds.has(note.id) || chartMs < getNoteEndTimeMs(note)) return;
      if (getHoldDensityTimes(note).every((_, tickIndex) => nextTickIds.has(getHoldTickId(note, tickIndex)))) {
        completedHoldIds.add(note.id);
      }
    });

    if (dueTicks.length) {
      setJudgedHoldTickIds(nextTickIds);
    }
    if (headMisses.length) {
      showJudgeBursts(headMisses.map((note) => ({ note, result: "miss" as const })), setJudgeBursts);
    }
    if (judgedTickResults.length) {
      setStats((previous) => applyJudges(previous, judgedTickResults.map((item) => item.result), scoreUnit));
      showJudgeBursts(judgedTickResults, setJudgeBursts);
    }
    if (completedHoldIds.size) {
      setJudgedIds((previous) => {
        const next = new Set(previous);
        completedHoldIds.forEach((id) => next.add(id));
        return next;
      });
    }
  }, [activeLanes, autoplay, calibrationActive, chart.lanes.length, chartLaneIndexById, chartMs, getTouchHoldSnapshot, isPlaying, judgedHoldTickIds, judgedIds, judgementWindowNotes, keyVolume, scoreUnit]);

  useEffect(() => {
    if (!isPlaying || calibrationActive) return;
    judgementWindowNotes.forEach((note) => {
      if (note.type !== "hold" || !note.isSpace || caughtSpaceHoldIdsRef.current.has(note.id)) return;
      if (chartMs < note.timeMs || chartMs > getNoteEndTimeMs(note)) return;
      const input = autoplay
        ? { isHeld: true, isEligible: true }
        : getHoldInputState(
          note,
          pressedCodesRef.current,
          activeLanes,
          chartLaneIndexById,
          keyPressTimesRef.current,
          armedHoldInputsRef.current,
          note.timeMs,
          chartMs,
          getTouchHoldSnapshot(),
        );
      if (input.isHeld || input.isEligible) {
        caughtSpaceHoldIdsRef.current.add(note.id);
      }
    });
  }, [activeLanes, autoplay, calibrationActive, chartLaneIndexById, chartMs, getTouchHoldSnapshot, isPlaying, judgementWindowNotes]);

  const processTouchStartBatch = useCallback(() => {
    touchBatchRafRef.current = null;
    const starts = touchStartQueueRef.current;
    touchStartQueueRef.current = [];
    if (!starts.length || playPhase !== "game" || showPauseMenu) return;

    const liveMs = readPlayheadMs();
    const liveChartMs = calibrationActive ? liveMs : liveMs - offsetMs;
    setCurrentMs(liveMs);

    if (calibrationActive) {
      const touch = starts.find((item) => item.laneId === calibrationLane?.id);
      if (!touch || !calibrationLane) return;

      const nextIndex = calibrationSamples.length;
      const targetTimeMs = CALIBRATION_FIRST_TAP_MS + nextIndex * CALIBRATION_INTERVAL_MS;
      const offset = liveMs - targetTimeMs;
      if (nextIndex < CALIBRATION_TAP_COUNT && Math.abs(offset) <= CALIBRATION_HIT_WINDOW_MS) {
        const note: Note = {
          id: `calibration-${nextIndex}`,
          timeMs: targetTimeMs,
          laneId: calibrationLane.id,
          type: "tap",
        };
        const nextSamples = [...calibrationSamples, Math.round(offset)];
        setCalibrationSamples(nextSamples);
        showJudgeBurst(note, "great", setJudgeBursts);
        playKeySound(touch.laneIndex ?? Math.floor(activeLanes.length / 2), false, keyVolume);
        if (nextSamples.length >= CALIBRATION_TAP_COUNT) {
          const nextOffset = Math.round(getMedian(nextSamples));
          onOffsetChange(nextOffset);
          setCalibrationResultMs(nextOffset);
          setCalibrationActive(false);
          setIsPlaying(false);
          stopRaf();
        }
      }
      return;
    }

    const unavailableNoteIds = new Set(judgedIds);
    const consumedPointers = new Set<number>();
    const matches: Array<{ note: Note; result: JudgeResult }> = [];
    const holdStarts: Array<{ note: Note; result: JudgeResult }> = [];

    const findClosestInstantNote = (predicate: (note: Note) => boolean) => judgementWindowNotes
      .filter((note) => !unavailableNoteIds.has(note.id) && note.type !== "hold" && predicate(note))
      .map((note) => ({ note, offset: liveChartMs - note.timeMs }))
      .filter(({ offset }) => Math.abs(offset) <= HIT_WINDOW_MS)
      .sort((a, b) => Math.abs(a.offset) - Math.abs(b.offset))[0];

    const findClosestTapHoldStart = (laneId: string) => judgementWindowNotes
      .filter((note) => (
        note.type === "hold"
        && !note.isSpace
        && note.laneId === laneId
        && !startedTapHoldIdsRef.current.has(note.id)
        && !failedTapHoldIdsRef.current.has(note.id)
      ))
      .map((note) => ({ note, offset: liveChartMs - note.timeMs, result: getJudgeResult(liveChartMs - note.timeMs) as JudgeResult }))
      .filter(({ result }) => result === "great" || result === "good")
      .sort((a, b) => Math.abs(a.offset) - Math.abs(b.offset))[0];

    starts.forEach((touch) => {
      if (touch.laneId === undefined || consumedPointers.has(touch.pointerId)) return;
      const target = findClosestTapHoldStart(touch.laneId);
      if (!target) return;
      consumedPointers.add(touch.pointerId);
      startedTapHoldIdsRef.current.add(target.note.id);
      holdStarts.push({ note: target.note, result: target.result });
    });

    starts.forEach((touch) => {
      if (touch.laneId === undefined || consumedPointers.has(touch.pointerId)) return;
      const target = findClosestInstantNote((note) => !note.isSpace && note.laneId === touch.laneId);
      if (!target) return;
      consumedPointers.add(touch.pointerId);
      unavailableNoteIds.add(target.note.id);
      matches.push({ note: target.note, result: getJudgeResult(target.offset) });
    });

    const matchedSpaceLaneIds = new Set<string>();
    starts.forEach((touch) => {
      if (!touch.side || consumedPointers.has(touch.pointerId)) return;
      const target = findClosestInstantNote((note) => (
        isSpaceTapSide(note, touch.side as SpaceSide)
        && getSpaceProjection(note, activeLanes, chartLaneIndexById).isJudgeable
      ));
      if (!target) return;
      consumedPointers.add(touch.pointerId);
      unavailableNoteIds.add(target.note.id);
      getSpannedLaneIds(target.note, activeLanes, chartLaneIndexById).forEach((laneId) => matchedSpaceLaneIds.add(laneId));
      matches.push({ note: target.note, result: getJudgeResult(target.offset) });
    });

    if (!matches.length && !holdStarts.length) return;

    if (matchedSpaceLaneIds.size) {
      activeSpaceLaneIdsRef.current = [...matchedSpaceLaneIds];
      updateTouchFeedback();
    }
    if (matches.length) {
      setJudgedIds((previous) => {
        const next = new Set(previous);
        matches.forEach(({ note }) => next.add(note.id));
        return next;
      });
      setStats((previous) => applyJudges(previous, matches.map(({ result }) => result), scoreUnit));
    }
    showJudgeBursts([...holdStarts, ...matches], setJudgeBursts);
    const playedKeySounds = new Set<string>();
    [...holdStarts, ...matches].forEach(({ note }) => {
      playHitKeySoundOnce(note, activeLanes, chartLaneIndexById, keyVolume, playedKeySounds);
    });
  }, [
    activeLanes,
    calibrationActive,
    calibrationLane,
    calibrationSamples,
    chartLaneIndexById,
    isPlaying,
    judgedIds,
    judgementWindowNotes,
    keyVolume,
    offsetMs,
    onOffsetChange,
    playPhase,
    readPlayheadMs,
    scoreUnit,
    showPauseMenu,
    stopRaf,
    updateTouchFeedback,
  ]);

  const scheduleTouchStartBatch = useCallback(() => {
    if (touchBatchRafRef.current !== null) return;
    touchBatchRafRef.current = requestAnimationFrame(processTouchStartBatch);
  }, [processTouchStartBatch]);

  const handleStagePointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!isTouchPointerEvent(event) || isTouchUiTarget(event.target)) return;
    if (playPhase !== "game" || showPauseMenu) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);

    const { liveChartMs } = getLiveTimes();
    const touch = updateTouchLaneState(
      {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        startedAtMs: liveChartMs,
      },
      event.clientX,
      event.clientY,
      liveChartMs,
    );
    activeTouchesRef.current.set(event.pointerId, touch);
    lastTouchReleaseMsRef.current = null;
    if (!isPlaying) {
      setShowPauseMenu(false);
      void togglePlay();
      updateTouchFeedback();
      return;
    }
    touchStartQueueRef.current.push({
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      laneId: touch.laneId,
      laneIndex: touch.laneIndex,
      side: touch.laneId ? undefined : getTouchSpaceSide(event.clientX),
    });
    updateTouchFeedback();
    scheduleTouchStartBatch();
  }, [getLiveTimes, isPlaying, playPhase, scheduleTouchStartBatch, showPauseMenu, togglePlay, updateTouchFeedback, updateTouchLaneState]);

  const handleStagePointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!isTouchPointerEvent(event)) return;
    const touch = activeTouchesRef.current.get(event.pointerId);
    if (!touch) return;
    event.preventDefault();
    const { liveChartMs } = getLiveTimes();
    activeTouchesRef.current.set(event.pointerId, updateTouchLaneState(touch, event.clientX, event.clientY, liveChartMs));
    updateTouchFeedback();
  }, [getLiveTimes, updateTouchFeedback, updateTouchLaneState]);

  const finishStagePointer = useCallback((event: ReactPointerEvent<HTMLElement>, cancelQueuedStart = false) => {
    if (!isTouchPointerEvent(event)) return;
    const hadTouch = activeTouchesRef.current.delete(event.pointerId);
    if (cancelQueuedStart) {
      touchStartQueueRef.current = touchStartQueueRef.current.filter((touch) => touch.pointerId !== event.pointerId);
    }
    if (hadTouch && activeTouchesRef.current.size === 0) {
      lastTouchReleaseMsRef.current = getLiveTimes().liveChartMs;
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    updateTouchFeedback();
  }, [getLiveTimes, updateTouchFeedback]);

  const handleStagePointerUp = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    finishStagePointer(event);
  }, [finishStagePointer]);

  const handleStagePointerCancel = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    finishStagePointer(event, true);
  }, [finishStagePointer]);

  const handleStageLostPointerCapture = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    finishStagePointer(event, true);
  }, [finishStagePointer]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const code = normalizeKeyboardEventCode(event);
      const ignored = shouldIgnoreKey(code);
      if (playPhase !== "game") return;
      if (code === "Escape") {
        event.preventDefault();
        if (showPauseMenu) {
          resumeFromPause();
        } else {
          openPauseMenu();
        }
        return;
      }
      if (showPauseMenu) return;
      if (ignored) return;
      event.preventDefault();
      const liveMs = isPlaying ? readPlayheadMs() : currentMs;
      const liveChartMs = calibrationActive ? liveMs : liveMs - offsetMs;
      if (!event.repeat) {
        keyPressTimesRef.current.set(code, liveChartMs);
      }
      pressedCodesRef.current.add(code);

      const isSpaceKey = code === "Space";
      const spaceInputSide = getSpaceInputSideForCode(code);
      const lane = isSpaceKey ? undefined : findLaneForKey(activeLanes, code);
      if (!isSpaceKey && !spaceInputSide && !lane) return;

      updateTouchFeedback();

      if (calibrationActive) {
        if (!event.repeat && calibrationLane && lane?.id === calibrationLane.id) {
          const nextIndex = calibrationSamples.length;
          const targetTimeMs = CALIBRATION_FIRST_TAP_MS + nextIndex * CALIBRATION_INTERVAL_MS;
          const offset = liveMs - targetTimeMs;
          if (nextIndex < CALIBRATION_TAP_COUNT && Math.abs(offset) <= CALIBRATION_HIT_WINDOW_MS) {
            const note: Note = {
              id: `calibration-${nextIndex}`,
              timeMs: targetTimeMs,
              laneId: calibrationLane.id,
              type: "tap",
            };
            const nextSamples = [...calibrationSamples, Math.round(offset)];
            setCalibrationSamples(nextSamples);
            showJudgeBurst(note, "great", setJudgeBursts);
            playKeySound(lane.index, false, keyVolume);
            if (nextSamples.length >= CALIBRATION_TAP_COUNT) {
              const nextOffset = Math.round(getMedian(nextSamples));
              onOffsetChange(nextOffset);
              setCalibrationResultMs(nextOffset);
              setCalibrationActive(false);
              setIsPlaying(false);
              stopRaf();
            }
          }
        }
        return;
      }

      if (!isPlaying) {
        setShowPauseMenu(false);
        void togglePlay();
        return;
      }

      if (!event.repeat && lane) {
        const holdStartTarget = judgementWindowNotes
          .filter((note) => (
            note.type === "hold"
            && !note.isSpace
            && note.laneId === lane.id
            && !startedTapHoldIdsRef.current.has(note.id)
            && !failedTapHoldIdsRef.current.has(note.id)
          ))
          .map((note) => ({ note, offset: liveChartMs - note.timeMs, result: getJudgeResult(liveChartMs - note.timeMs) as JudgeResult }))
          .filter(({ result }) => result === "great" || result === "good")
          .sort((a, b) => Math.abs(a.offset) - Math.abs(b.offset))[0];
        if (holdStartTarget) {
          const pressMs = keyPressTimesRef.current.get(code);
          if (typeof pressMs === "number") {
            armedHoldInputsRef.current.set(code, pressMs);
          }
          startedTapHoldIdsRef.current.add(holdStartTarget.note.id);
          showJudgeBurst(holdStartTarget.note, holdStartTarget.result, setJudgeBursts);
          playHitKeySound(holdStartTarget.note, activeLanes, chartLaneIndexById, keyVolume);
          return;
        }
      }

      armHoldInputsAt(liveChartMs, code, judgementWindowNotes, activeLanes, chartLaneIndexById, armedHoldInputsRef.current, keyPressTimesRef.current);
      setCurrentMs(liveMs);
      const target = judgementWindowNotes
        .filter((note) => {
          if (judgedIds.has(note.id)) return false;
          if (note.type === "hold") return false;
          if (isSpaceKey) return false;
          return (
            (spaceInputSide && isSpaceTapSide(note, spaceInputSide) && getSpaceProjection(note, activeLanes, chartLaneIndexById).isJudgeable)
            || (!note.isSpace && note.laneId === lane?.id)
          );
        })
        .map((note) => ({ note, offset: liveChartMs - note.timeMs }))
        .filter(({ offset }) => Math.abs(offset) <= HIT_WINDOW_MS)
        .sort((a, b) => Math.abs(a.offset) - Math.abs(b.offset))[0];

      if (!target) return;

      if (isSpaceKey || spaceInputSide) {
        const spannedLaneIds = getSpannedLaneIds(target.note, activeLanes, chartLaneIndexById);
        activeSpaceLaneIdsRef.current = spannedLaneIds;
        updateTouchFeedback();
      }
      const result = getJudgeResult(target.offset);
      setJudgedIds((previous) => new Set(previous).add(target.note.id));
      setStats((previous) => applyJudge(previous, result, scoreUnit));
      showJudgeBurst(target.note, result, setJudgeBursts);
      playHitKeySound(target.note, activeLanes, chartLaneIndexById, keyVolume);
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      const code = normalizeKeyboardEventCode(event);
      if (shouldIgnoreKey(code)) return;
      pressedCodesRef.current.delete(code);
      armedHoldInputsRef.current.delete(code);
      if (code === "Space" || getSpaceInputSideForCode(code)) {
        activeSpaceLaneIdsRef.current = [];
      }
      updateTouchFeedback();
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [activeLanes, calibrationActive, calibrationLane, calibrationSamples, chart.lanes.length, chartLaneIndexById, currentMs, offsetMs, isPlaying, judgedIds, judgementWindowNotes, keyVolume, onOffsetChange, openPauseMenu, playPhase, readPlayheadMs, resumeFromPause, showPauseMenu, stopRaf, togglePlay, scoreUnit, updateTouchFeedback]);

  const approachingLaneIds = useMemo(() => {
    const next = new Set<string>();
    visiblePlayableNotes.forEach((note) => {
      if (!note.isSpace && !judgedIds.has(note.id) && note.timeMs >= chartMs && note.timeMs - chartMs <= 620) {
        next.add(note.laneId);
      }
    });
    return next;
  }, [chartMs, judgedIds, visiblePlayableNotes]);

  const approachingSpaceLaneIds = useMemo(() => {
    const next = new Set<string>();
    visiblePlayableNotes.forEach((note) => {
      if (note.isSpace && !judgedIds.has(note.id) && note.timeMs >= chartMs && note.timeMs - chartMs <= 620) {
        getSpannedLaneIds(note, activeLanes, chartLaneIndexById).forEach((laneId) => next.add(laneId));
      }
    });
    return next;
  }, [activeLanes, chartLaneIndexById, chartMs, judgedIds, visiblePlayableNotes]);
  const displayJudgedIds = calibrationActive ? calibrationHitIds : judgedIds;

  const handlePlayAudio = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setMenuStatus("正在读取音频...");
    const audioUrl = await readFileAsDataUrl(file);
    const parsedMeta = parseAudioFileName(file.name);
    const embeddedCoverUrl = await readEmbeddedArtwork(file);
    const durationMs = await readAudioDurationMs(audioUrl).catch(() => chart.meta.durationMs);
    const shouldUseFileMeta = chart.notes.length === 0;
    onChartChange({
      ...chart,
      meta: {
        ...chart.meta,
        title: shouldUseFileMeta ? parsedMeta.title : chart.meta.title,
        artist: shouldUseFileMeta ? parsedMeta.artist : chart.meta.artist,
        durationMs,
        audioUrl,
        audioFileName: file.name,
        coverUrl: embeddedCoverUrl ?? chart.meta.coverUrl,
      },
    });
    setMenuStatus(`已导入音频 ${file.name}${embeddedCoverUrl ? " · 已读取内嵌曲绘" : ""}`);
  };

  const handlePlayArtwork = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    void readFileAsDataUrl(file).then((coverUrl) => {
      onChartChange({
        ...chart,
        meta: {
          ...chart.meta,
          coverUrl,
          coverFileName: file.name,
        },
      });
      setMenuStatus(`已导入曲绘 ${file.name}`);
    });
  };

  const handlePlayChart = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as Chart;
      const result = normalizeImportedChart(parsed);
      if (result.error || !result.chart) {
        setMenuStatus(result.error ?? "导入 JSON 失败");
        return;
      }
      onChartChange({
        ...result.chart,
        meta: {
          ...result.chart.meta,
          audioUrl: result.chart.meta.audioUrl ?? chart.meta.audioUrl,
          audioFileName: result.chart.meta.audioFileName ?? chart.meta.audioFileName,
          coverUrl: result.chart.meta.coverUrl ?? chart.meta.coverUrl,
          coverFileName: result.chart.meta.coverFileName ?? chart.meta.coverFileName,
        },
      });
      setMenuStatus(`已导入谱面 ${file.name} · ${result.chart.notes.length} notes`);
    } catch {
      setMenuStatus("导入 JSON 失败");
    }
  };

  if (playPhase === "menu") {
    return (
      <section className="play-menu-screen">
        <input ref={playChartInputRef} hidden type="file" accept="application/json" onChange={handlePlayChart} />
        <div className="play-menu-hero">
          <div className="play-menu-song">
            <img src={chart.meta.coverUrl || "/cover.svg"} alt="" />
            <div>
              <h1>{chart.meta.title}</h1>
              <p>{chart.meta.artist || "Unknown Artist"}</p>
              <span>{chart.notes.length} notes · {chart.bpm} BPM · {getInitialLaneCount(chart)}K</span>
            </div>
          </div>
          <div className="play-menu-actions">
            <button onClick={() => playChartInputRef.current?.click()}>Import JSON</button>
            <button className="primary play-start-button" onClick={startGame}>Play</button>
          </div>
          <p className="play-menu-status">{menuStatus}</p>
        </div>
        <section className="play-menu-settings" aria-label="Play settings">
          <h2>Settings</h2>
          <PlaySettingsControls
            musicVolume={musicVolume}
            keyVolume={keyVolume}
            noteSpeed={noteSpeed}
            noteSize={noteSize}
            offsetMs={offsetMs}
            autoplay={autoplay}
            onMusicVolumeChange={onMusicVolumeChange}
            onKeyVolumeChange={onKeyVolumeChange}
            onNoteSpeedChange={onNoteSpeedChange}
            onNoteSizeChange={onNoteSizeChange}
            onOffsetChange={onOffsetChange}
            onAutoplayChange={onAutoplayChange}
          />
        </section>
      </section>
    );
  }

  return (
    <section className="play-screen">
      <audio
        ref={audioRef}
        src={chart.meta.audioUrl}
        onEnded={() => {
          playbackTokenRef.current += 1;
          playbackActiveRef.current = false;
          setIsPlaying(false);
        }}
      />

      <section
        className="stage"
        aria-label="Rhythm playfield"
        onPointerDown={handleStagePointerDown}
        onPointerMove={handleStagePointerMove}
        onPointerUp={handleStagePointerUp}
        onPointerCancel={handleStagePointerCancel}
        onLostPointerCapture={handleStageLostPointerCapture}
      >
        <button className="pause-toggle" onClick={openPauseMenu}>
          Pause
        </button>

        <aside className="play-song-hud">
          <div className="score-readout">
            <span>Score</span>
            <strong>{formatScore(stats.score)}</strong>
          </div>
          <div className="song-progress" aria-label="Song progress">
            <span style={{ width: `${chartDuration > 0 ? Math.min(100, Math.max(0, ((currentMs - PLAY_PREROLL_MS) / chartDuration) * 100)) : 0}%` }} />
          </div>
          <div className="song-info-row">
            <img src={chart.meta.coverUrl || "/cover.svg"} alt="" />
            <div className="play-song-text">
              <h1>{chart.meta.title}</h1>
              <p>{chart.meta.artist || "Unknown Artist"}</p>
            </div>
          </div>
        </aside>

        <div className="combo-readout">
          <strong>{stats.combo}</strong>
          <span>combo</span>
        </div>

        <div
          ref={laneFieldRef}
          className={`lane-field ${activeSpaceSides.has("left") ? "space-left-active" : ""} ${activeSpaceSides.has("right") ? "space-right-active" : ""}`}
          style={{ ...getLaneCanvasStyle(activeLanes.length, "play"), gridTemplateColumns: makeLaneTemplate(activeLanes) }}
        >
          {activeLanes.map((lane) => (
            <div key={lane.id} className={`lane ${activeLaneIds.has(lane.id) ? "lane-active" : ""} ${approachingSpaceLaneIds.has(lane.id) ? "lane-space-ready" : ""}`}>
              <div className="lane-glow" />
              {(visibleTapNotesByLane.get(lane.id) ?? []).map((note) => (
                <NoteBlock
                  key={note.id}
                  note={note}
                  currentMs={chartMs}
                  fallMs={fallMs}
                  noteSize={noteSize}
                  timingGroup={getTimingGroupForNote(note, timingGroups)}
                  zIndex={getNoteDisplayZIndex(note, noteDisplayOrder)}
                  judged={displayJudgedIds.has(note.id)}
                  locked={note.type === "hold" && startedTapHoldIdsRef.current.has(note.id) && !failedTapHoldIdsRef.current.has(note.id)}
                  dimmed={(note.type === "hold" && failedTapHoldIdsRef.current.has(note.id)) || isHoldDimmed(note, chartMs, pressedCodesRef.current, activeLanes, chartLaneIndexById, keyPressTimesRef.current, armedHoldInputsRef.current, getTouchHoldSnapshot())}
                />
              ))}
            </div>
          ))}
          {visibleSpaceNoteList.map((note) => (
            <SpaceNoteBlock
              key={note.id}
              note={note}
              currentMs={chartMs}
              fallMs={fallMs}
              timingGroup={getTimingGroupForNote(note, timingGroups)}
              zIndex={getNoteDisplayZIndex(note, noteDisplayOrder)}
              laneCount={activeLanes.length}
              projection={getSpaceProjection(note, activeLanes, chartLaneIndexById)}
              judged={judgedIds.has(note.id)}
              locked={note.type === "hold" && caughtSpaceHoldIdsRef.current.has(note.id)}
              dimmed={isHoldDimmed(note, chartMs, pressedCodesRef.current, activeLanes, chartLaneIndexById, keyPressTimesRef.current, armedHoldInputsRef.current, getTouchHoldSnapshot())}
            />
          ))}
          {visibleLaneEventNotes.map((note) => (
            <LaneEventBlock
              key={note.id}
              note={note}
              currentMs={chartMs}
              fallMs={fallMs}
              timingGroup={getTimingGroupForNote(note, timingGroups)}
              zIndex={getNoteDisplayZIndex(note, noteDisplayOrder)}
              laneCount={activeLanes.length}
              maxLaneCount={chart.laneCount}
            />
          ))}
          {judgeBursts.map((burst) => (
            (() => {
              const projection = getBurstProjection(burst, activeLanes, chartLaneIndexById);
              return (
                <Fragment key={burst.id}>
                  <JudgeHitEffect
                    burst={burst}
                    laneCount={activeLanes.length}
                    startIndex={projection.startIndex}
                    span={projection.span}
                  />
                  <JudgeBurstLabel
                    burst={burst}
                    laneCount={activeLanes.length}
                    startIndex={projection.startIndex}
                    span={projection.span}
                  />
                </Fragment>
              );
            })()
          ))}
          {judgeBursts
            .filter((burst) => burst.spaceSide === "left" || burst.spaceSide === "right")
            .map((burst) => (
              <span key={`${burst.id}-side`} className={`side-hit-flash ${burst.spaceSide === "left" ? "left" : "right"}`} />
            ))}
          <div className="judge-line" />
        </div>
        <KeyboardStrip
          segments={keyboardSegments}
          laneCount={activeLanes.length}
          activeLaneIds={new Set([...activeLaneIds, ...approachingLaneIds])}
          spaceLaneIds={approachingSpaceLaneIds}
        />
        {showPauseMenu ? (
          <div className="pause-overlay" role="dialog" aria-label="Pause menu">
            <button className="primary" onClick={resumeFromPause}>Resume</button>
            <button onClick={restartFromPause}>Restart</button>
            <button onClick={returnToMenu}>Menu</button>
          </div>
        ) : null}
      </section>

    </section>
  );
}

function EditorView({
  chart,
  onChartChange,
  musicVolume,
  keyVolume,
  noteSize,
  editorSpeed,
  snapDivision,
  holdDensity,
  onMusicVolumeChange,
  onKeyVolumeChange,
  onEditorSpeedChange,
  onSnapDivisionChange,
  onHoldDensityChange,
}: {
  chart: Chart;
  onChartChange: (chart: Chart) => void;
  musicVolume: number;
  keyVolume: number;
  noteSize: number;
  editorSpeed: number;
  snapDivision: number;
  holdDensity: number;
  onMusicVolumeChange: (volume: number) => void;
  onKeyVolumeChange: (volume: number) => void;
  onEditorSpeedChange: (speed: number) => void;
  onSnapDivisionChange: (division: number) => void;
  onHoldDensityChange: (density: number) => void;
}) {
  const [bpm, setBpm] = useState(chart.bpm);
  const [bpmInput, setBpmInput] = useState(String(chart.bpm));
  const [laneCount, setLaneCount] = useState(chart.laneCount);
  const [initialLaneCount, setInitialLaneCount] = useState(getInitialLaneCount(chart));
  const [laneEventTargetCount, setLaneEventTargetCount] = useState(getInitialLaneCount(chart));
  const [analysisLabel, setAnalysisLabel] = useState("等待导入音乐，或直接在竖向制谱器上手工落音");
  const [editTimeMs, setEditTimeMs] = useState(0);
  const [spaceSpan, setSpaceSpan] = useState(2);
  const [placementMode, setPlacementMode] = useState<PlacementMode>("select");
  const [holdDurationMs, setHoldDurationMs] = useState(DEFAULT_HOLD_DURATION_MS);
  const [holdDensityPosition, setHoldDensityPosition] = useState<HoldDensityPosition>(DEFAULT_HOLD_DENSITY_POSITION);
  const [activeTimingGroupId, setActiveTimingGroupId] = useState(DEFAULT_TIMING_GROUP_ID);
  const [editingTimingGroupId, setEditingTimingGroupId] = useState(DEFAULT_TIMING_GROUP_ID);
  const [selectedNoteIds, setSelectedNoteIds] = useState<Set<string>>(() => new Set());
  const [selectionRange, setSelectionRange] = useState<SelectionRange | null>(null);
  const [isMovingSelection, setIsMovingSelection] = useState(false);
  const [selectionMovePreviewMs, setSelectionMovePreviewMs] = useState<number | null>(null);
  const [selectionMoveLaneDelta, setSelectionMoveLaneDelta] = useState(0);
  const [selectionStartInput, setSelectionStartInput] = useState("0");
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [editorPreviewLaneCount, setEditorPreviewLaneCount] = useState(getInitialLaneCount(chart));
  const [editorJudgeBursts, setEditorJudgeBursts] = useState<JudgeBurst[]>([]);
  const audioInputRef = useRef<HTMLInputElement | null>(null);
  const artworkInputRef = useRef<HTMLInputElement | null>(null);
  const chartInputRef = useRef<HTMLInputElement | null>(null);
  const packageInputRef = useRef<HTMLInputElement | null>(null);
  const chartFileHandleRef = useRef<WritableFileHandle | null>(null);
  const packageDirectoryHandleRef = useRef<DirectoryHandle | null>(null);
  const packageObjectUrlsRef = useRef<string[]>([]);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const previewMusicGainRef = useRef<GainNode | null>(null);
  const previewRafRef = useRef<number | null>(null);
  const previewSoundedIdsRef = useRef<Set<string>>(new Set());
  const previewScheduledKeySoundIdsRef = useRef<Set<string>>(new Set());
  const lastPreviewMsRef = useRef(0);

  useEffect(() => {
    setBpm(chart.bpm);
    setBpmInput(String(chart.bpm));
    setLaneCount(chart.laneCount);
    setInitialLaneCount(getInitialLaneCount(chart));
    setLaneEventTargetCount((previous) => Math.min(chart.laneCount, clampLaneCount(previous)));
    setEditorPreviewLaneCount(getInitialLaneCount(chart));
    setEditTimeMs((previous) => Math.min(previous, chart.meta.durationMs));
    setSpaceSpan((previous) => clampSpaceSpan(previous));
    setSelectedNoteIds((previous) => new Set([...previous].filter((id) => chart.notes.some((note) => note.id === id))));
    const groupIds = new Set(getTimingGroups(chart).map((group) => group.id));
    setActiveTimingGroupId((previous) => groupIds.has(previous) ? previous : DEFAULT_TIMING_GROUP_ID);
    setEditingTimingGroupId((previous) => groupIds.has(previous) ? previous : DEFAULT_TIMING_GROUP_ID);
  }, [chart.bpm, chart.initialLaneCount, chart.laneCount, chart.lanes, chart.meta.durationMs, chart.timingGroups, chart.notes]);

  const snapMs = useMemo(() => getSnapMs(bpm, snapDivision), [bpm, snapDivision]);
  const editorFallMs = BASE_FALL_MS / editorSpeed;
  const timingGroups = useMemo(() => getTimingGroups(chart), [chart]);
  const selectedTimingGroupId = selectedNotesTimingGroupId(chart.notes, selectedNoteIds);
  const editingTimingGroup = getTimingGroupById(timingGroups, editingTimingGroupId);

  const setSnappedEditTime = (timeMs: number) => {
    const next = snapTime(timeMs, snapMs, chart.meta.durationMs);
    setEditTimeMs(next);
    if (previewAudioRef.current) {
      previewAudioRef.current.currentTime = next / 1000;
    }
  };

  const stopPreview = useCallback(() => {
    if (previewRafRef.current !== null) {
      cancelAnimationFrame(previewRafRef.current);
      previewRafRef.current = null;
    }
    previewAudioRef.current?.pause();
    setIsPreviewing(false);
  }, []);

  const tickPreview = useCallback(() => {
    const audio = previewAudioRef.current;
    if (!audio || audio.paused || audio.ended) {
      setIsPreviewing(false);
      previewRafRef.current = null;
      return;
    }

    const currentPreviewMs = Math.min(chart.meta.durationMs, Math.max(0, audio.currentTime * 1000));
    const previousPreviewMs = lastPreviewMsRef.current;
    if (currentPreviewMs < previousPreviewMs) {
      previewSoundedIdsRef.current.clear();
      previewScheduledKeySoundIdsRef.current.clear();
    }
    const nextPreviewLaneCount = getLaneCountAtTime(chart, currentPreviewMs);
    const previewLanes = getActiveLaneSlice(chart.lanes, nextPreviewLaneCount);
    const previewLaneIndexById = new Map(chart.lanes.map((lane, index) => [lane.id, index]));
    const previewNotes = chart.notes.filter((note) => !isLaneNote(note) && isNoteVisibleOnLanes(note, previewLanes));
    scheduleChartKeySounds(
      previewNotes,
      previewLanes,
      previewLaneIndexById,
      currentPreviewMs,
      0,
      keyVolume,
      previewScheduledKeySoundIdsRef.current,
    );
    previewNotes
      .filter((note) => !isLaneNote(note) && note.timeMs > previousPreviewMs && note.timeMs <= currentPreviewMs + 24 && !previewSoundedIdsRef.current.has(note.id))
      .forEach((note) => {
        previewSoundedIdsRef.current.add(note.id);
        showJudgeBurst(note, "great", setEditorJudgeBursts);
      });

    lastPreviewMsRef.current = currentPreviewMs;
    setEditorPreviewLaneCount(nextPreviewLaneCount);
    setEditTimeMs(currentPreviewMs);
    previewRafRef.current = requestAnimationFrame(tickPreview);
  }, [chart.bpm, chart.lanes, chart.meta.durationMs, chart.notes, keyVolume, snapMs]);

  const togglePreview = async () => {
    const audio = previewAudioRef.current;
    if (!audio) return;

    if (isPreviewing) {
      stopPreview();
      return;
    }

    audio.currentTime = Math.min(chart.meta.durationMs, Math.max(0, editTimeMs)) / 1000;
    lastPreviewMsRef.current = editTimeMs;
    setEditorPreviewLaneCount(getLaneCountAtTime(chart, editTimeMs));
    previewSoundedIdsRef.current.clear();
    previewScheduledKeySoundIdsRef.current.clear();
    unlockAudioForPlayback(audio, musicVolume);
    await audio.play().catch(() => undefined);
    setIsPreviewing(!audio.paused);
    if (!audio.paused) {
      previewRafRef.current = requestAnimationFrame(tickPreview);
    }
  };

  const seekPreview = (timeMs: number) => {
    const next = Math.min(chart.meta.durationMs, Math.max(0, timeMs));
    setEditTimeMs(next);
    setEditorPreviewLaneCount(getLaneCountAtTime(chart, next));
    lastPreviewMsRef.current = next;
    previewSoundedIdsRef.current.clear();
    previewScheduledKeySoundIdsRef.current.clear();
    if (previewAudioRef.current) {
      previewAudioRef.current.currentTime = next / 1000;
    }
  };

  useEffect(() => stopPreview, [stopPreview]);

  useEffect(() => {
    if (previewAudioRef.current) {
      previewMusicGainRef.current = setupMusicGainForAudio(previewAudioRef.current, musicVolume) ?? previewMusicGainRef.current;
      setAudioOutputVolume(previewAudioRef.current, previewMusicGainRef.current, musicVolume);
    }
  }, [chart.meta.audioUrl, musicVolume]);

  useEffect(() => {
    stopPreview();
    if (previewAudioRef.current) previewAudioRef.current.currentTime = 0;
    lastPreviewMsRef.current = 0;
    previewSoundedIdsRef.current.clear();
    previewScheduledKeySoundIdsRef.current.clear();
    setEditTimeMs(0);
    setEditorPreviewLaneCount(getInitialLaneCount(chart));
    setEditorJudgeBursts([]);
  }, [chart.id, stopPreview]);

  useEffect(() => () => {
    packageObjectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    packageObjectUrlsRef.current = [];
  }, []);

  const handleAudio = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    packageDirectoryHandleRef.current = null;
    chartFileHandleRef.current = null;
    const audioUrl = await readFileAsDataUrl(file);
    const parsedMeta = parseAudioFileName(file.name);
    setAnalysisLabel("正在读取音频...");
    const embeddedCoverUrl = await readEmbeddedArtwork(file);
    try {
      const durationMs = await readAudioDurationMs(audioUrl);
      setAnalysisLabel(`已导入音频 · 使用当前 BPM ${bpm} · ${embeddedCoverUrl ? "已读取内嵌曲绘" : "空白手工谱面"}`);
      setEditTimeMs(0);
      onChartChange(createManualChart({
        bpm,
        durationMs,
        laneCount,
        initialLaneCount,
        title: parsedMeta.title,
        artist: parsedMeta.artist,
        audioUrl,
        audioFileName: file.name,
        coverUrl: embeddedCoverUrl ?? chart.meta.coverUrl,
      }));
    } catch {
      setAnalysisLabel("音频时长读取失败，已使用当前 BPM 创建空白手工谱面");
      setEditTimeMs(0);
      onChartChange(createManualChart({
        bpm,
        durationMs: chart.meta.durationMs,
        laneCount,
        initialLaneCount,
        title: parsedMeta.title,
        artist: parsedMeta.artist,
        audioUrl,
        audioFileName: file.name,
        coverUrl: embeddedCoverUrl ?? chart.meta.coverUrl,
      }));
    }
  };

  const handleArtwork = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    void readFileAsDataUrl(file).then((coverUrl) => {
      onChartChange({
        ...chart,
        meta: {
          ...chart.meta,
          coverUrl,
          coverFileName: file.name,
        },
      });
    });
  };

  const updateGrid = (nextBpm: number, nextLaneCount = laneCount) => {
    const safeBpm = sanitizeBpm(nextBpm);
    const safeLaneCount = clampLaneCount(nextLaneCount);
    const safeInitialLaneCount = Math.min(safeLaneCount, clampLaneCount(initialLaneCount));
    setBpm(safeBpm);
    setBpmInput(String(safeBpm));
    setLaneCount(safeLaneCount);
    setInitialLaneCount(safeInitialLaneCount);
    setLaneEventTargetCount((previous) => Math.min(safeLaneCount, clampLaneCount(previous)));
    const nextChart = rebuildChartGrid(chart, safeBpm, safeLaneCount);
    onChartChange({
      ...nextChart,
      initialLaneCount: safeInitialLaneCount,
      notes: nextChart.notes.map((note) => isLaneNote(note)
        ? { ...note, targetLaneCount: Math.min(safeLaneCount, getLaneNoteTargetCount(note, safeLaneCount)) }
        : note),
    });
  };

  const updateInitialLaneCount = (nextLaneCount: number) => {
    const safeLaneCount = Math.min(laneCount, clampLaneCount(nextLaneCount));
    setInitialLaneCount(safeLaneCount);
    onChartChange({ ...chart, initialLaneCount: safeLaneCount });
  };

  const commitBpmInput = () => {
    const nextBpm = Number(bpmInput);
    if (!Number.isFinite(nextBpm)) {
      setBpmInput(String(bpm));
      return;
    }
    updateGrid(nextBpm);
  };

  const selectedNotes = useMemo(
    () => chart.notes.filter((note) => selectedNoteIds.has(note.id)),
    [chart.notes, selectedNoteIds],
  );
  const selectionHeadTimeMs = selectedNotes.length ? Math.min(...selectedNotes.map((note) => note.timeMs)) : undefined;
  const displayedSelectionStartMs = Math.round(selectionMovePreviewMs ?? selectionHeadTimeMs ?? editTimeMs);
  const selectedHasSpace = selectedNotes.some((note) => note.isSpace);
  const selectedHasHold = selectedNotes.some((note) => note.type === "hold");
  const selectedHasSpaceHold = selectedNotes.some((note) => note.isSpace && note.type === "hold");
  const selectedHasLane = selectedNotes.some((note) => isLaneNote(note));

  useEffect(() => {
    setSelectionStartInput(String(displayedSelectionStartMs));
  }, [displayedSelectionStartMs]);

  useEffect(() => {
    if (!selectedNoteIds.size) {
      setIsMovingSelection(false);
      setSelectionMovePreviewMs(null);
      setSelectionMoveLaneDelta(0);
    }
  }, [selectedNoteIds]);

  useEffect(() => {
    const firstSelected = selectedNotes[0];
    if (!firstSelected) return;
    const firstSpace = selectedNotes.find((note) => note.isSpace);
    const firstHold = selectedNotes.find((note) => note.type === "hold");
    const firstSpaceHold = selectedNotes.find((note) => note.isSpace && note.type === "hold");
    if (firstSpace) {
      setSpaceSpan(clampSpaceSpan(firstSpace.span ?? spaceSpan));
    }
    if (firstHold) {
      onHoldDensityChange(clampHoldDensity(firstHold.holdDensity ?? holdDensity));
      setHoldDurationMs(clampHoldDurationMs(firstHold.durationMs ?? holdDurationMs));
      setHoldDensityPosition(firstSpaceHold?.holdDensityPosition ?? DEFAULT_HOLD_DENSITY_POSITION);
    }
    const firstLane = selectedNotes.find((note) => isLaneNote(note));
    if (firstLane) {
      setLaneEventTargetCount(getLaneNoteTargetCount(firstLane, laneCount));
    }
  }, [selectedNotes]);

  const updateSelectedNotes = (mutate: (note: Note) => Note) => {
    if (!selectedNoteIds.size) return;
    onChartChange({
      ...chart,
      notes: chart.notes.map((note) => selectedNoteIds.has(note.id) ? mutate(note) : note),
    });
  };

  const updateSelectedSpaceSpan = (nextSpan: number) => {
    const safeSpan = clampSpaceSpan(nextSpan);
    setSpaceSpan(safeSpan);
    updateSelectedNotes((note) => note.isSpace ? { ...note, span: safeSpan } : note);
  };

  const updateSelectedHoldDensity = (nextDensity: number) => {
    const safeDensity = clampHoldDensity(nextDensity);
    onHoldDensityChange(safeDensity);
    updateSelectedNotes((note) => note.type === "hold" ? { ...note, holdDensity: safeDensity } : note);
  };

  const updateSelectedHoldDensityPosition = (nextPosition: HoldDensityPosition) => {
    setHoldDensityPosition(nextPosition);
    updateSelectedNotes((note) => note.type === "hold" && note.isSpace ? { ...note, holdDensityPosition: nextPosition } : note);
  };

  const updateSelectedHoldDuration = (nextDurationMs: number) => {
    const safeDurationMs = clampHoldDurationMs(nextDurationMs);
    setHoldDurationMs(safeDurationMs);
    updateSelectedNotes((note) => note.type === "hold" ? { ...note, durationMs: safeDurationMs } : note);
  };

  const updateSelectedLaneTargetCount = (nextLaneCount: number) => {
    const safeLaneCount = Math.min(laneCount, clampLaneCount(nextLaneCount));
    setLaneEventTargetCount(safeLaneCount);
    updateSelectedNotes((note) => isLaneNote(note) ? { ...note, targetLaneCount: safeLaneCount } : note);
  };

  const updateSelectedTimingGroup = (nextGroupId: string) => {
    if (!timingGroups.some((group) => group.id === nextGroupId)) return;
    updateSelectedNotes((note) => ({ ...note, timingGroupId: nextGroupId }));
  };

  const commitTimingGroups = (groups: TimingGroup[], nextNotes = chart.notes) => {
    const nextGroups = keepEditableTimingGroups(groups);
    const validIds = new Set(nextGroups.map((group) => group.id));
    const normalizedNotes = nextNotes.map((note) => ({
      ...note,
      timingGroupId: validIds.has(note.timingGroupId ?? "") ? note.timingGroupId : DEFAULT_TIMING_GROUP_ID,
    }));
    onChartChange({
      ...chart,
      timingGroups: nextGroups,
      notes: normalizedNotes,
    });
  };

  const addTimingGroup = () => {
    const id = `group-${Date.now()}`;
    const nextGroup: TimingGroup = { id, name: `Group ${timingGroups.length + 1}`, events: [] };
    commitTimingGroups([...timingGroups, nextGroup]);
    setActiveTimingGroupId(id);
    setEditingTimingGroupId(id);
  };

  const renameTimingGroup = (groupId: string, name: string) => {
    commitTimingGroups(timingGroups.map((group) => group.id === groupId ? { ...group, name } : group));
  };

  const deleteTimingGroup = (groupId: string) => {
    if (groupId === DEFAULT_TIMING_GROUP_ID) return;
    const nextGroups = timingGroups.filter((group) => group.id !== groupId);
    const nextNotes = chart.notes.map((note) => note.timingGroupId === groupId ? { ...note, timingGroupId: DEFAULT_TIMING_GROUP_ID } : note);
    commitTimingGroups(nextGroups, nextNotes);
    setActiveTimingGroupId(DEFAULT_TIMING_GROUP_ID);
    setEditingTimingGroupId(DEFAULT_TIMING_GROUP_ID);
  };

  const addTimingEvent = (groupId: string, type: TimingEventType) => {
    const baseEvent: TimingEvent = {
      id: `timing-event-${Date.now()}`,
      type,
      timeMs: Math.round(editTimeMs),
      multiplier: type === "speed" ? 1.5 : undefined,
      durationMs: type === "freeze" ? 500 : undefined,
      opacity: type === "opacity" ? 0.5 : undefined,
      transitionMs: type === "opacity" ? 200 : undefined,
    };
    commitTimingGroups(timingGroups.map((group) => group.id === groupId
      ? { ...group, events: [...group.events, baseEvent].sort((a, b) => a.timeMs - b.timeMs) }
      : group));
  };

  const updateTimingEvent = (groupId: string, eventId: string, patch: Partial<TimingEvent>) => {
    commitTimingGroups(timingGroups.map((group) => group.id === groupId
      ? {
        ...group,
        events: group.events
          .map((event) => event.id === eventId ? { ...event, ...patch } : event)
          .sort((a, b) => a.timeMs - b.timeMs),
      }
      : group));
  };

  const deleteTimingEvent = (groupId: string, eventId: string) => {
    commitTimingGroups(timingGroups.map((group) => group.id === groupId
      ? { ...group, events: group.events.filter((event) => event.id !== eventId) }
      : group));
  };

  const deleteSelection = () => {
    if (!selectedNoteIds.size) return;
    onChartChange({ ...chart, notes: chart.notes.filter((note) => !selectedNoteIds.has(note.id)) });
    setSelectedNoteIds(new Set());
    setSelectionRange(null);
    setPlacementMode("select");
  };

  const copySelection = () => {
    if (!selectedNotes.length || !selectionRange) return;
    const startMs = Math.min(selectionRange.startMs, selectionRange.endMs);
    const endMs = Math.max(selectionRange.startMs, selectionRange.endMs);
    const offsetMs = Math.max(snapMs, endMs - startMs);
    const copied = selectedNotes
      .map((note) => ({
        ...note,
        id: `copy-${Date.now()}-${note.id}`,
        timeMs: snapTime(note.timeMs + offsetMs, snapMs, chart.meta.durationMs),
      }))
      .filter((note) => note.timeMs < chart.meta.durationMs);
    if (!copied.length) return;
    onChartChange({
      ...chart,
      notes: [...chart.notes, ...copied],
    });
    setSelectedNoteIds(new Set(copied.map((note) => note.id)));
    setSelectionRange({ startMs: startMs + offsetMs, endMs: endMs + offsetMs });
  };

  const mirrorSelection = () => {
    if (!selectedNoteIds.size) return;
    onChartChange({
      ...chart,
      notes: chart.notes.map((note) => selectedNoteIds.has(note.id) ? mirrorNote(note, chart.lanes) : note),
    });
  };

  const splitSelectedSpaceHolds = () => {
    const splitTargets = selectedNotes.filter((note) => note.isSpace && note.type === "hold");
    if (!splitTargets.length) return;
    const splitTargetIds = new Set(splitTargets.map((note) => note.id));
    const created: Note[] = [];
    splitTargets.forEach((note) => {
      const densityTimes = getHoldDensityTimes(note);
      const segmentDurationMs = clampHoldDurationMs(Math.min(Math.max(1, snapMs), Math.max(1, (note.durationMs ?? DEFAULT_HOLD_DURATION_MS) / (densityTimes.length + 1))));
      densityTimes.forEach((timeMs, index) => {
        created.push({
          ...note,
          id: `split-${Date.now()}-${note.id}-${index}`,
          timeMs: snapTime(timeMs - segmentDurationMs / 2, snapMs, chart.meta.durationMs),
          durationMs: segmentDurationMs,
          holdDensity: 1,
          holdDensityPosition: "middle",
        });
      });
    });
    onChartChange({
      ...chart,
      notes: [
        ...chart.notes.filter((note) => !splitTargetIds.has(note.id)),
        ...created,
      ],
    });
    setSelectedNoteIds(new Set(created.map((note) => note.id)));
    if (created.length) {
      setSelectionRange({
        startMs: Math.min(...created.map((note) => note.timeMs)),
        endMs: Math.max(...created.map((note) => getNoteEndTimeMs(note))),
      });
    }
  };

  const moveSelectionTo = (nextStartMs: number, laneDelta = 0) => {
    if (!selectedNotes.length || selectionHeadTimeMs === undefined) return;
    const safeStartMs = snapTime(nextStartMs, snapMs, chart.meta.durationMs);
    const deltaMs = safeStartMs - selectionHeadTimeMs;
    const laneIndexById = new Map(chart.lanes.map((lane, index) => [lane.id, index]));
    onChartChange({
      ...chart,
      notes: chart.notes.map((note) => selectedNoteIds.has(note.id)
        ? shiftNoteLane({ ...note, timeMs: snapTime(note.timeMs + deltaMs, snapMs, chart.meta.durationMs) }, chart.lanes, laneIndexById, laneDelta)
        : note),
    });
    if (selectionRange) {
      setSelectionRange({
        startMs: snapTime(selectionRange.startMs + deltaMs, snapMs, chart.meta.durationMs),
        endMs: snapTime(selectionRange.endMs + deltaMs, snapMs, chart.meta.durationMs),
      });
    }
    setSelectionMovePreviewMs(null);
    setSelectionMoveLaneDelta(0);
    setIsMovingSelection(false);
  };

  const commitSelectionStartInput = () => {
    const nextStartMs = Number(selectionStartInput);
    if (!Number.isFinite(nextStartMs)) {
      setSelectionStartInput(String(displayedSelectionStartMs));
      return;
    }
    moveSelectionTo(nextStartMs);
  };

  const toggleManualNote = (laneId: string, timeMs = editTimeMs, isSpace = false, anchorLaneIndex?: number, isHold = false, durationOverrideMs?: number, spaceSide?: SpaceSide) => {
    const laneIndex = chart.lanes.findIndex((lane) => lane.id === laneId);
    const safeLaneIndex = Math.max(0, laneIndex);
    const safeSpan = isSpace ? clampSpaceSpan(spaceSpan) : 1;
    const safeAnchorLaneIndex = isSpace ? anchorLaneIndex ?? safeLaneIndex : undefined;
    const safeHoldDurationMs = isHold ? clampHoldDurationMs(durationOverrideMs ?? holdDurationMs) : undefined;
    const safeHoldDensity = isHold ? clampHoldDensity(holdDensity) : undefined;
    const safeTimeMs = snapTime(timeMs, snapMs, chart.meta.durationMs);
    const safeSpaceSide = isSpace && !isHold ? spaceSide : undefined;
    const toleranceMs = Math.max(12, snapMs * 0.45);
    const existing = chart.notes.find((note) => {
      if (
        note.type !== (isHold ? "hold" : "tap")
        || Boolean(note.isSpace) !== isSpace
        || Math.abs(note.timeMs - safeTimeMs) > toleranceMs
      ) {
        return false;
      }
      return (isSpace || note.laneId === laneId)
        && (!isSpace || getNoteAnchorIndex(note, undefined) === safeAnchorLaneIndex)
        && (!isSpace || isHold || note.spaceSide === safeSpaceSide);
    });

    const notes = existing
      ? chart.notes.filter((note) => note.id !== existing.id)
      : [
        ...chart.notes,
        {
          id: `manual-note-${Date.now()}-${Math.round(safeTimeMs)}-${laneId}`,
          timeMs: safeTimeMs,
          laneId,
          type: isHold ? "hold" as const : "tap" as const,
          isSpace,
          spaceSide: safeSpaceSide,
          span: safeSpan,
          anchorLaneIndex: safeAnchorLaneIndex,
          timingGroupId: activeTimingGroupId,
          durationMs: safeHoldDurationMs,
          holdDensity: safeHoldDensity,
          holdDensityPosition: isHold && isSpace ? holdDensityPosition : undefined,
        },
      ];

    if (safeHoldDurationMs) {
      setHoldDurationMs(safeHoldDurationMs);
    }
    if (!existing) {
      playKeySound(safeLaneIndex, isSpace, keyVolume);
    }
    setSelectedNoteIds(new Set());
    setSelectionRange(null);
    onChartChange({ ...chart, notes });
  };

  const toggleLaneNote = (timeMs = editTimeMs) => {
    const safeTimeMs = snapTime(timeMs, snapMs, chart.meta.durationMs);
    const safeTargetCount = Math.min(laneCount, clampLaneCount(laneEventTargetCount));
    const toleranceMs = Math.max(12, snapMs * 0.45);
    const existing = chart.notes.find((note) => isLaneNote(note) && Math.abs(note.timeMs - safeTimeMs) <= toleranceMs);
    const centerLane = chart.lanes[Math.floor(chart.lanes.length / 2)] ?? chart.lanes[0];
    const notes = existing
      ? chart.notes.filter((note) => note.id !== existing.id)
      : [
        ...chart.notes,
        {
          id: `lane-note-${Date.now()}-${Math.round(safeTimeMs)}`,
          timeMs: safeTimeMs,
          laneId: centerLane?.id ?? "lane-lane",
          type: "lane" as const,
          targetLaneCount: safeTargetCount,
          timingGroupId: activeTimingGroupId,
        },
      ];

    setSelectedNoteIds(new Set());
    setSelectionRange(null);
    onChartChange({ ...chart, notes });
  };

  const removeLastNote = () => {
    onChartChange({ ...chart, notes: chart.notes.slice(0, -1) });
  };

  const clearChart = () => {
    onChartChange({ ...chart, notes: [] });
    setSelectedNoteIds(new Set());
    setSelectionRange(null);
    setAnalysisLabel("已清空谱面，可以重新手工铺谱");
  };

  const wheelSeekEditor = (deltaY: number) => {
    const next = snapTime(editTimeMs - deltaY * 4, snapMs, chart.meta.durationMs);
    seekPreview(next);
  };

  const saveChart = () => {
    const exportableChart = prepareChartForExport(chart);
    const fileName = `${sanitizeFileName(chart.meta.title || "chart")}.json`;
    const json = JSON.stringify(exportableChart, null, 2);
    const handle = chartFileHandleRef.current;

    const packageDirectory = packageDirectoryHandleRef.current;
    const saveTask = handle
      ? writeJsonToHandle(handle, json).then(() => ({ method: "overwrite" as const, handle }))
      : packageDirectory
        ? packageDirectory.getFileHandle(fileName, { create: true })
          .then((nextHandle) => writeJsonToHandle(nextHandle, json).then(() => ({ method: "package" as const, handle: nextHandle })))
      : saveJsonFile(json, fileName);

    void saveTask.then((result) => {
      if (result.handle) {
        chartFileHandleRef.current = result.handle;
      }
      setAnalysisLabel(result.method === "overwrite"
        ? `已更新 ${result.handle?.name ?? fileName} · ${exportableChart.notes.length} notes`
        : result.method === "package"
          ? `已写入包内 ${result.handle?.name ?? fileName} · ${exportableChart.notes.length} notes`
        : result.method === "picker"
          ? `已保存 ${fileName} · ${exportableChart.notes.length} notes`
          : `已触发下载 ${fileName} · ${exportableChart.notes.length} notes`);
    }).catch((error) => {
      if (error instanceof DOMException && error.name === "AbortError") {
        setAnalysisLabel("已取消保存 JSON");
        return;
      }
      void saveJsonFile(json, fileName).then((result) => {
        if (result.handle) {
          chartFileHandleRef.current = result.handle;
        }
        setAnalysisLabel(result.method === "picker"
          ? `已保存 ${fileName} · ${exportableChart.notes.length} notes`
          : `已触发下载 ${fileName} · ${exportableChart.notes.length} notes`);
      });
    });
  };

  const importChart = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    packageDirectoryHandleRef.current = null;
    await loadChartJson(await file.text(), undefined);
    event.target.value = "";
  };

  const importChartFromPicker = async () => {
    const openPicker = (window as Window & { showOpenFilePicker?: FileOpenPicker }).showOpenFilePicker;
    if (!openPicker) {
      chartInputRef.current?.click();
      return;
    }

    try {
      const [handle] = await openPicker({
        multiple: false,
        types: [{
          description: "Chart JSON",
          accept: { "application/json": [".json"] },
        }],
      });
      const file = await handle.getFile();
      packageDirectoryHandleRef.current = null;
      await loadChartJson(await file.text(), handle);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setAnalysisLabel("导入 JSON 失败");
    }
  };

  const importPackageFromPicker = async () => {
    const directoryPicker = (window as Window & { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;
    if (!directoryPicker) {
      packageInputRef.current?.click();
      return;
    }

    try {
      const directoryHandle = await directoryPicker({ mode: "readwrite" });
      await loadPackageDirectory(directoryHandle);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      console.warn("Package directory picker failed, falling back to file input.", error);
      packageInputRef.current?.click();
    }
  };

  const importPackageFromInput = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])];
    event.target.value = "";
    if (!files.length) return;
    await loadPackageFiles(files.map((file) => ({ name: file.name, file, handle: undefined })));
  };

  const loadPackageDirectory = async (directoryHandle: DirectoryHandle) => {
    const files = await readDirectoryFiles(directoryHandle);
    await loadPackageFiles(files, directoryHandle);
  };

  const loadPackageFiles = async (files: PackageFileEntry[], directoryHandle?: DirectoryHandle) => {
    const chartEntry = pickChartEntry(files);
    const parsedPackageChart = chartEntry ? JSON.parse(await chartEntry.file.text()) as Chart : undefined;
    const audioEntry = pickAudioEntry(files, parsedPackageChart?.meta.audioFileName);
    const artworkEntry = pickArtworkEntry(files, parsedPackageChart?.meta.coverFileName);

    if (!audioEntry && !chartEntry) {
      setAnalysisLabel(`导入失败：未找到音频或谱面 JSON · 已看到 ${files.length} 个文件`);
      return;
    }

    packageObjectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    packageObjectUrlsRef.current = [];
    packageDirectoryHandleRef.current = directoryHandle ?? null;
    chartFileHandleRef.current = chartEntry?.handle ?? null;

    const audioUrl = audioEntry ? createPackageObjectUrl(audioEntry.file, packageObjectUrlsRef.current) : undefined;
    const coverUrl = artworkEntry
      ? createPackageObjectUrl(artworkEntry.file, packageObjectUrlsRef.current)
      : audioEntry
        ? await readEmbeddedArtwork(audioEntry.file)
        : undefined;

    if (chartEntry) {
      await loadChartJson(JSON.stringify(parsedPackageChart), chartEntry.handle, {
        audioUrl,
        audioFileName: audioEntry?.file.name,
        coverUrl,
        coverFileName: artworkEntry?.file.name,
      });
      setAnalysisLabel(`已导入文件夹包 · ${chartEntry.file.name}${audioEntry ? ` · ${audioEntry.file.name}` : ""}`);
      return;
    }

    if (!audioEntry) return;
    const parsedMeta = parseAudioFileName(audioEntry.file.name);
    const durationMs = await readAudioDurationMs(audioUrl ?? "").catch(() => chart.meta.durationMs);
    const nextChart = createManualChart({
      bpm,
      durationMs,
      laneCount,
      initialLaneCount,
      title: parsedMeta.title,
      artist: parsedMeta.artist,
      audioUrl,
      audioFileName: audioEntry.file.name,
      coverUrl: coverUrl ?? chart.meta.coverUrl,
      coverFileName: artworkEntry?.file.name,
    });
    const nextFileName = `${sanitizeFileName(parsedMeta.title || stripFileExtension(audioEntry.file.name))}.json`;
    if (directoryHandle) {
      try {
        chartFileHandleRef.current = await directoryHandle.getFileHandle(nextFileName, { create: true });
        await writeJsonToHandle(chartFileHandleRef.current, JSON.stringify(prepareChartForExport(nextChart), null, 2));
      } catch {
        chartFileHandleRef.current = null;
      }
    }
    setBpm(nextChart.bpm);
    setBpmInput(String(nextChart.bpm));
    setLaneCount(nextChart.laneCount);
    setInitialLaneCount(getInitialLaneCount(nextChart));
    setEditTimeMs(0);
    setSelectedNoteIds(new Set());
    setSelectionRange(null);
    onChartChange(nextChart);
    setAnalysisLabel(chartFileHandleRef.current
      ? `已创建包内谱面 ${nextFileName} · 之后 Save 会更新该文件`
      : `已从文件夹载入音频和曲绘 · Save 时创建 ${nextFileName}`);
  };

  const loadChartJson = async (json: string, handle?: WritableFileHandle, packageAssets?: PackageAssets) => {
    const parsed = JSON.parse(json) as Chart;
    const result = normalizeImportedChart(parsed);
    if (result.error || !result.chart) {
      setAnalysisLabel(result.error ?? "导入 JSON 失败");
      return;
    }
    const normalizedChart = result.chart;
    setBpm(normalizedChart.bpm);
    setBpmInput(String(normalizedChart.bpm));
    setLaneCount(normalizedChart.laneCount);
    setInitialLaneCount(normalizedChart.initialLaneCount);
    setEditTimeMs(0);
    setSelectedNoteIds(new Set());
    setSelectionRange(null);
    chartFileHandleRef.current = handle ?? null;
    onChartChange({
      ...normalizedChart,
      meta: {
        ...normalizedChart.meta,
        audioUrl: packageAssets?.audioUrl ?? normalizedChart.meta.audioUrl,
        audioFileName: packageAssets?.audioFileName ?? normalizedChart.meta.audioFileName,
        coverUrl: packageAssets?.coverUrl ?? normalizedChart.meta.coverUrl,
        coverFileName: packageAssets?.coverFileName ?? normalizedChart.meta.coverFileName,
      },
    });
  };

  return (
    <section className="editor-screen">
      <section className="editor-panel import-panel">
        <div className="button-row">
          <button className="primary" onClick={() => audioInputRef.current?.click()}>Import Audio</button>
          <button onClick={() => artworkInputRef.current?.click()}>Upload Artwork</button>
          <button onClick={() => void importChartFromPicker()}>Import JSON</button>
          <button onClick={saveChart}>Save</button>
        </div>
        <div className="toolbar-controls">
          <BpmInput value={bpmInput} onChange={setBpmInput} onCommit={commitBpmInput} />
          <ControlNumber label="普通轨道" value={laneCount} min={2} max={10} step={2} onChange={(value) => updateGrid(bpm, clampLaneCount(value))} />
          <ControlNumber label="初始轨道" value={initialLaneCount} min={2} max={laneCount} step={2} onChange={updateInitialLaneCount} />
          <label className="control-field">
            <span>吸附精度</span>
            <select value={snapDivision} onChange={(event) => onSnapDivisionChange(Number(event.target.value))}>
              <option value={1}>1/1 beat</option>
              <option value={2}>1/2 beat</option>
              <option value={4}>1/4 beat</option>
              <option value={8}>1/8 beat</option>
              <option value={16}>1/16 beat</option>
            </select>
          </label>
          <label className="control-field time-field">
            <span>当前时间 ms</span>
            <input
              type="number"
              min={0}
              max={Math.round(chart.meta.durationMs)}
              step={Math.round(snapMs)}
              value={Math.round(editTimeMs)}
              onChange={(event) => setSnappedEditTime(Number(event.target.value))}
            />
          </label>
          <label className="control-field speed-field">
            <span>流速: {editorSpeed.toFixed(1)}x</span>
            <input
              type="range"
              min={0.6}
              max={2.4}
              step={0.1}
              value={editorSpeed}
              onChange={(event) => onEditorSpeedChange(Number(event.target.value))}
            />
          </label>
        </div>
        <input ref={audioInputRef} hidden type="file" accept={AUDIO_FILE_ACCEPT} onChange={handleAudio} />
        <input ref={artworkInputRef} hidden type="file" accept="image/*" onChange={handleArtwork} />
        <input ref={chartInputRef} hidden type="file" accept="application/json" onChange={importChart} />
        <input
          ref={packageInputRef}
          hidden
          type="file"
          multiple
          {...{ webkitdirectory: "", directory: "" }}
          onChange={importPackageFromInput}
        />
      </section>

      <section className="editor-grid">
        <div className="editor-panel map-panel">
          <h2>手工铺谱工具</h2>
          <div className="manual-tools">
            {!selectedNoteIds.size ? (
              <>
              <div className="placement-mode" role="radiogroup" aria-label="Note placement mode">
                <button
                  type="button"
                  role="radio"
                  aria-checked={placementMode === "tap"}
                  className={placementMode === "tap" ? "primary" : ""}
                  onClick={() => setPlacementMode((previous) => previous === "tap" ? "select" : "tap")}
                >
                  Add Tap
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={placementMode === "tap-hold"}
                  className={placementMode === "tap-hold" ? "primary" : ""}
                  onClick={() => setPlacementMode((previous) => previous === "tap-hold" ? "select" : "tap-hold")}
                >
                  Tap Hold
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={placementMode === "space-left"}
                  className={placementMode === "space-left" ? "primary" : ""}
                  onClick={() => setPlacementMode((previous) => previous === "space-left" ? "select" : "space-left")}
                >
                  Add L
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={placementMode === "space-right"}
                  className={placementMode === "space-right" ? "primary" : ""}
                  onClick={() => setPlacementMode((previous) => previous === "space-right" ? "select" : "space-right")}
                >
                  Add R
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={placementMode === "space-hold"}
                  className={placementMode === "space-hold" ? "primary" : ""}
                  onClick={() => setPlacementMode((previous) => previous === "space-hold" ? "select" : "space-hold")}
                >
                  Space Hold
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={placementMode === "lane"}
                  className={placementMode === "lane" ? "primary" : ""}
                  onClick={() => setPlacementMode((previous) => previous === "lane" ? "select" : "lane")}
                >
                  Lane
                </button>
              </div>
              {placementMode === "lane" ? (
                <label className="control-field">
                  <span>变为轨道</span>
                  <input
                    type="number"
                    min={2}
                    max={laneCount}
                    step={2}
                    value={laneEventTargetCount}
                    onChange={(event) => setLaneEventTargetCount(Math.min(laneCount, clampLaneCount(Number(event.target.value))))}
                  />
                </label>
              ) : null}
              {isSpacePlacementMode(placementMode) ? (
                <label className="control-field">
                  <span>跨度</span>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={spaceSpan}
                    onChange={(event) => setSpaceSpan(clampSpaceSpan(Number(event.target.value)))}
                  />
                </label>
              ) : null}
              {isHoldPlacementMode(placementMode) ? (
                <>
                  <label className="control-field">
                    <span>Hold 密度</span>
                    <input
                      type="number"
                      min={1}
                      max={64}
                      value={holdDensity}
                      onChange={(event) => onHoldDensityChange(clampHoldDensity(Number(event.target.value)))}
                    />
                  </label>
                  <label className="control-field">
                    <span>Hold 时间 ms</span>
                    <input
                      type="number"
                      min={1}
                      max={8000}
                      step={1}
                      value={holdDurationMs}
                      onChange={(event) => setHoldDurationMs(clampHoldDurationMs(Number(event.target.value)))}
                    />
                  </label>
                  {holdDensity === 1 && placementMode === "space-hold" ? (
                    <label className="control-field">
                      <span>1物量位置</span>
                      <select value={holdDensityPosition} onChange={(event) => setHoldDensityPosition(event.target.value as HoldDensityPosition)}>
                        <option value="head">头</option>
                        <option value="middle">中</option>
                        <option value="tail">尾</option>
                      </select>
                    </label>
                  ) : null}
                </>
              ) : null}
              </>
            ) : (
              <div className="selection-panel">
                <p className="selection-status">
                  已选 {selectedNoteIds.size} notes
                </p>
                <label className="control-field">
                  <span>Timing Group</span>
                  <select value={selectedTimingGroupId} onChange={(event) => updateSelectedTimingGroup(event.target.value)}>
                    {timingGroups.map((group) => (
                      <option key={group.id} value={group.id}>{group.name}</option>
                    ))}
                  </select>
                </label>
                <div className="selection-actions">
                  <button onClick={deleteSelection} disabled={!selectedNoteIds.size}>删除</button>
                  <button onClick={copySelection} disabled={!selectedNoteIds.size || !selectionRange}>复制</button>
                  <button onClick={mirrorSelection} disabled={!selectedNoteIds.size}>镜像</button>
                  <button onClick={splitSelectedSpaceHolds} disabled={!selectedHasSpaceHold}>拆分物量</button>
                  <button
                    className={isMovingSelection ? "primary" : ""}
                    onClick={() => {
                      if (!selectedNoteIds.size) return;
                      setIsMovingSelection((previous) => !previous);
                      setSelectionMovePreviewMs(selectionHeadTimeMs ?? null);
                      setSelectionMoveLaneDelta(0);
                    }}
                    disabled={!selectedNoteIds.size}
                  >
                    移动
                  </button>
                </div>
                <label className="control-field">
                  <span>段落起始 ms</span>
                  <input
                    className="number-text-input"
                    type="text"
                    inputMode="numeric"
                    value={selectionStartInput}
                    disabled={!selectedNoteIds.size}
                    onChange={(event) => setSelectionStartInput(event.target.value)}
                    onBlur={commitSelectionStartInput}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.currentTarget.blur();
                      }
                    }}
                  />
                </label>
                {selectedHasSpace ? (
                  <label className="control-field">
                    <span>Space 跨度</span>
                    <input
                      type="number"
                      min={1}
                      max={10}
                      value={spaceSpan}
                      onChange={(event) => updateSelectedSpaceSpan(Number(event.target.value))}
                    />
                  </label>
                ) : null}
                {selectedHasLane ? (
                  <label className="control-field">
                    <span>变为轨道</span>
                    <input
                      type="number"
                      min={2}
                      max={laneCount}
                      step={2}
                      value={laneEventTargetCount}
                      onChange={(event) => updateSelectedLaneTargetCount(Number(event.target.value))}
                    />
                  </label>
                ) : null}
                {selectedHasHold ? (
                  <>
                <label className="control-field">
                  <span>Hold 密度</span>
                  <input
                    type="number"
                    min={1}
                    max={64}
                    value={holdDensity}
                    onChange={(event) => updateSelectedHoldDensity(Number(event.target.value))}
                  />
                </label>
                <label className="control-field">
                  <span>Hold 时间 ms</span>
                  <input
                    type="number"
                    min={1}
                    max={8000}
                    step={1}
                    value={holdDurationMs}
                    onChange={(event) => updateSelectedHoldDuration(Number(event.target.value))}
                  />
                </label>
                {holdDensity === 1 && selectedHasSpaceHold ? (
                  <label className="control-field">
                    <span>1物量位置</span>
                    <select value={holdDensityPosition} onChange={(event) => updateSelectedHoldDensityPosition(event.target.value as HoldDensityPosition)}>
                      <option value="head">头</option>
                      <option value="middle">中</option>
                      <option value="tail">尾</option>
                    </select>
                  </label>
                ) : null}
                  </>
                ) : null}
                <TimingGroupsPanel
                  timingGroups={timingGroups}
                  activeTimingGroupId={activeTimingGroupId}
                  editingTimingGroupId={editingTimingGroupId}
                  editingTimingGroup={editingTimingGroup}
                  onActiveTimingGroupChange={setActiveTimingGroupId}
                  onEditingTimingGroupChange={setEditingTimingGroupId}
                  onAddGroup={addTimingGroup}
                  onRenameGroup={renameTimingGroup}
                  onDeleteGroup={deleteTimingGroup}
                  onAddEvent={addTimingEvent}
                  onUpdateEvent={updateTimingEvent}
                  onDeleteEvent={deleteTimingEvent}
                />
                <button
                  className="return-button"
                  onClick={() => {
                    setPlacementMode("select");
                    setSelectedNoteIds(new Set());
                    setSelectionRange(null);
                    setIsMovingSelection(false);
                    setSelectionMovePreviewMs(null);
                    setSelectionMoveLaneDelta(0);
                  }}
                >
                  返回
                </button>
              </div>
            )}
            {!selectedNoteIds.size ? (
              <>
                <button onClick={removeLastNote} disabled={!chart.notes.length}>Undo Last</button>
                <button onClick={clearChart} disabled={!chart.notes.length}>Clear</button>
              </>
            ) : null}
          </div>
        </div>
      </section>

      <section className="editor-panel timeline-panel">
        <div className="timeline-head">
          <audio ref={previewAudioRef} hidden src={chart.meta.audioUrl} onEnded={stopPreview} />
          <div className="preview-controls">
            <button className="primary" onClick={togglePreview} disabled={!chart.meta.audioUrl}>
              {isPreviewing ? "Pause Preview" : "Play Preview"}
            </button>
            <span>{formatTime(editTimeMs)} / {formatTime(chart.meta.durationMs)}</span>
            <input
              type="range"
              min={0}
              max={chart.meta.durationMs}
              value={Math.min(chart.meta.durationMs, Math.max(0, editTimeMs))}
              onChange={(event) => seekPreview(Number(event.target.value))}
            />
            <label className="preview-volume">
              <span>Music {Math.round(musicVolume * 100)}%</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={musicVolume}
                onChange={(event) => onMusicVolumeChange(Number(event.target.value))}
              />
            </label>
            <label className="preview-volume">
              <span>Key {Math.round(keyVolume * 100)}%</span>
                <input
                  type="range"
                  min={0}
                  max={2.5}
                  step={0.01}
                  value={keyVolume}
                onChange={(event) => onKeyVolumeChange(Number(event.target.value))}
              />
            </label>
          </div>
        </div>
        <div className="timeline-scroll">
          <Timeline
            chart={chart}
            previewLaneCount={isPreviewing ? editorPreviewLaneCount : undefined}
            editTimeMs={editTimeMs}
            snapMs={snapMs}
            fallMs={editorFallMs}
            noteSize={noteSize}
            judgeBursts={editorJudgeBursts}
            placementMode={placementMode}
            spaceSpan={spaceSpan}
            holdDurationMs={holdDurationMs}
            activeTimingGroupId={activeTimingGroupId}
            laneEventTargetCount={laneEventTargetCount}
            selectedNoteIds={selectedNoteIds}
            selectionRange={selectionRange}
            isMovingSelection={isMovingSelection}
            selectionMoveDeltaMs={selectionHeadTimeMs === undefined || selectionMovePreviewMs === null ? 0 : selectionMovePreviewMs - selectionHeadTimeMs}
            selectionMoveLaneDelta={selectionMoveLaneDelta}
            onToggleNote={toggleManualNote}
            onToggleLane={toggleLaneNote}
            onHoldDurationChange={setHoldDurationMs}
            onSelectionChange={(ids, range) => {
              setSelectedNoteIds(ids);
              setSelectionRange(range);
              setIsMovingSelection(false);
              setSelectionMovePreviewMs(null);
            }}
            onSelectionMovePreview={(timeMs, laneDelta) => {
              setSelectionMovePreviewMs(timeMs);
              setSelectionMoveLaneDelta(laneDelta);
            }}
            onSelectionMoveCommit={(timeMs, laneDelta) => moveSelectionTo(timeMs, laneDelta)}
            onWheelSeek={wheelSeekEditor}
          />
        </div>
      </section>
    </section>
  );
}

function Timeline({
  chart,
  previewLaneCount,
  editTimeMs,
  snapMs,
  fallMs,
  noteSize,
  judgeBursts,
  placementMode,
  spaceSpan,
  holdDurationMs,
  activeTimingGroupId,
  laneEventTargetCount,
  selectedNoteIds,
  selectionRange,
  isMovingSelection,
  selectionMoveDeltaMs,
  selectionMoveLaneDelta,
  onToggleNote,
  onToggleLane,
  onHoldDurationChange,
  onSelectionChange,
  onSelectionMovePreview,
  onSelectionMoveCommit,
  onWheelSeek,
}: {
  chart: Chart;
  previewLaneCount?: number;
  editTimeMs: number;
  snapMs: number;
  fallMs: number;
  noteSize: number;
  judgeBursts: JudgeBurst[];
  placementMode: PlacementMode;
  spaceSpan: number;
  holdDurationMs: number;
  activeTimingGroupId: string;
  laneEventTargetCount: number;
  selectedNoteIds: Set<string>;
  selectionRange: SelectionRange | null;
  isMovingSelection: boolean;
  selectionMoveDeltaMs: number;
  selectionMoveLaneDelta: number;
  onToggleNote: (laneId: string, timeMs: number, isSpace?: boolean, anchorLaneIndex?: number, isHold?: boolean, durationOverrideMs?: number, spaceSide?: SpaceSide) => void;
  onToggleLane: (timeMs: number) => void;
  onHoldDurationChange: (durationMs: number) => void;
  onSelectionChange: (ids: Set<string>, range: SelectionRange | null) => void;
  onSelectionMovePreview: (timeMs: number, laneDelta: number) => void;
  onSelectionMoveCommit: (timeMs: number, laneDelta: number) => void;
  onWheelSeek: (deltaY: number) => void;
}) {
  const duration = chart.meta.durationMs;
  const [hoverPreview, setHoverPreview] = useState<PlacementTarget | null>(null);
  const [pendingHoldStart, setPendingHoldStart] = useState<(PlacementTarget & { isSpace: boolean }) | null>(null);
  const [selectionDraft, setSelectionDraft] = useState<SelectionRange | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const displayLanes = useMemo(
    () => previewLaneCount === undefined ? chart.lanes : getActiveLaneSlice(chart.lanes, previewLaneCount),
    [chart.lanes, previewLaneCount],
  );
  const laneIndexById = useMemo(
    () => new Map(displayLanes.map((lane, index) => [lane.id, index])),
    [displayLanes],
  );
  const timingGroups = useMemo(() => getTimingGroups(chart), [chart]);
  const noteDisplayOrder = useMemo(
    () => new Map(chart.notes.map((note, index) => [note.id, index])),
    [chart.notes],
  );
  const previewTimingGroup = getTimingGroupById(timingGroups, activeTimingGroupId);
  const selectionHeadLaneIndex = useMemo(() => {
    const selectedVisibleNotes = chart.notes.filter((note) => selectedNoteIds.has(note.id) && isNoteVisibleOnLanes(note, displayLanes));
    if (!selectedVisibleNotes.length) return 0;
    return Math.min(...selectedVisibleNotes.map((note) => getNoteLocalLaneIndex(note, displayLanes, laneIndexById)));
  }, [chart.notes, displayLanes, laneIndexById, selectedNoteIds]);
  useEffect(() => {
    setPendingHoldStart(null);
    setHoverPreview(null);
  }, [placementMode]);

  const readRawTimeFromPointer = (event: React.MouseEvent<HTMLElement>) => {
    const rect = timelineRef.current?.getBoundingClientRect() ?? event.currentTarget.getBoundingClientRect();
    const topPercent = Math.min(100, Math.max(0, ((event.clientY - rect.top) / rect.height) * 100));
    const distanceMs = ((JUDGE_LINE_PERCENT - topPercent) / JUDGE_LINE_PERCENT) * fallMs;
    return Math.max(0, Math.min(duration, editTimeMs + distanceMs));
  };
  const readBarLineTimeFromPointer = (event: React.MouseEvent<HTMLElement>) => {
    const rect = timelineRef.current?.getBoundingClientRect() ?? event.currentTarget.getBoundingClientRect();
    const pointerTopPercent = Math.min(100, Math.max(0, ((event.clientY - rect.top) / rect.height) * 100));
    const tolerancePercent = Math.max(0.9, (7 / rect.height) * 100);
    const nearestLine = chart.barLines
      .map((line) => ({
        line,
        top: getNoteTopPercentRaw(line.timeMs, editTimeMs, fallMs),
      }))
      .filter(({ top }) => top >= -4 && top <= 104)
      .map(({ line, top }) => ({ line, distance: Math.abs(top - pointerTopPercent) }))
      .sort((a, b) => a.distance - b.distance)[0];
    return nearestLine && nearestLine.distance <= tolerancePercent ? nearestLine.line.timeMs : undefined;
  };
  const readTimeFromPointer = (event: React.MouseEvent<HTMLElement>) => {
    return snapTime(readBarLineTimeFromPointer(event) ?? readRawTimeFromPointer(event), snapMs, duration);
  };
  const readPlacementFromPointer = (event: React.MouseEvent<HTMLElement>) => {
    const rect = timelineRef.current?.getBoundingClientRect();
    if (!rect || !displayLanes.length) return null;
    const cellWidth = rect.width / displayLanes.length;
    const rawLaneIndex = Math.floor((event.clientX - rect.left) / cellWidth);
    const isSpacePlacement = isSpacePlacementMode(placementMode);
    const lanePhysicalStart = getLanePhysicalStartIndex(displayLanes);
    const rawPhysicalIndex = lanePhysicalStart + rawLaneIndex;
    const pointerIsLeftOfCenter = event.clientX < rect.left + rect.width / 2;
    const centerBandWidth = Math.max(cellWidth * 0.9, rect.width * 0.08);
    const pointerIsInCenterBand = Math.abs(event.clientX - (rect.left + rect.width / 2)) <= centerBandWidth / 2;
    const safeSpaceSpan = clampSpaceSpan(spaceSpan);
    const anchorLaneIndex = isSpacePlacement
      ? pointerIsInCenterBand
        ? lanePhysicalStart + Math.floor((displayLanes.length - safeSpaceSpan) / 2)
        : pointerIsLeftOfCenter
          ? rawPhysicalIndex - safeSpaceSpan + 1
          : rawPhysicalIndex
      : getLanePhysicalIndex(displayLanes[Math.min(displayLanes.length - 1, Math.max(0, rawLaneIndex))]);
    if (!isSpacePlacement && (rawLaneIndex < 0 || rawLaneIndex >= displayLanes.length)) {
      return null;
    }
    const fallbackLaneIndex = Math.min(displayLanes.length - 1, Math.max(0, rawLaneIndex));
    return {
      laneId: displayLanes[fallbackLaneIndex].id,
      anchorLaneIndex,
      timeMs: readTimeFromPointer(event),
    };
  };
  const readLaneDeltaFromPointer = (event: React.MouseEvent<HTMLElement>) => {
    const rect = timelineRef.current?.getBoundingClientRect();
    if (!rect || !displayLanes.length) return 0;
    const cellWidth = rect.width / displayLanes.length;
    const rawLaneIndex = Math.floor((event.clientX - rect.left) / cellWidth);
    return rawLaneIndex - selectionHeadLaneIndex;
  };
  const visibleBarLines = chart.barLines
    .map((line) => ({ line, top: getNoteTopPercentRaw(line.timeMs, editTimeMs, fallMs) }))
    .filter(({ top }) => top >= -4 && top <= 102);
  const visibleNotesInEditor = chart.notes.filter((note) => {
    if (!isNoteVisibleOnLanes(note, displayLanes)) return false;
    const displayNote = selectedNoteIds.has(note.id) && isMovingSelection
      ? { ...note, timeMs: note.timeMs + selectionMoveDeltaMs }
      : note;
    const timingGroup = getTimingGroupForNote(displayNote, timingGroups);
    const top = getNoteTopPercentRaw(displayNote.timeMs, editTimeMs, fallMs, timingGroup);
    const tailTop = displayNote.type === "hold" ? getNoteTopPercentRaw(getNoteEndTimeMs(displayNote), editTimeMs, fallMs, timingGroup) : top;
    return Math.max(top, tailTop) >= -8 && Math.min(top, tailTop) <= 104;
  });
  const displaySelectionRange = selectionRange && isMovingSelection
    ? { startMs: selectionRange.startMs + selectionMoveDeltaMs, endMs: selectionRange.endMs + selectionMoveDeltaMs }
    : selectionRange;

  return (
    <div
      className="timeline-hit-surface"
      onWheel={(event) => {
        event.preventDefault();
        onWheelSeek(event.deltaY);
      }}
      onMouseDown={(event) => {
        if (placementMode === "select" && isMovingSelection) {
          event.preventDefault();
          onSelectionMoveCommit(readTimeFromPointer(event), readLaneDeltaFromPointer(event));
        }
      }}
      onMouseMove={(event) => {
        if (placementMode === "select" && isMovingSelection) {
          onSelectionMovePreview(readTimeFromPointer(event), readLaneDeltaFromPointer(event));
          return;
        }
        setHoverPreview(placementMode === "select"
          ? null
          : placementMode === "lane"
            ? {
              laneId: displayLanes[Math.floor(displayLanes.length / 2)]?.id ?? displayLanes[0]?.id ?? "",
              anchorLaneIndex: getLanePhysicalStartIndex(displayLanes) + Math.floor((displayLanes.length - laneEventTargetCount) / 2),
              timeMs: readTimeFromPointer(event),
            }
            : readPlacementFromPointer(event));
        if (placementMode === "select" && selectionDraft) {
          const range = { ...selectionDraft, endMs: readTimeFromPointer(event) };
          setSelectionDraft(range);
        }
      }}
      onMouseLeave={() => setHoverPreview(null)}
      onClick={(event) => {
        if (placementMode === "select") {
          if (isMovingSelection) return;
          const timeMs = readTimeFromPointer(event);
          if (selectionDraft) {
            const range = { ...selectionDraft, endMs: timeMs };
            const ids = new Set(chart.notes.filter((note) => isNoteVisibleOnLanes(note, displayLanes) && noteOverlapsRange(note, range)).map((note) => note.id));
            setSelectionDraft(null);
            onSelectionChange(ids, ids.size ? range : null);
            return;
          }

          const note = findNoteAtPointer(event, chart.notes, displayLanes, editTimeMs, fallMs, snapMs, timingGroups);
          if (note) {
            onSelectionChange(new Set([note.id]), { startMs: note.timeMs, endMs: getNoteEndTimeMs(note) });
            return;
          }

          const range = { startMs: timeMs, endMs: timeMs };
          setSelectionDraft(range);
          onSelectionChange(new Set(), null);
          return;
        }
        if (placementMode === "lane") {
          setPendingHoldStart(null);
          onToggleLane(readTimeFromPointer(event));
          return;
        }
        const placement = readPlacementFromPointer(event);
        if (!placement) return;
        const isSpacePlacement = isSpacePlacementMode(placementMode);
        const isHoldPlacement = isHoldPlacementMode(placementMode);
        const spaceSide = getPlacementSpaceSide(placementMode);
        if (!isHoldPlacement) {
          setPendingHoldStart(null);
          onToggleNote(placement.laneId, placement.timeMs, isSpacePlacement, placement.anchorLaneIndex, false, undefined, spaceSide);
          return;
        }

        if (!pendingHoldStart || pendingHoldStart.isSpace !== isSpacePlacement) {
          setPendingHoldStart({
            laneId: placement.laneId,
            timeMs: placement.timeMs,
            anchorLaneIndex: placement.anchorLaneIndex,
            isSpace: isSpacePlacement,
          });
          return;
        }

        const startTimeMs = Math.min(pendingHoldStart.timeMs, placement.timeMs);
        const endTimeMs = Math.max(pendingHoldStart.timeMs, placement.timeMs);
        const durationMs = clampHoldDurationMs(endTimeMs - startTimeMs);
        onHoldDurationChange(durationMs);
        onToggleNote(pendingHoldStart.laneId, startTimeMs, pendingHoldStart.isSpace, pendingHoldStart.anchorLaneIndex, true, durationMs);
        setPendingHoldStart(null);
      }}
    >
      <div
        ref={timelineRef}
        className="timeline"
        style={{ ...getLaneCanvasStyle(displayLanes.length, "editor"), gridTemplateColumns: makeLaneTemplate(displayLanes) }}
      >
        {displayLanes.map((lane) => (
          <div key={lane.id} className="timeline-lane vertical-lane">
            <span className="timeline-lane-label">{lane.label}</span>
          </div>
        ))}
        {visibleBarLines.map(({ line, top }) => (
          <span
            key={`bar-${line.beat}`}
            className={line.isBarStart ? "bar-line strong" : "bar-line"}
            style={{ top: `${top}%` }}
          />
        ))}
        {(selectionDraft ?? displaySelectionRange) ? (
          <span className="selection-range" style={getSelectionRangeStyle(selectionDraft ?? displaySelectionRange, editTimeMs, fallMs)} />
        ) : null}
        <div className="judge-line editor-judge-line" />
        {visibleNotesInEditor.map((note) => {
          const displayNote = selectedNoteIds.has(note.id) && isMovingSelection
            ? shiftNoteLane({ ...note, timeMs: note.timeMs + selectionMoveDeltaMs }, displayLanes, laneIndexById, selectionMoveLaneDelta)
            : note;
          const laneIndex = getNoteLocalLaneIndex(displayNote, displayLanes, laneIndexById);
          const timingGroup = getTimingGroupForNote(displayNote, timingGroups);
          const top = getNoteTopPercent(displayNote.timeMs, editTimeMs, fallMs, timingGroup);
          const span = displayNote.isSpace ? clampSpaceSpan(displayNote.span ?? 1) : 1;
          const placement = isLaneNote(displayNote)
            ? getLaneEventPlacement(getLaneNoteTargetCount(displayNote, chart.laneCount), displayLanes.length)
            : getNotePlacement(laneIndex, displayLanes.length, span, Boolean(displayNote.isSpace), noteSize);
          const isGhostSpace = !isLaneNote(displayNote) && Boolean(displayNote.isSpace) && !spaceStartHasOverlap(getNoteAnchorIndex(displayNote, laneIndexById), span, displayLanes);
          const noteStyle = {
            ...getEditorNoteStyle(displayNote, top, editTimeMs, fallMs, placement, timingGroup),
            opacity: getTimingOpacity(timingGroup, editTimeMs) * (isGhostSpace ? 0.32 : 1),
            zIndex: getNoteDisplayZIndex(note, noteDisplayOrder),
          };
          return (
            <span
              key={note.id}
              className={`timeline-note ${selectedNoteIds.has(note.id) ? "selected-note" : ""} ${isMovingSelection && selectedNoteIds.has(note.id) ? "moving-note" : ""} ${displayNote.type === "hold" ? "hold-note" : ""} ${displayNote.isSpace ? "space-note" : ""} ${isLaneNote(displayNote) ? "lane-note" : ""} ${getSpaceSideClass(displayNote)} ${isGhostSpace ? "ghost-space" : ""}`}
              style={noteStyle}
            />
          );
        })}
        {hoverPreview ? (() => {
          const isSpacePreview = isSpacePlacementMode(placementMode);
          const isHoldPreview = isHoldPlacementMode(placementMode);
          const previewSource = pendingHoldStart && isHoldPreview && pendingHoldStart.isSpace === isSpacePreview
            ? pendingHoldStart
            : hoverPreview;
          const previewStartTimeMs = pendingHoldStart && isHoldPreview && pendingHoldStart.isSpace === isSpacePreview
            ? Math.min(pendingHoldStart.timeMs, hoverPreview.timeMs)
            : hoverPreview.timeMs;
          const previewDurationMs = pendingHoldStart && isHoldPreview && pendingHoldStart.isSpace === isSpacePreview
            ? clampHoldDurationMs(Math.abs(hoverPreview.timeMs - pendingHoldStart.timeMs))
            : holdDurationMs;
          const previewLocalStartIndex = isSpacePreview
            ? previewSource.anchorLaneIndex - getLanePhysicalStartIndex(displayLanes)
            : laneIndexById.get(previewSource.laneId) ?? 0;
          const previewPlacement = placementMode === "lane"
            ? getLaneEventPlacement(laneEventTargetCount, displayLanes.length)
            : getNotePlacement(previewLocalStartIndex, displayLanes.length, isSpacePreview ? spaceSpan : 1, isSpacePreview, noteSize);
          const isGhostPreview = isSpacePreview && !spaceStartHasOverlap(previewSource.anchorLaneIndex, spaceSpan, displayLanes);
          return (
            <span
              className={`timeline-note placement-preview ${pendingHoldStart && isHoldPreview ? "hold-pending" : ""} ${isHoldPreview ? "hold-note" : ""} ${isSpacePreview ? "space-note" : ""} ${placementMode === "lane" ? "lane-note" : ""} ${getPlacementSpaceSideClass(placementMode)} ${isGhostPreview ? "ghost-space" : ""}`}
              style={{
                top: `${getNoteTopPercent(previewStartTimeMs, editTimeMs, fallMs, previewTimingGroup)}%`,
                left: `${previewPlacement.left}%`,
                width: `${previewPlacement.width}%`,
                opacity: getTimingOpacity(previewTimingGroup, editTimeMs) * (isGhostPreview ? 0.32 : 1),
                ...(isHoldPreview ? getHoldPreviewStyle(previewStartTimeMs, previewDurationMs, editTimeMs, fallMs, previewTimingGroup) : {}),
              }}
            />
          );
        })() : null}
        {judgeBursts.map((burst) => (
          (() => {
            const projection = getBurstProjection(burst, displayLanes, laneIndexById);
            return (
              <JudgeBurstLabel
                key={burst.id}
                burst={burst}
                laneCount={displayLanes.length}
                startIndex={projection.startIndex}
                span={projection.span}
              />
            );
          })()
        ))}
      </div>
    </div>
  );
}

function KeyboardStrip({
  segments,
  laneCount,
  activeLaneIds,
  spaceLaneIds,
}: {
  segments: ReturnType<typeof getKeyboardSegments>;
  laneCount: number;
  activeLaneIds: Set<string>;
  spaceLaneIds: Set<string>;
}) {
  return (
    <div
      className="keyboard-strip"
      aria-label="Keyboard lane map"
      style={{ ...getLaneCanvasStyle(laneCount, "play"), gridTemplateColumns: segments.map((segment) => `${segment.widthUnits}fr`).join(" ") }}
    >
      {segments.map((segment) => (
        <div
          key={segment.id}
          className={`key-segment ${activeLaneIds.has(segment.id) ? "lit" : ""} ${spaceLaneIds.has(segment.id) ? "space-lit" : ""}`}
        >
          {segment.label}
        </div>
      ))}
    </div>
  );
}

function NoteBlock({
  note,
  currentMs,
  fallMs,
  noteSize,
  timingGroup,
  zIndex,
  judged,
  locked,
  dimmed,
}: {
  note: Note;
  currentMs: number;
  fallMs: number;
  noteSize: number;
  timingGroup: TimingGroup;
  zIndex: number;
  judged: boolean;
  locked: boolean;
  dimmed: boolean;
}) {
  const top = getNoteTopPercent(note.timeMs, currentMs, fallMs, timingGroup);
  const placement = getNotePlacement(0, 1, 1, false, noteSize);
  const opacity = judged ? 0 : getTimingOpacity(timingGroup, currentMs) * (dimmed ? 0.42 : 1);
  const style = note.type === "hold"
    ? getPlayHoldStyle(note, top, currentMs, fallMs, placement, timingGroup, locked)
    : { top: `${top}%` };

  return (
    <span
      className={`note-block ${note.type === "hold" ? "hold-note" : ""} ${dimmed ? "hold-dimmed" : ""} ${judged ? "judged" : ""}`}
      style={{
        ...style,
        opacity,
        zIndex,
      }}
    />
  );
}

function SpaceNoteBlock({
  note,
  currentMs,
  fallMs,
  timingGroup,
  zIndex,
  laneCount,
  projection,
  judged,
  locked,
  dimmed,
}: {
  note: Note;
  currentMs: number;
  fallMs: number;
  timingGroup: TimingGroup;
  zIndex: number;
  laneCount: number;
  projection: SpaceProjection;
  judged: boolean;
  locked: boolean;
  dimmed: boolean;
}) {
  const top = getNoteTopPercent(note.timeMs, currentMs, fallMs, timingGroup);
  const placement = getSpacePlacementFromStartIndex(projection.startIndex, laneCount, projection.span);
  const isGhostSpace = !projection.isJudgeable;
  const opacity = judged ? 0 : getTimingOpacity(timingGroup, currentMs) * (isGhostSpace ? 0.32 : dimmed ? 0.42 : 1);
  const style = note.type === "hold"
    ? getPlayHoldStyle(note, top, currentMs, fallMs, placement, timingGroup, locked)
    : {
      top: `${top}%`,
      left: `${placement.left}%`,
      width: `${placement.width}%`,
    };

  return (
    <span
      className={`note-block space-note ${getSpaceSideClass(note)} ${note.type === "hold" ? "hold-note" : ""} ${dimmed ? "hold-dimmed" : ""} ${judged ? "judged" : ""} ${isGhostSpace ? "ghost-space" : ""}`}
      style={{ ...style, opacity, zIndex }}
    />
  );
}

function LaneEventBlock({
  note,
  currentMs,
  fallMs,
  timingGroup,
  zIndex,
  laneCount,
  maxLaneCount,
}: {
  note: Note;
  currentMs: number;
  fallMs: number;
  timingGroup: TimingGroup;
  zIndex: number;
  laneCount: number;
  maxLaneCount: number;
}) {
  const top = getNoteTopPercent(note.timeMs, currentMs, fallMs, timingGroup);
  const placement = getLaneEventPlacement(getLaneNoteTargetCount(note, maxLaneCount), laneCount);
  return (
    <span
      className="note-block lane-note"
      style={{
        top: `${top}%`,
        left: `${placement.left}%`,
        width: `${placement.width}%`,
        opacity: getTimingOpacity(timingGroup, currentMs),
        zIndex,
      }}
    />
  );
}

function JudgeBurstLabel({
  burst,
  laneCount,
  startIndex,
  span: projectedSpan,
}: {
  burst: JudgeBurst;
  laneCount: number;
  startIndex: number;
  span?: number;
}) {
  const span = Math.max(1, projectedSpan ?? burst.span);
  const center = ((startIndex + span / 2) / laneCount) * 100;

  return (
    <span
      className={`judge-burst ${burst.result}`}
      style={{ left: `${center}%` }}
    >
      {burst.result}
    </span>
  );
}

function JudgeHitEffect({
  burst,
  laneCount,
  startIndex,
  span: projectedSpan,
}: {
  burst: JudgeBurst;
  laneCount: number;
  startIndex: number;
  span?: number;
}) {
  const span = Math.max(1, projectedSpan ?? burst.span);
  const left = (startIndex / laneCount) * 100;
  const width = (span / laneCount) * 100;

  return (
    <span
      className={`hit-effect ${burst.result} ${burst.spaceSide === "left" ? "left-space-hit" : ""} ${burst.spaceSide === "right" ? "right-space-hit" : ""}`}
      style={{ left: `${left}%`, width: `${width}%` }}
    />
  );
}

function BpmInput({
  value,
  onChange,
  onCommit,
}: {
  value: string;
  onChange: (value: string) => void;
  onCommit: () => void;
}) {
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.currentTarget.blur();
    }
  };

  return (
    <label className="control-field">
      <span>BPM</span>
      <input
        className="number-text-input"
        type="text"
        inputMode="numeric"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onCommit}
        onKeyDown={handleKeyDown}
      />
    </label>
  );
}

function ControlNumber({
  label,
  value,
  min,
  max,
  step,
  plainInput = false,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  plainInput?: boolean;
  onChange: (value: number) => void;
}) {
  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const nextValue = Number(event.target.value);
    if (Number.isFinite(nextValue)) {
      onChange(nextValue);
    }
  };

  return (
    <label className="control-field">
      <span>{label}</span>
      <input
        className={plainInput ? "number-text-input" : undefined}
        type={plainInput ? "text" : "number"}
        inputMode={plainInput ? "numeric" : undefined}
        min={plainInput ? undefined : min}
        max={plainInput ? undefined : max}
        step={plainInput ? undefined : step}
        value={value}
        onChange={handleChange}
      />
    </label>
  );
}

function ControlRange({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="control-field">
      <span>{label}: {value.toFixed(step < 1 ? 2 : 0)}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

function TimingGroupsPanel({
  timingGroups,
  activeTimingGroupId,
  editingTimingGroupId,
  editingTimingGroup,
  onActiveTimingGroupChange,
  onEditingTimingGroupChange,
  onAddGroup,
  onRenameGroup,
  onDeleteGroup,
  onAddEvent,
  onUpdateEvent,
  onDeleteEvent,
}: {
  timingGroups: TimingGroup[];
  activeTimingGroupId: string;
  editingTimingGroupId: string;
  editingTimingGroup: TimingGroup;
  onActiveTimingGroupChange: (groupId: string) => void;
  onEditingTimingGroupChange: (groupId: string) => void;
  onAddGroup: () => void;
  onRenameGroup: (groupId: string, name: string) => void;
  onDeleteGroup: (groupId: string) => void;
  onAddEvent: (groupId: string, type: TimingEventType) => void;
  onUpdateEvent: (groupId: string, eventId: string, patch: Partial<TimingEvent>) => void;
  onDeleteEvent: (groupId: string, eventId: string) => void;
}) {
  return (
    <section className="timing-groups-panel">
      <h3>Timing Groups</h3>
      <label className="control-field">
        <span>默认放置组</span>
        <select value={activeTimingGroupId} onChange={(event) => onActiveTimingGroupChange(event.target.value)}>
          {timingGroups.map((group) => (
            <option key={group.id} value={group.id}>{group.name}</option>
          ))}
        </select>
      </label>
      <div className="timing-group-row">
        <select value={editingTimingGroupId} onChange={(event) => onEditingTimingGroupChange(event.target.value)}>
          {timingGroups.map((group) => (
            <option key={group.id} value={group.id}>{group.name}</option>
          ))}
        </select>
        <button onClick={onAddGroup}>New</button>
      </div>
      <div className="timing-group-row">
        <input
          type="text"
          value={editingTimingGroup.name}
          onChange={(event) => onRenameGroup(editingTimingGroup.id, event.target.value)}
        />
        <button onClick={() => onDeleteGroup(editingTimingGroup.id)} disabled={editingTimingGroup.id === DEFAULT_TIMING_GROUP_ID}>Del</button>
      </div>
      <div className="timing-event-buttons">
        <button onClick={() => onAddEvent(editingTimingGroup.id, "speed")}>Add Speed</button>
        <button onClick={() => onAddEvent(editingTimingGroup.id, "freeze")}>Add Freeze</button>
        <button onClick={() => onAddEvent(editingTimingGroup.id, "opacity")}>Add Opacity</button>
      </div>
      <div className="timing-events">
        {editingTimingGroup.events.length ? editingTimingGroup.events.map((event) => (
          <div key={event.id} className="timing-event-row">
            <strong>{event.type}</strong>
            <label>
              <span>ms</span>
              <input
                type="number"
                value={Math.round(event.timeMs)}
                onChange={(inputEvent) => onUpdateEvent(editingTimingGroup.id, event.id, { timeMs: Number(inputEvent.target.value) })}
              />
            </label>
            {event.type === "speed" ? (
              <label>
                <span>x</span>
                <input
                  type="number"
                  min={0.1}
                  max={8}
                  step={0.1}
                  value={event.multiplier ?? 1}
                  onChange={(inputEvent) => onUpdateEvent(editingTimingGroup.id, event.id, { multiplier: Number(inputEvent.target.value) })}
                />
              </label>
            ) : null}
            {event.type === "freeze" ? (
              <label>
                <span>dur</span>
                <input
                  type="number"
                  min={0}
                  step={10}
                  value={event.durationMs ?? 0}
                  onChange={(inputEvent) => onUpdateEvent(editingTimingGroup.id, event.id, { durationMs: Number(inputEvent.target.value) })}
                />
              </label>
            ) : null}
            {event.type === "opacity" ? (
              <>
                <label>
                  <span>alpha</span>
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={event.opacity ?? 1}
                    onChange={(inputEvent) => onUpdateEvent(editingTimingGroup.id, event.id, { opacity: Number(inputEvent.target.value) })}
                  />
                </label>
                <label>
                  <span>fade</span>
                  <input
                    type="number"
                    min={0}
                    step={10}
                    value={event.transitionMs ?? 0}
                    onChange={(inputEvent) => onUpdateEvent(editingTimingGroup.id, event.id, { transitionMs: Number(inputEvent.target.value) })}
                  />
                </label>
              </>
            ) : null}
            <button onClick={() => onDeleteEvent(editingTimingGroup.id, event.id)}>x</button>
          </div>
        )) : (
          <p className="timing-empty">无事件</p>
        )}
      </div>
    </section>
  );
}

function visibleTapNotes(
  notes: Note[],
  lane: LaneConfig,
  currentMs: number,
  fallMs: number,
  timingGroups: TimingGroup[] = createDefaultTimingGroups(),
) {
  return notes.filter((note) => {
    return (
      !note.isSpace
      && !isLaneNote(note)
      && note.laneId === lane.id
      && isNoteVisuallyInWindow(note, currentMs, fallMs, getTimingGroupForNote(note, timingGroups))
    );
  });
}

function visibleSpaceNotes(notes: Note[], currentMs: number, fallMs: number, timingGroups: TimingGroup[] = createDefaultTimingGroups()) {
  return notes.filter((note) => (
    !isLaneNote(note)
    && note.isSpace
    && isNoteVisuallyInWindow(note, currentMs, fallMs, getTimingGroupForNote(note, timingGroups))
  ));
}

function getNoteTopPercent(timeMs: number, currentMs: number, fallMs: number, timingGroup?: TimingGroup) {
  return Math.max(-10, Math.min(102, getNoteTopPercentRaw(timeMs, currentMs, fallMs, timingGroup)));
}

function getNoteTopPercentRaw(timeMs: number, currentMs: number, fallMs: number, timingGroup?: TimingGroup) {
  const visualCurrentMs = timingGroup ? getFreezeClampedTime(timingGroup, currentMs) : currentMs;
  const distanceMs = timingGroup ? getSpeedScaledDeltaMs(timingGroup, visualCurrentMs, timeMs) : timeMs - currentMs;
  return JUDGE_LINE_PERCENT - (distanceMs / fallMs) * JUDGE_LINE_PERCENT;
}

function isNoteVisuallyInWindow(note: Note, currentMs: number, fallMs: number, timingGroup?: TimingGroup) {
  const headTop = getNoteTopPercentRaw(note.timeMs, currentMs, fallMs, timingGroup);
  const tailTop = note.type === "hold" ? getNoteTopPercentRaw(getNoteEndTimeMs(note), currentMs, fallMs, timingGroup) : headTop;
  return Math.max(headTop, tailTop) >= -8 && Math.min(headTop, tailTop) <= 104;
}

function getTimingGroups(chart: Chart) {
  return keepEditableTimingGroups(chart.timingGroups ?? []);
}

function keepEditableTimingGroups(groups: TimingGroup[]) {
  const seen = new Set<string>();
  const editableGroups = groups
    .filter((group) => group && typeof group.id === "string" && group.id.trim())
    .map((group) => ({
      ...group,
      id: group.id.trim(),
      name: group.name ?? "",
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

  if (!editableGroups.some((group) => group.id === DEFAULT_TIMING_GROUP_ID)) {
    editableGroups.unshift(createDefaultTimingGroups()[0]);
  }

  return editableGroups;
}

function getTimingGroupById(groups: TimingGroup[], groupId?: string) {
  return groups.find((group) => group.id === groupId)
    ?? groups.find((group) => group.id === DEFAULT_TIMING_GROUP_ID)
    ?? createDefaultTimingGroups()[0];
}

function getTimingGroupForNote(note: Note, groups: TimingGroup[]) {
  return getTimingGroupById(groups, note.timingGroupId ?? DEFAULT_TIMING_GROUP_ID);
}

function selectedNotesTimingGroupId(notes: Note[], selectedNoteIds: Set<string>) {
  const selected = notes.filter((note) => selectedNoteIds.has(note.id));
  if (!selected.length) return DEFAULT_TIMING_GROUP_ID;
  const firstGroupId = selected[0].timingGroupId ?? DEFAULT_TIMING_GROUP_ID;
  return selected.every((note) => (note.timingGroupId ?? DEFAULT_TIMING_GROUP_ID) === firstGroupId)
    ? firstGroupId
    : firstGroupId;
}

function getFreezeClampedTime(group: TimingGroup, currentMs: number) {
  const freeze = group.events
    .filter((event) => event.type === "freeze")
    .find((event) => currentMs >= event.timeMs && currentMs <= event.timeMs + Math.max(0, event.durationMs ?? 0));
  return freeze ? freeze.timeMs : currentMs;
}

function getSpeedScaledDeltaMs(group: TimingGroup, fromMs: number, toMs: number) {
  if (fromMs === toMs) return 0;
  const startMs = Math.min(fromMs, toMs);
  const endMs = Math.max(fromMs, toMs);
  const direction = toMs >= fromMs ? 1 : -1;
  const speedEvents = group.events
    .filter((event) => event.type === "speed")
    .sort((a, b) => a.timeMs - b.timeMs);
  let cursor = startMs;
  let speed = getSpeedAt(group, startMs);
  let scaled = 0;

  speedEvents.forEach((event) => {
    if (event.timeMs <= startMs || event.timeMs >= endMs) return;
    scaled += (event.timeMs - cursor) * speed;
    speed = clampTimingSpeed(event.multiplier ?? 1);
    cursor = event.timeMs;
  });

  scaled += (endMs - cursor) * speed;
  return scaled * direction;
}

function getSpeedAt(group: TimingGroup, timeMs: number) {
  return clampTimingSpeed(group.events
    .filter((event) => event.type === "speed" && event.timeMs <= timeMs)
    .sort((a, b) => b.timeMs - a.timeMs)[0]?.multiplier ?? 1);
}

function clampTimingSpeed(value: number) {
  return Math.min(8, Math.max(0.05, Number.isFinite(value) ? value : 1));
}

function getTimingOpacity(group: TimingGroup | undefined, currentMs: number) {
  if (!group) return 1;
  const opacityEvents = group.events
    .filter((event) => event.type === "opacity")
    .sort((a, b) => a.timeMs - b.timeMs);
  let previousOpacity = 1;
  for (const event of opacityEvents) {
    const targetOpacity = Math.min(1, Math.max(0, event.opacity ?? 1));
    const transitionMs = Math.max(0, event.transitionMs ?? 0);
    if (currentMs < event.timeMs) {
      return previousOpacity;
    }
    if (transitionMs > 0 && currentMs < event.timeMs + transitionMs) {
      const progress = (currentMs - event.timeMs) / transitionMs;
      return previousOpacity + (targetOpacity - previousOpacity) * progress;
    }
    previousOpacity = targetOpacity;
  }
  return previousOpacity;
}

function getNoteEndTimeMs(note: Note) {
  return note.type === "hold" ? note.timeMs + clampHoldDurationMs(note.durationMs ?? DEFAULT_HOLD_DURATION_MS) : note.timeMs;
}

function getNoteDisplayZIndex(note: Note, noteDisplayOrder: Map<string, number>) {
  return 20 + (noteDisplayOrder.get(note.id) ?? 0);
}

function getHoldDensityTimes(note: Note) {
  const density = clampHoldDensity(note.holdDensity ?? DEFAULT_HOLD_DENSITY);
  const durationMs = clampHoldDurationMs(note.durationMs ?? DEFAULT_HOLD_DURATION_MS);
  if (density <= 1) {
    const position = note.isSpace ? note.holdDensityPosition ?? DEFAULT_HOLD_DENSITY_POSITION : "middle";
    const ratio = position === "head" ? 0 : position === "tail" ? 1 : 0.5;
    return [Math.round(note.timeMs + durationMs * ratio)];
  }
  return Array.from({ length: density }, (_, index) => (
    Math.round(note.timeMs + (durationMs * (index + 1)) / (density + 1))
  ));
}

function getHoldTickId(note: Note, tickIndex: number) {
  return `${note.id}:hold:${tickIndex}`;
}

function getPlayHoldStyle(
  note: Note,
  headTop: number,
  currentMs: number,
  fallMs: number,
  placement: { left: number; width: number },
  timingGroup?: TimingGroup,
  lockedToJudgeLine = false,
): CSSProperties {
  const visualHeadTop = lockedToJudgeLine ? JUDGE_LINE_PERCENT : headTop;
  const rawTailTop = getNoteTopPercent(getNoteEndTimeMs(note), currentMs, fallMs, timingGroup);
  const tailTop = lockedToJudgeLine ? Math.min(rawTailTop, JUDGE_LINE_PERCENT) : rawTailTop;
  const top = Math.min(visualHeadTop, tailTop);
  return {
    top: `${top}%`,
    left: `${placement.left}%`,
    width: `${placement.width}%`,
    height: `${Math.max(1.1, Math.abs(tailTop - visualHeadTop))}%`,
    transform: "none",
  };
}

function getEditorNoteStyle(
  note: Note,
  headTop: number,
  editTimeMs: number,
  fallMs: number,
  placement: { left: number; width: number },
  timingGroup?: TimingGroup,
): CSSProperties {
  if (note.type !== "hold") {
    return {
      top: `${headTop}%`,
      left: `${placement.left}%`,
      width: `${placement.width}%`,
    };
  }
  return getPlayHoldStyle(note, headTop, editTimeMs, fallMs, placement, timingGroup);
}

function getHoldPreviewStyle(timeMs: number, durationMs: number, editTimeMs: number, fallMs: number, timingGroup?: TimingGroup): CSSProperties {
  const headTop = getNoteTopPercent(timeMs, editTimeMs, fallMs, timingGroup);
  const tailTop = getNoteTopPercent(timeMs + clampHoldDurationMs(durationMs), editTimeMs, fallMs, timingGroup);
  return {
    top: `${Math.min(headTop, tailTop)}%`,
    height: `${Math.max(1.1, Math.abs(tailTop - headTop))}%`,
    transform: "none",
  };
}

function getSelectionRangeStyle(range: SelectionRange | null, currentMs: number, fallMs: number): CSSProperties {
  if (!range) return {};
  const startTop = getNoteTopPercent(Math.min(range.startMs, range.endMs), currentMs, fallMs);
  const endTop = getNoteTopPercent(Math.max(range.startMs, range.endMs), currentMs, fallMs);
  return {
    top: `${Math.min(startTop, endTop)}%`,
    height: `${Math.max(0.2, Math.abs(endTop - startTop))}%`,
  };
}

function noteOverlapsRange(note: Note, range: SelectionRange) {
  const startMs = Math.min(range.startMs, range.endMs);
  const endMs = Math.max(range.startMs, range.endMs);
  return getNoteEndTimeMs(note) >= startMs && note.timeMs <= endMs;
}

function isNoteVisibleOnLanes(note: Note, lanes: LaneConfig[]) {
  if (isLaneNote(note)) return true;
  if (note.isSpace) return true;
  return lanes.some((lane) => lane.id === note.laneId);
}

function findNoteAtPointer(
  event: React.MouseEvent<HTMLElement>,
  notes: Note[],
  lanes: LaneConfig[],
  currentMs: number,
  fallMs: number,
  snapMs: number,
  timingGroups: TimingGroup[] = createDefaultTimingGroups(),
) {
  const timeline = event.currentTarget.querySelector(".timeline");
  const rect = timeline?.getBoundingClientRect();
  if (!rect || !lanes.length) return undefined;

  const laneIndexById = new Map(lanes.map((lane, index) => [lane.id, index]));
  const laneCount = lanes.length;
  const rawLaneIndex = Math.floor((event.clientX - rect.left) / (rect.width / laneCount));
  const pointerTop = ((event.clientY - rect.top) / rect.height) * 100;
  const verticalTolerance = Math.max(1.4, (snapMs / fallMs) * JUDGE_LINE_PERCENT * 0.42);

  return notes
    .filter((note) => noteContainsLane(note, rawLaneIndex, laneCount, laneIndexById, lanes))
    .map((note) => {
      const timingGroup = getTimingGroupForNote(note, timingGroups);
      const headTop = getNoteTopPercent(note.timeMs, currentMs, fallMs, timingGroup);
      const tailTop = note.type === "hold" ? getNoteTopPercent(getNoteEndTimeMs(note), currentMs, fallMs, timingGroup) : headTop;
      const minTop = Math.min(headTop, tailTop);
      const maxTop = Math.max(headTop, tailTop);
      const insideVertical = note.type === "hold"
        ? pointerTop >= minTop - verticalTolerance && pointerTop <= maxTop + verticalTolerance
        : Math.abs(pointerTop - headTop) <= verticalTolerance;
      return {
        note,
        insideVertical,
        distance: note.type === "hold"
          ? Math.max(0, minTop - pointerTop, pointerTop - maxTop)
          : Math.abs(pointerTop - headTop),
      };
    })
    .filter((item) => item.insideVertical)
    .sort((a, b) => a.distance - b.distance)[0]?.note;
}

function noteContainsLane(note: Note, rawLaneIndex: number, laneCount: number, laneIndexById: Map<string, number>, lanes: LaneConfig[]) {
  if (isLaneNote(note)) {
    const targetCount = getLaneNoteTargetCount(note, laneCount);
    const startIndex = (laneCount - targetCount) / 2;
    return rawLaneIndex >= startIndex && rawLaneIndex < startIndex + targetCount;
  }
  if (!note.isSpace) {
    return rawLaneIndex === laneIndexById.get(note.laneId);
  }
  const span = clampSpaceSpan(note.span ?? 1);
  const startIndex = getSpaceLocalStartIndex(note, lanes, laneIndexById);
  return rawLaneIndex >= startIndex && rawLaneIndex < startIndex + span;
}

function mirrorNote(note: Note, lanes: LaneConfig[]): Note {
  if (isLaneNote(note)) return note;
  const safeLaneCount = Math.max(1, lanes.length);
  const laneIndexById = new Map(lanes.map((lane, index) => [lane.id, index]));
  if (!note.isSpace) {
    const sourceIndex = laneIndexById.get(note.laneId);
    if (sourceIndex === undefined) return note;
    const mirroredIndex = safeLaneCount - 1 - Math.min(safeLaneCount - 1, Math.max(0, sourceIndex));
    return {
      ...note,
      laneId: lanes[mirroredIndex]?.id ?? note.laneId,
    };
  }

  const span = clampSpaceSpan(note.span ?? 1);
  const physicalStart = getNoteAnchorIndex(note, laneIndexById);
  const localStartIndex = physicalStart - getLanePhysicalStartIndex(lanes);
  const mirroredStartIndex = safeLaneCount - localStartIndex - span;
  const mirroredAnchorIndex = getLanePhysicalStartIndex(lanes) + mirroredStartIndex;
  return {
    ...note,
    laneId: lanes[Math.min(safeLaneCount - 1, Math.max(0, mirroredStartIndex))]?.id ?? note.laneId,
    anchorLaneIndex: mirroredAnchorIndex,
    spaceSide: note.type !== "hold" ? mirrorSpaceSide(note.spaceSide) : note.spaceSide,
  };
}

function mirrorSpaceSide(side?: SpaceSide): SpaceSide | undefined {
  if (side === "left") return "right";
  if (side === "right") return "left";
  return side;
}

function shiftNoteLane(note: Note, lanes: LaneConfig[], laneIndexById: Map<string, number>, laneDelta: number): Note {
  if (!laneDelta) return note;
  if (isLaneNote(note)) return note;
  if (note.isSpace) {
    const nextAnchorLaneIndex = getNoteAnchorIndex(note, laneIndexById) + laneDelta;
    const localStartIndex = nextAnchorLaneIndex - getLanePhysicalStartIndex(lanes);
    const fallbackLaneIndex = Math.min(lanes.length - 1, Math.max(0, localStartIndex));
    return {
      ...note,
      laneId: lanes[fallbackLaneIndex]?.id ?? note.laneId,
      anchorLaneIndex: nextAnchorLaneIndex,
    };
  }

  const laneIndex = laneIndexById.get(note.laneId);
  if (laneIndex === undefined) return note;
  const nextLaneIndex = Math.min(lanes.length - 1, Math.max(0, laneIndex + laneDelta));
  return {
    ...note,
    laneId: lanes[nextLaneIndex]?.id ?? note.laneId,
  };
}

function getHoldInputCodes(
  note: Note,
  activeLanes: LaneConfig[],
  sourceLaneIndexById: Map<string, number>,
) {
  if (note.isSpace) {
    return getSpaceProjection(note, activeLanes, sourceLaneIndexById).isJudgeable ? ["Space"] : [];
  }
  const lane = activeLanes.find((item) => item.id === note.laneId);
  return lane?.keyCodes ?? [];
}

function armHoldInputsAt(
  liveMs: number,
  code: string,
  notes: Note[],
  activeLanes: LaneConfig[],
  sourceLaneIndexById: Map<string, number>,
  armedInputs: Map<string, number>,
  keyPressTimes: Map<string, number>,
) {
  const pressMs = keyPressTimes.get(code);
  if (typeof pressMs !== "number") return;
  const canArm = notes.some((note) => (
    note.type === "hold"
    && !note.isSpace
    && liveMs >= note.timeMs - HIT_WINDOW_MS
    && liveMs <= getNoteEndTimeMs(note)
    && getHoldInputCodes(note, activeLanes, sourceLaneIndexById).includes(code)
  ));
  if (canArm) {
    armedInputs.set(code, pressMs);
  }
}

function getTouchHoldInputState(
  note: Note,
  touchInputs: TouchHoldInputSnapshot | undefined,
  tickTimeMs: number,
  currentMs: number,
): HoldInputState {
  if (!touchInputs) return { isHeld: false, isEligible: false };

  if (note.isSpace) {
    const activeTouches = [...touchInputs.activeTouches.values()];
    const activePressMs = activeTouches.length
      ? Math.min(...activeTouches.map((touch) => touch.startedAtMs))
      : undefined;
    const isGraceHeld = !activeTouches.length
      && typeof touchInputs.lastTouchReleaseMs === "number"
      && currentMs >= touchInputs.lastTouchReleaseMs
      && currentMs - touchInputs.lastTouchReleaseMs <= touchInputs.spaceGraceMs;
    const pressMs = activePressMs ?? (isGraceHeld ? touchInputs.lastTouchReleaseMs ?? undefined : undefined);
    const isHeld = activeTouches.length > 0 || isGraceHeld;
    if (!isHeld) return { isHeld: false, isEligible: false };

    return {
      pressMs,
      isHeld: true,
      isEligible: typeof pressMs === "number"
        && (currentMs <= tickTimeMs + HIT_WINDOW_MS || pressMs <= tickTimeMs + HIT_WINDOW_MS),
    };
  }

  const laneTouches = [...touchInputs.activeTouches.values()]
    .filter((touch) => touch.laneId === note.laneId && typeof touch.lanePressMs === "number")
    .sort((a, b) => (a.lanePressMs ?? 0) - (b.lanePressMs ?? 0));
  const firstTouch = laneTouches[0];
  if (!firstTouch) return { isHeld: false, isEligible: false };

  if (currentMs > tickTimeMs + HIT_WINDOW_MS) {
    return {
      pressMs: firstTouch.lanePressMs,
      isHeld: true,
      isEligible: false,
    };
  }

  const eligibleTouch = laneTouches.find((touch) => {
    const pressMs = touch.lanePressMs;
    return typeof pressMs === "number"
      && pressMs >= note.timeMs - HIT_WINDOW_MS
      && pressMs <= tickTimeMs + HIT_WINDOW_MS;
  });

  return {
    pressMs: eligibleTouch?.lanePressMs ?? firstTouch.lanePressMs,
    isHeld: true,
    isEligible: Boolean(eligibleTouch),
  };
}

function getHoldInputState(
  note: Note,
  pressedCodes: Set<string>,
  activeLanes: LaneConfig[],
  sourceLaneIndexById: Map<string, number>,
  keyPressTimes: Map<string, number>,
  armedInputs: Map<string, number>,
  tickTimeMs: number,
  currentMs: number,
  touchInputs?: TouchHoldInputSnapshot,
): HoldInputState {
  const touchState = getTouchHoldInputState(note, touchInputs, tickTimeMs, currentMs);
  const codes = getHoldInputCodes(note, activeLanes, sourceLaneIndexById);
  const code = codes.find((item) => pressedCodes.has(item));
  if (!code) return touchState;

  const pressMs = keyPressTimes.get(code);
  if (note.isSpace) {
    const keyboardState: HoldInputState = {
      code,
      pressMs,
      isHeld: true,
      isEligible: typeof pressMs === "number"
        && (currentMs <= tickTimeMs + HIT_WINDOW_MS || pressMs <= tickTimeMs + HIT_WINDOW_MS),
    };
    return keyboardState.isEligible || !touchState.isEligible ? keyboardState : touchState;
  }
  if (currentMs > tickTimeMs + HIT_WINDOW_MS) {
    const keyboardState: HoldInputState = {
      code,
      pressMs,
      isHeld: true,
      isEligible: false,
    };
    return touchState.isEligible ? touchState : keyboardState;
  }
  const isArmed = typeof pressMs === "number" && armedInputs.get(code) === pressMs;
  const isInTickWindow = typeof pressMs === "number" && Math.abs(pressMs - tickTimeMs) <= HIT_WINDOW_MS;
  const keyboardState: HoldInputState = {
    code,
    pressMs,
    isHeld: true,
    isEligible: isArmed || isInTickWindow,
  };
  if (keyboardState.isEligible) return keyboardState;
  return touchState.isHeld ? touchState : keyboardState;
}

function isHoldDimmed(
  note: Note,
  currentMs: number,
  pressedCodes: Set<string>,
  activeLanes: LaneConfig[],
  sourceLaneIndexById: Map<string, number>,
  keyPressTimes: Map<string, number>,
  armedInputs: Map<string, number>,
  touchInputs?: TouchHoldInputSnapshot,
) {
  const nextTickTime = getHoldDensityTimes(note).find((timeMs) => timeMs >= currentMs - HIT_WINDOW_MS) ?? getNoteEndTimeMs(note);
  const input = getHoldInputState(note, pressedCodes, activeLanes, sourceLaneIndexById, keyPressTimes, armedInputs, nextTickTime, currentMs, touchInputs);
  return note.type === "hold"
    && currentMs >= note.timeMs
    && currentMs <= getNoteEndTimeMs(note)
    && !input.isEligible;
}

function isSpacePlacementMode(mode: PlacementMode) {
  return mode === "space-left" || mode === "space-right" || mode === "space-hold";
}

function isHoldPlacementMode(mode: PlacementMode) {
  return mode === "tap-hold" || mode === "space-hold";
}

function getPlacementSpaceSide(mode: PlacementMode): SpaceSide | undefined {
  if (mode === "space-left") return "left";
  if (mode === "space-right") return "right";
  return undefined;
}

function getSpaceInputSideForCode(code: string): SpaceSide | undefined {
  if (LEFT_SPACE_INPUT_CODES.has(code)) return "left";
  if (RIGHT_SPACE_INPUT_CODES.has(code)) return "right";
  return undefined;
}

function getTouchSpaceSide(x: number): SpaceSide | undefined {
  if (x < window.innerWidth * TOUCH_LEFT_ZONE_RATIO) return "left";
  if (x > window.innerWidth * TOUCH_RIGHT_ZONE_RATIO) return "right";
  return undefined;
}

function getTouchLaneTargetFromPoint(
  x: number,
  y: number,
  laneField: HTMLDivElement | null,
  activeLanes: LaneConfig[],
) {
  if (!laneField || !activeLanes.length) return undefined;
  const fieldRect = laneField.getBoundingClientRect();
  if (x < fieldRect.left || x > fieldRect.right || y < fieldRect.top || y > fieldRect.bottom) {
    return undefined;
  }

  const laneElements = Array.from(laneField.querySelectorAll<HTMLElement>(":scope > .lane"));
  const laneIndex = laneElements.findIndex((element) => {
    const rect = element.getBoundingClientRect();
    return x >= rect.left && x <= rect.right && y >= fieldRect.top && y <= fieldRect.bottom;
  });
  if (laneIndex < 0) return undefined;
  const lane = activeLanes[laneIndex];
  return lane ? { lane, index: laneIndex } : undefined;
}

function getTouchLaneIds(touches: Map<number, TouchInputState>) {
  const laneIds = new Set<string>();
  touches.forEach((touch) => {
    if (touch.laneId) laneIds.add(touch.laneId);
  });
  return laneIds;
}

function isTouchPointerEvent(event: ReactPointerEvent<HTMLElement>) {
  return event.pointerType === "touch" || event.pointerType === "pen";
}

function isTouchUiTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest("button, input, select, textarea, a, .pause-overlay"));
}

function isSpaceTapSide(note: Note, side: SpaceSide) {
  return Boolean(note.isSpace) && note.type !== "hold" && note.spaceSide === side;
}

function getSpaceSideClass(note: Note) {
  if (!note.isSpace || note.type === "hold") return "";
  if (note.spaceSide === "left") return "space-left-note";
  if (note.spaceSide === "right") return "space-right-note";
  return "";
}

function getPlacementSpaceSideClass(mode: PlacementMode) {
  const side = getPlacementSpaceSide(mode);
  if (side === "left") return "space-left-note";
  if (side === "right") return "space-right-note";
  return "";
}

function getLaneCanvasStyle(laneCount: number, context: "play" | "editor"): CSSProperties {
  return {
    width: getLaneCanvasWidth(laneCount, context),
  };
}

function getLaneCanvasWidth(laneCount: number, context: "play" | "editor") {
  const safeLaneCount = Math.max(1, laneCount);
  const scale = safeLaneCount > FIXED_WIDTH_LANES ? 1 : safeLaneCount / FIXED_WIDTH_LANES;
  if (context === "editor") {
    return `${roundCssNumber(scale * 100)}%`;
  }
  return `min(${roundCssNumber(76 * scale)}rem, calc(${roundCssNumber(100 * scale)}vw - ${roundCssNumber(7 * scale)}rem))`;
}

function getActiveLaneSlice(lanes: LaneConfig[], laneCount: number) {
  if (!lanes.length) return [];
  const safeLaneCount = Math.min(lanes.length, clampLaneCount(laneCount));
  const startIndex = Math.floor((lanes.length - safeLaneCount) / 2);
  return lanes.slice(startIndex, startIndex + safeLaneCount);
}

function getInitialLaneCount(chart: Chart) {
  return Math.min(chart.laneCount, clampLaneCount(chart.initialLaneCount ?? chart.laneCount));
}

function getLaneCountAtTime(chart: Chart, timeMs: number) {
  const dueLaneNotes = chart.notes
    .filter((note) => isLaneNote(note) && note.timeMs <= timeMs)
    .sort((a, b) => a.timeMs - b.timeMs);
  const latestLaneNote = dueLaneNotes[dueLaneNotes.length - 1];
  return latestLaneNote ? getLaneNoteTargetCount(latestLaneNote, chart.laneCount) : getInitialLaneCount(chart);
}

function isLaneNote(note: Note) {
  return note.type === "lane";
}

function getLaneNoteTargetCount(note: Note, fallbackLaneCount: number) {
  return Math.min(fallbackLaneCount, clampLaneCount(note.targetLaneCount ?? fallbackLaneCount));
}

function getLaneEventPlacement(targetLaneCount: number, laneCount: number) {
  const safeLaneCount = Math.max(1, laneCount);
  const safeTargetCount = Math.max(1, targetLaneCount);
  return {
    left: ((safeLaneCount - safeTargetCount) / 2 / safeLaneCount) * 100,
    width: (safeTargetCount / safeLaneCount) * 100,
  };
}

function getNotePlacement(laneIndex: number, laneCount: number, span: number, isSpace: boolean, noteSize = 100) {
  const safeLaneCount = Math.max(1, laneCount);
  const safeLaneIndex = isSpace ? laneIndex : Math.max(0, laneIndex);
  if (isSpace) {
    const safeSpan = clampSpaceSpan(span);
    return {
      left: (safeLaneIndex / safeLaneCount) * 100,
      width: (safeSpan / safeLaneCount) * 100,
    };
  }
  const widthScale = Math.min(1, Math.max(0.5, noteSize / 100));
  return {
    left: ((safeLaneIndex + (1 - widthScale) / 2) / safeLaneCount) * 100,
    width: (widthScale / safeLaneCount) * 100,
  };
}

function getSpacePlacementFromStartIndex(startIndex: number, laneCount: number, span: number) {
  const safeLaneCount = Math.max(1, laneCount);
  return {
    left: (startIndex / safeLaneCount) * 100,
    width: (span / safeLaneCount) * 100,
  };
}

interface SpaceProjection {
  startIndex: number;
  span: number;
  judgeStartIndex: number;
  judgeSpan: number;
  isJudgeable: boolean;
}

function getSpaceProjection(
  note: Note,
  lanes: LaneConfig[],
  sourceLaneIndexById: Map<string, number>,
): SpaceProjection {
  const laneCount = lanes.length;
  const sourceAnchorIndex = getSpaceLocalStartIndex(note, lanes, sourceLaneIndexById);
  const sourceSpan = clampSpaceSpan(note.span ?? 1);
  const sourceStartIndex = sourceAnchorIndex;
  const visualStartIndex = sourceStartIndex;
  const visualEndIndex = sourceStartIndex + sourceSpan;
  const sourceOverlapStart = Math.max(0, sourceStartIndex);
  const sourceOverlapEnd = Math.min(laneCount, sourceStartIndex + sourceSpan);
  const isJudgeable = sourceOverlapEnd > sourceOverlapStart;

  if (!isJudgeable) {
    return {
      startIndex: visualStartIndex,
      span: Math.max(0.25, visualEndIndex - visualStartIndex),
      judgeStartIndex: 0,
      judgeSpan: 0,
      isJudgeable: false,
    };
  }

  return {
    startIndex: visualStartIndex,
    span: Math.max(0.25, visualEndIndex - visualStartIndex),
    judgeStartIndex: sourceOverlapStart,
    judgeSpan: sourceOverlapEnd - sourceOverlapStart,
    isJudgeable: true,
  };
}

function getBurstProjection(
  burst: JudgeBurst,
  lanes: LaneConfig[],
  sourceLaneIndexById: Map<string, number>,
) {
  if (burst.span > 1 || burst.anchorLaneIndex !== undefined) {
    const projection = getSpaceProjection(
      { id: burst.id, timeMs: 0, laneId: burst.laneId, type: "tap", isSpace: true, span: burst.span, anchorLaneIndex: burst.anchorLaneIndex },
      lanes,
      sourceLaneIndexById,
    );
    return {
      startIndex: projection.judgeStartIndex,
      span: projection.judgeSpan,
    };
  }
  const sourceIndex = lanes.findIndex((lane) => lane.id === burst.laneId);
  return {
    startIndex: sourceIndex >= 0 ? sourceIndex : sourceLaneIndexById.get(burst.laneId) ?? getLaneIndexFromId(burst.laneId),
    span: 1,
  };
}

function getNoteAnchorIndex(note: Note, laneIndexById?: Map<string, number>) {
  if (note.isSpace && typeof note.anchorLaneIndex === "number") return note.anchorLaneIndex;
  if (note.isSpace) return getLanePhysicalIndexFromId(note.laneId);
  return laneIndexById?.get(note.laneId) ?? getLanePhysicalIndexFromId(note.laneId);
}

function getNoteLocalLaneIndex(note: Note, lanes: LaneConfig[], laneIndexById: Map<string, number>) {
  if (isLaneNote(note)) return (lanes.length - getLaneNoteTargetCount(note, lanes.length)) / 2;
  if (note.isSpace) return getSpaceLocalStartIndex(note, lanes, laneIndexById);
  return laneIndexById.get(note.laneId) ?? 0;
}

function getLaneIndexFromId(laneId: string) {
  const match = /^lane-(\d+)$/.exec(laneId);
  return match ? Math.max(0, Number(match[1]) - 1) : 0;
}

function getLanePhysicalIndex(lane: LaneConfig | undefined) {
  return lane ? getPlayableCodeIndex(lane.keyCodes[0]) : -1;
}

function getLanePhysicalIndexFromId(laneId: string) {
  const code = laneId.replace(/^lane-/, "");
  const index = getPlayableCodeIndex(code);
  return index >= 0 ? index : getLaneIndexFromId(laneId);
}

function getLanePhysicalStartIndex(lanes: LaneConfig[]) {
  return getLanePhysicalIndex(lanes[0]);
}

function getSpaceLocalStartIndex(note: Note, lanes: LaneConfig[], laneIndexById?: Map<string, number>) {
  const physicalStart = getNoteAnchorIndex(note, laneIndexById);
  return physicalStart - getLanePhysicalStartIndex(lanes);
}

function spaceStartHasOverlap(physicalStartIndex: number, span: number, lanes: LaneConfig[]) {
  const localStartIndex = physicalStartIndex - getLanePhysicalStartIndex(lanes);
  return getSpaceOverlapFromStart(localStartIndex, span, lanes.length) > 0;
}

function getSpaceOverlapFromStart(startIndex: number, span: number, laneCount: number) {
  const safeSpan = clampSpaceSpan(span);
  const overlapStart = Math.max(0, startIndex);
  const overlapEnd = Math.min(laneCount, startIndex + safeSpan);
  return Math.max(0, overlapEnd - overlapStart);
}

function roundCssNumber(value: number) {
  return Number(value.toFixed(3));
}

function clampSpaceSpan(value: number) {
  return Math.min(10, Math.max(1, Math.round(value)));
}

function clampHoldDurationMs(value: number) {
  return Math.min(8000, Math.max(1, Math.round(Number.isFinite(value) ? value : DEFAULT_HOLD_DURATION_MS)));
}

function clampHoldDensity(value: number) {
  return Math.min(64, Math.max(1, Math.round(Number.isFinite(value) ? value : DEFAULT_HOLD_DENSITY)));
}

function makeLaneTemplate(lanes: LaneConfig[]) {
  return lanes.map((lane) => `${lane.widthUnits}fr`).join(" ");
}

function applyJudge(stats: PlayStats, result: JudgeResult, scoreUnit: number): PlayStats {
  return applyJudges(stats, [result], scoreUnit);
}

function applyJudges(stats: PlayStats, results: JudgeResult[], scoreUnit: number): PlayStats {
  return results.reduce((nextStats, result) => {
    const weight = result === "great" ? 1 : result === "good" ? 0.5 : 0;
    const combo = result === "miss" || result === "bad" ? 0 : nextStats.combo + 1;

    return {
      ...nextStats,
      score: Math.min(MAX_SCORE, nextStats.score + weight * scoreUnit),
      combo,
      maxCombo: Math.max(nextStats.maxCombo, combo),
      great: nextStats.great + (result === "great" ? 1 : 0),
      good: nextStats.good + (result === "good" ? 1 : 0),
      bad: nextStats.bad + (result === "bad" ? 1 : 0),
      miss: nextStats.miss + (result === "miss" ? 1 : 0),
    };
  }, stats);
}

function formatScore(score: number) {
  const digits = String(MAX_SCORE).length;
  return String(Math.min(MAX_SCORE, Math.max(0, Math.round(score)))).padStart(digits, "0");
}

function getAccuracy(stats: PlayStats) {
  const total = stats.great + stats.good + stats.bad + stats.miss;
  if (!total) return 100;
  return ((stats.great + stats.good * 0.62 + stats.bad * 0.24) / total) * 100;
}

function countScoringJudgements(chart: Chart) {
  const sourceLaneIndexById = new Map(chart.lanes.map((lane, index) => [lane.id, index]));
  return chart.notes.reduce((total, note) => {
    if (isLaneNote(note)) return total;
    const judgeTimes = note.type === "hold" ? getHoldDensityTimes(note) : [note.timeMs];
    return total + judgeTimes.filter((timeMs) => isNoteJudgeableAtTime(chart, note, timeMs, sourceLaneIndexById)).length;
  }, 0);
}

function isNoteJudgeableAtTime(
  chart: Chart,
  note: Note,
  timeMs: number,
  sourceLaneIndexById: Map<string, number>,
) {
  const activeLanesAtTime = getActiveLaneSlice(chart.lanes, getLaneCountAtTime(chart, timeMs));
  if (!isNoteVisibleOnLanes(note, activeLanesAtTime)) return false;
  if (note.isSpace) {
    return getSpaceProjection(note, activeLanesAtTime, sourceLaneIndexById).isJudgeable;
  }
  return activeLanesAtTime.some((lane) => lane.id === note.laneId);
}

function showJudgeBurst(
  note: Note,
  result: JudgeResult,
  setter: (value: JudgeBurst[] | ((previous: JudgeBurst[]) => JudgeBurst[])) => void,
) {
  const burst: JudgeBurst = {
    id: `${note.id}-${result}-${performance.now()}`,
    result,
    laneId: note.laneId,
    span: note.isSpace ? clampSpaceSpan(note.span ?? 1) : 1,
    anchorLaneIndex: note.anchorLaneIndex,
    spaceSide: note.spaceSide,
  };
  setter((previous) => [...previous.slice(-6), burst]);
  window.setTimeout(() => {
    setter((previous) => previous.filter((item) => item.id !== burst.id));
  }, 520);
}

function showJudgeBursts(
  results: Array<{ note: Note; result: JudgeResult }>,
  setter: (value: JudgeBurst[] | ((previous: JudgeBurst[]) => JudgeBurst[])) => void,
) {
  if (!results.length) return;
  const now = performance.now();
  const bursts = results.map(({ note, result }, index): JudgeBurst => ({
    id: `${note.id}-${result}-${now}-${index}`,
    result,
    laneId: note.laneId,
    span: note.isSpace ? clampSpaceSpan(note.span ?? 1) : 1,
    anchorLaneIndex: note.anchorLaneIndex,
    spaceSide: note.spaceSide,
  }));
  setter((previous) => [...previous, ...bursts].slice(-6));
  window.setTimeout(() => {
    const ids = new Set(bursts.map((burst) => burst.id));
    setter((previous) => previous.filter((item) => !ids.has(item.id)));
  }, 520);
}

function getSpannedLaneIds(note: Note, lanes: LaneConfig[], laneIndexById: Map<string, number>) {
  const projection = getSpaceProjection(note, lanes, laneIndexById);
  if (!projection.isJudgeable) return [];
  return lanes
    .slice(projection.judgeStartIndex, projection.judgeStartIndex + projection.judgeSpan)
    .map((lane) => lane.id);
}

function normalizeKeyboardEventCode(event: KeyboardEvent) {
  if (/^Key[a-z]$/.test(event.code)) return `Key${event.code.slice(3).toUpperCase()}`;
  if (event.code && event.code !== "Unidentified") return event.code;
  if (event.key === " ") return "Space";
  if (event.key === "Escape") return "Escape";
  if (event.key === ";") return "Semicolon";
  if (/^[a-z]$/i.test(event.key)) return `Key${event.key.toUpperCase()}`;
  return event.code || event.key;
}

function getPressedLaneFeedback(
  pressedCodes: Set<string>,
  lanes: LaneConfig[],
  extraLaneIds: string[],
) {
  const activeLaneIds = new Set<string>();
  lanes.forEach((lane) => {
    if (lane.keyCodes.some((code) => pressedCodes.has(code))) {
      activeLaneIds.add(lane.id);
    }
  });
  extraLaneIds.forEach((laneId) => activeLaneIds.add(laneId));
  return activeLaneIds;
}

function getPressedSpaceSideFeedback(
  pressedCodes: Set<string>,
  activeTouches: Map<number, TouchInputState>,
) {
  const activeSides = new Set<SpaceSide>();
  pressedCodes.forEach((code) => {
    const side = getSpaceInputSideForCode(code);
    if (side) activeSides.add(side);
  });
  activeTouches.forEach((touch) => {
    if (touch.laneId) return;
    const side = getTouchSpaceSide(touch.x);
    if (side) activeSides.add(side);
  });
  return activeSides;
}

function getSnapMs(bpm: number, division: number) {
  return 60_000 / sanitizeBpm(bpm) / Math.max(1, division);
}

function snapTime(timeMs: number, snapMs: number, durationMs: number) {
  const snapped = Math.round(timeMs / snapMs) * snapMs;
  return Math.max(0, Math.min(durationMs, Math.round(snapped)));
}

function formatTime(timeMs: number) {
  const totalSeconds = Math.max(0, Math.floor(timeMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const milliseconds = Math.floor((Math.max(0, timeMs) % 1000) / 10);
  return `${minutes}:${seconds.toString().padStart(2, "0")}.${milliseconds.toString().padStart(2, "0")}`;
}

function getMedian(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

interface ChartKeySoundEvent {
  id: string;
  timeMs: number;
  laneIndex: number;
  isSpace: boolean;
}

function playHitKeySound(note: Note, lanes: LaneConfig[], laneIndexById: Map<string, number>, volume: number) {
  const laneIndex = getKeySoundLaneIndex(note, lanes, laneIndexById);
  if (laneIndex === undefined) return;
  playKeySound(laneIndex, Boolean(note.isSpace), volume);
}

function playHitKeySoundOnce(
  note: Note,
  lanes: LaneConfig[],
  laneIndexById: Map<string, number>,
  volume: number,
  playedKeys: Set<string>,
) {
  const laneIndex = getKeySoundLaneIndex(note, lanes, laneIndexById);
  if (laneIndex === undefined) return;
  const key = `${laneIndex}:${Boolean(note.isSpace)}`;
  if (playedKeys.has(key)) return;
  playedKeys.add(key);
  playKeySound(laneIndex, Boolean(note.isSpace), volume);
}

function scheduleChartKeySounds(
  notes: Note[],
  lanes: LaneConfig[],
  laneIndexById: Map<string, number>,
  currentMs: number,
  offsetMs: number,
  volume: number,
  scheduledIds: Set<string>,
) {
  const safeVolume = Math.max(0, Math.min(2.5, volume));
  if (safeVolume <= 0 || !notes.length || !lanes.length) return;

  const context = getKeySoundAudioContext();
  const windowEndMs = currentMs + KEY_SOUND_LOOKAHEAD_MS;
  getChartKeySoundEvents(notes, lanes, laneIndexById, currentMs - offsetMs, windowEndMs - offsetMs).forEach((event) => {
    const scheduledMs = event.timeMs + offsetMs;
    if (scheduledIds.has(event.id) || scheduledMs < currentMs || scheduledMs > windowEndMs) return;

    if (!context) {
      if (scheduledMs <= currentMs + 16) {
        scheduledIds.add(event.id);
        playKeySound(event.laneIndex, event.isSpace, safeVolume);
      }
      return;
    }

    scheduledIds.add(event.id);
    const delaySeconds = Math.max(0, (scheduledMs - currentMs) / 1000);
    playKeySound(event.laneIndex, event.isSpace, safeVolume, context.currentTime + delaySeconds);
  });
}

function getChartKeySoundEvents(
  notes: Note[],
  lanes: LaneConfig[],
  laneIndexById: Map<string, number>,
  startMs = Number.NEGATIVE_INFINITY,
  endMs = Number.POSITIVE_INFINITY,
): ChartKeySoundEvent[] {
  return notes.flatMap((note) => {
    if (isLaneNote(note)) return [];
    if (note.type === "hold" && (getNoteEndTimeMs(note) < startMs || note.timeMs > endMs)) return [];
    if (note.type !== "hold" && (note.timeMs < startMs || note.timeMs > endMs)) return [];
    const laneIndex = getKeySoundLaneIndex(note, lanes, laneIndexById);
    if (laneIndex === undefined) return [];
    if (note.type === "hold") {
      const events: ChartKeySoundEvent[] = [];
      getHoldDensityTimes(note).forEach((timeMs, tickIndex) => {
        if (timeMs < startMs || timeMs > endMs) return;
        events.push({
          id: getHoldTickId(note, tickIndex),
          timeMs,
          laneIndex,
          isSpace: Boolean(note.isSpace),
        });
      });
      return events;
    }
    return [{
      id: `${note.id}:tap`,
      timeMs: note.timeMs,
      laneIndex,
      isSpace: Boolean(note.isSpace),
    }];
  });
}

function getKeySoundLaneIndex(note: Note, lanes: LaneConfig[], laneIndexById: Map<string, number>) {
  if (note.isSpace) {
    const projection = getSpaceProjection(note, lanes, laneIndexById);
    if (!projection.isJudgeable) return undefined;
    return Math.min(
      lanes.length - 1,
      Math.max(0, projection.judgeStartIndex + Math.floor(Math.max(1, projection.judgeSpan) / 2)),
    );
  }
  const laneIndex = lanes.findIndex((lane) => lane.id === note.laneId);
  return laneIndex >= 0 ? laneIndex : undefined;
}

function playKeySound(laneIndex: number, isSpace = false, volume = 1, scheduledTime?: number) {
  const safeVolume = Math.max(0, Math.min(2.5, volume));
  if (safeVolume <= 0) return;
  const context = getKeySoundAudioContext();
  if (!context) {
    playFallbackKeySound(laneIndex, isSpace, safeVolume);
    return;
  }

  markKeySoundBackend("web-audio");
  const now = Math.max(context.currentTime, scheduledTime ?? context.currentTime);
  const mainGain = context.createGain();
  const filter = context.createBiquadFilter();
  const oscillator = context.createOscillator();
  const click = context.createOscillator();
  const clickGain = context.createGain();
  const baseFrequency = isSpace ? 180 : 360;

  filter.type = "lowpass";
  filter.frequency.setValueAtTime(1200, now);
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(baseFrequency, now);
  oscillator.frequency.exponentialRampToValueAtTime(baseFrequency * 1.12, now + 0.075);
  click.type = "square";
  click.frequency.setValueAtTime(860, now);

  mainGain.gain.setValueAtTime(0.0001, now);
  mainGain.gain.exponentialRampToValueAtTime(0.42 * safeVolume, now + 0.008);
  mainGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
  clickGain.gain.setValueAtTime(0.11 * safeVolume, now);
  clickGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.025);

  oscillator.connect(filter);
  filter.connect(mainGain);
  mainGain.connect(context.destination);
  click.connect(clickGain);
  clickGain.connect(context.destination);
  oscillator.start(now);
  click.start(now);
  oscillator.stop(now + 0.22);
  click.stop(now + 0.035);
}

function getKeySoundContext(AudioContextConstructor: typeof AudioContext) {
  const globalWindow = window as Window & { __keyboardBeatAudioContext?: AudioContext };
  if (!globalWindow.__keyboardBeatAudioContext) {
    globalWindow.__keyboardBeatAudioContext = new AudioContextConstructor();
  }
  const context = globalWindow.__keyboardBeatAudioContext;
  if (context.state === "suspended") {
    void context.resume();
  }
  return context;
}

function getKeySoundAudioContext() {
  const audioWindow = window as Window & { webkitAudioContext?: typeof AudioContext };
  const AudioContextConstructor = window.AudioContext || audioWindow.webkitAudioContext;
  if (!AudioContextConstructor) return undefined;
  return getKeySoundContext(AudioContextConstructor);
}

function clampMusicVolume(volume: number) {
  return Math.max(0, Math.min(1, volume));
}

function unlockAudioForPlayback(audio: HTMLAudioElement | null, volume: number) {
  const context = getKeySoundAudioContext();
  if (context?.state === "suspended") {
    void context.resume();
  }
  if (!audio) return;
  const gain = setupMusicGainForAudio(audio, volume);
  setAudioOutputVolume(audio, gain ?? null, volume);
}

function setupMusicGainForAudio(audio: HTMLAudioElement, volume: number) {
  const context = getKeySoundAudioContext();
  if (!context) {
    setAudioOutputVolume(audio, null, volume);
    return undefined;
  }

  const musicWindow = window as MusicGainWindow;
  if (!musicWindow.__spaceholderMusicGainChains) {
    musicWindow.__spaceholderMusicGainChains = new WeakMap();
  }

  const cached = musicWindow.__spaceholderMusicGainChains.get(audio);
  if (cached) {
    setAudioOutputVolume(audio, cached.gain, volume);
    return cached.gain;
  }

  try {
    const source = context.createMediaElementSource(audio);
    const gain = context.createGain();
    source.connect(gain);
    gain.connect(context.destination);
    musicWindow.__spaceholderMusicGainChains.set(audio, { source, gain });
    setAudioOutputVolume(audio, gain, volume);
    return gain;
  } catch {
    setAudioOutputVolume(audio, null, volume);
    return undefined;
  }
}

function setAudioOutputVolume(audio: HTMLAudioElement | null, gain: GainNode | null, volume: number) {
  const safeVolume = clampMusicVolume(volume);
  if (gain) {
    const context = gain.context;
    gain.gain.setTargetAtTime(safeVolume, context.currentTime, 0.012);
    if (audio) audio.volume = 1;
    return;
  }
  if (audio) audio.volume = safeVolume;
}

function playFallbackKeySound(laneIndex: number, isSpace = false, volume = 1) {
  const audio = new Audio(getFallbackKeySoundUrl(laneIndex, isSpace));
  const debugWindow = window as Window & { __keyboardBeatFallbackKeyCount?: number };
  debugWindow.__keyboardBeatFallbackKeyCount = (debugWindow.__keyboardBeatFallbackKeyCount ?? 0) + 1;
  markKeySoundBackend("html-audio");
  audio.volume = Math.max(0, Math.min(1, 0.82 * volume));
  void audio.play().catch(() => undefined);
}

function markKeySoundBackend(backend: "web-audio" | "html-audio") {
  const root = document.documentElement;
  const count = Number(root.dataset.keySoundCount ?? "0") + 1;
  root.dataset.keySoundBackend = backend;
  root.dataset.keySoundCount = String(count);
}

function getFallbackKeySoundUrl(laneIndex: number, isSpace = false) {
  const key = `${isSpace ? "space" : "lane"}-${laneIndex}`;
  const cacheWindow = window as Window & { __keyboardBeatFallbackKeyCache?: Map<string, string> };
  if (!cacheWindow.__keyboardBeatFallbackKeyCache) {
    cacheWindow.__keyboardBeatFallbackKeyCache = new Map();
  }
  const cached = cacheWindow.__keyboardBeatFallbackKeyCache.get(key);
  if (cached) return cached;

  const sampleRate = 22050;
  const durationSeconds = 0.12;
  const sampleCount = Math.floor(sampleRate * durationSeconds);
  const pcm = new Int16Array(sampleCount);
  const baseFrequency = isSpace ? 180 : 360;

  for (let index = 0; index < sampleCount; index += 1) {
    const t = index / sampleRate;
    const envelope = Math.exp(-t * 24);
    const tone = Math.sin(Math.PI * 2 * baseFrequency * t);
    const click = Math.sin(Math.PI * 2 * 860 * t) * Math.max(0, 1 - t / 0.025);
    pcm[index] = Math.max(-1, Math.min(1, tone * envelope * 0.68 + click * 0.28)) * 32767;
  }

  const url = `data:audio/wav;base64,${encodeWavBase64(pcm, sampleRate)}`;
  cacheWindow.__keyboardBeatFallbackKeyCache.set(key, url);
  return url;
}

function encodeWavBase64(samples: Int16Array, sampleRate: number) {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  writeAscii(bytes, 0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(bytes, 8, "WAVE");
  writeAscii(bytes, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(bytes, 36, "data");
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, index) => view.setInt16(44 + index * 2, sample, true));

  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function writeAscii(bytes: Uint8Array, offset: number, text: string) {
  for (let index = 0; index < text.length; index += 1) {
    bytes[offset + index] = text.charCodeAt(index);
  }
}

function prepareChartForExport(chart: Chart): Chart {
  const timingGroups = normalizeTimingGroups(chart.timingGroups);
  const validTimingGroupIds = new Set(timingGroups.map((group) => group.id));
  return {
    ...chart,
    meta: {
      ...chart.meta,
      audioUrl: normalizeExportUrl(chart.meta.audioUrl),
      coverUrl: normalizeExportUrl(chart.meta.coverUrl),
    },
    notes: assignDefaultTimingGroup(chart.notes).map((note) => ({
      ...note,
      timingGroupId: validTimingGroupIds.has(note.timingGroupId ?? "") ? note.timingGroupId : DEFAULT_TIMING_GROUP_ID,
    })),
    timingGroups,
  };
}

function normalizeImportedChart(parsed: Chart): { chart?: Chart; error?: string } {
  const parsedLaneCount = parsed.laneCount;
  const parsedInitialLaneCount = parsed.initialLaneCount;
  const isEvenLaneChart = parsedLaneCount >= 2
    && parsedLaneCount <= 10
    && parsedLaneCount % 2 === 0
    && parsedInitialLaneCount >= 2
    && parsedInitialLaneCount <= parsedLaneCount
    && parsedInitialLaneCount % 2 === 0
    && parsed.lanes.length === parsedLaneCount;

  if (!isEvenLaneChart) {
    return { error: "导入失败：当前只接受 2-10 的偶数轨谱面，并需要合法初始轨道" };
  }

  const parsedTimingGroups = normalizeTimingGroups(parsed.timingGroups);
  const validTimingGroupIds = new Set(parsedTimingGroups.map((group) => group.id));
  const normalizedNotes = assignDefaultTimingGroup(parsed.notes).map((note) => {
    const timingGroupId = validTimingGroupIds.has(note.timingGroupId ?? "") ? note.timingGroupId : DEFAULT_TIMING_GROUP_ID;
    return isLaneNote(note)
      ? { ...note, timingGroupId, targetLaneCount: Math.min(parsedLaneCount, clampLaneCount(note.targetLaneCount ?? parsedInitialLaneCount)) }
      : { ...note, timingGroupId };
  });

  return {
    chart: {
      ...parsed,
      notes: normalizedNotes,
      timingGroups: parsedTimingGroups,
    },
  };
}

type WritableFileHandle = {
  name?: string;
  getFile: () => Promise<File>;
  createWritable: () => Promise<{
    write: (data: Blob) => Promise<void>;
    close: () => Promise<void>;
  }>;
};

type DirectoryHandle = {
  name?: string;
  entries?: () => AsyncIterableIterator<[string, FileSystemEntryHandle]>;
  values?: () => AsyncIterableIterator<FileSystemEntryHandle>;
  [Symbol.asyncIterator]?: () => AsyncIterableIterator<FileSystemEntryHandle>;
  getFileHandle: (name: string, options?: { create?: boolean }) => Promise<WritableFileHandle>;
};

type FileSystemEntryHandle = WritableFileHandle | DirectoryHandle;

interface PackageFileEntry {
  name: string;
  file: File;
  handle?: WritableFileHandle;
}

interface PackageAssets {
  audioUrl?: string;
  audioFileName?: string;
  coverUrl?: string;
  coverFileName?: string;
}

type FileSavePicker = (options?: {
  suggestedName?: string;
  types?: Array<{
    description: string;
    accept: Record<string, string[]>;
  }>;
}) => Promise<WritableFileHandle>;

type FileOpenPicker = (options?: {
  multiple?: boolean;
  types?: Array<{
    description: string;
    accept: Record<string, string[]>;
  }>;
}) => Promise<WritableFileHandle[]>;

type DirectoryPicker = (options?: { mode?: "read" | "readwrite" }) => Promise<DirectoryHandle>;

async function saveJsonFile(json: string, fileName: string) {
  const savePicker = (window as Window & { showSaveFilePicker?: FileSavePicker }).showSaveFilePicker;
  if (savePicker) {
    const handle = await savePicker({
      suggestedName: fileName,
      types: [{
        description: "Chart JSON",
        accept: { "application/json": [".json"] },
      }],
    });
    await writeJsonToHandle(handle, json);
    return { method: "picker" as const, handle };
  }

  downloadJsonFile(json, fileName);
  return { method: "download" as const };
}

async function writeJsonToHandle(handle: WritableFileHandle, json: string) {
  const writable = await handle.createWritable();
  await writable.write(new Blob([json], { type: "application/json" }));
  await writable.close();
}

async function readDirectoryFiles(directoryHandle: DirectoryHandle): Promise<PackageFileEntry[]> {
  const entries: PackageFileEntry[] = [];
  if (directoryHandle.entries) {
    for await (const [name, handle] of directoryHandle.entries()) {
      if (!isFileHandle(handle)) continue;
      const file = await handle.getFile();
      entries.push({ name, file, handle });
    }
    return entries;
  }

  const iterable = directoryHandle.values?.() ?? directoryHandle[Symbol.asyncIterator]?.();
  if (iterable) {
    for await (const handle of iterable) {
      if (!isFileHandle(handle)) continue;
      const file = await handle.getFile();
      entries.push({ name: handle.name ?? file.name, file, handle });
    }
  }
  return entries;
}

function isFileHandle(handle: FileSystemEntryHandle): handle is WritableFileHandle {
  return typeof (handle as WritableFileHandle).getFile === "function";
}

function pickChartEntry(entries: PackageFileEntry[]) {
  return entries
    .filter((entry) => entry.name.toLowerCase().endsWith(".json"))
    .sort((a, b) => scoreChartFileName(b.name) - scoreChartFileName(a.name) || a.name.localeCompare(b.name))[0];
}

function pickAudioEntry(entries: PackageFileEntry[], preferredName?: string) {
  return pickPreferredEntry(entries.filter((entry) => isAudioFileName(entry.name)), preferredName);
}

function pickArtworkEntry(entries: PackageFileEntry[], preferredName?: string) {
  return pickPreferredEntry(entries.filter((entry) => isImageFileName(entry.name)), preferredName);
}

function pickPreferredEntry(entries: PackageFileEntry[], preferredName?: string) {
  if (!entries.length) return undefined;
  const normalizedPreferred = preferredName?.toLowerCase();
  if (normalizedPreferred) {
    const exact = entries.find((entry) => entry.name.toLowerCase() === normalizedPreferred);
    if (exact) return exact;
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name))[0];
}

function scoreChartFileName(name: string) {
  const lower = name.toLowerCase();
  if (lower === "chart.json") return 5;
  if (lower.includes("chart")) return 4;
  if (lower.includes("谱面")) return 3;
  return 1;
}

function isAudioFileName(name: string) {
  return /\.(mp3|wav|ogg|m4a|aac|flac|webm|mov|mp4)$/i.test(name);
}

function isImageFileName(name: string) {
  return /\.(png|jpe?g|webp|gif|bmp)$/i.test(name);
}

function createPackageObjectUrl(file: File, store: string[]) {
  const url = URL.createObjectURL(file);
  store.push(url);
  return url;
}

function stripFileExtension(name: string) {
  return name.replace(/\.[^.]+$/, "");
}

function downloadJsonFile(json: string, fileName: string) {
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  window.setTimeout(() => {
    link.remove();
    URL.revokeObjectURL(url);
  }, 30_000);
}

function normalizeExportUrl(url?: string) {
  return url?.startsWith("blob:") ? undefined : url;
}

function readFileAsDataUrl(file: File) {
  return blobToDataUrl(file);
}

async function readEmbeddedArtwork(file: File) {
  try {
    const { parseBlob, selectCover } = await import("music-metadata-browser");
    const metadata = await parseBlob(file, { duration: false });
    const cover = selectCover(metadata.common.picture);
    if (!cover) return undefined;
    return blobToDataUrl(new Blob([cover.data], { type: cover.format }));
  } catch {
    return undefined;
  }
}

function readAudioDurationMs(audioUrl: string) {
  return new Promise<number>((resolve, reject) => {
    const audio = new Audio();
    audio.preload = "metadata";
    audio.addEventListener("loadedmetadata", () => {
      const durationMs = Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : 90_000;
      resolve(Math.max(10_000, durationMs));
    }, { once: true });
    audio.addEventListener("error", () => reject(new Error("Failed to read audio metadata")), { once: true });
    audio.src = audioUrl;
  });
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result ?? "")));
    reader.addEventListener("error", () => reject(reader.error ?? new Error("Failed to read file")));
    reader.readAsDataURL(blob);
  });
}

function sanitizeFileName(name: string) {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim() || "chart";
}

function parseAudioFileName(name: string) {
  const baseName = name.replace(/\.[^.]+$/, "").trim();
  const separatorIndex = baseName.indexOf("-");

  if (separatorIndex <= 0 || separatorIndex >= baseName.length - 1) {
    return { title: baseName || "Untitled Track", artist: undefined };
  }

  return {
    artist: baseName.slice(0, separatorIndex).trim() || undefined,
    title: baseName.slice(separatorIndex + 1).trim() || baseName,
  };
}

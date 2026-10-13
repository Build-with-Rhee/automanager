export type SessionStatus =
  "recording" | "paused" | "completed" | "interrupted";
export type StepKind =
  | "click"
  | "double-click"
  | "drag"
  | "scroll"
  | "shortcut"
  | "comment"
  | "gap"
  | "system";
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Session {
  id: string;
  title: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
  status: SessionStatus;
  stepCount: number;
  audioCount: number;
  audio: boolean;
  screen: boolean;
}
export interface Step {
  id: string;
  sessionId: string;
  sequence: number;
  timestamp: number;
  offsetMs: number;
  kind: StepKind;
  description: string;
  appName: string;
  windowTitle: string;
  screenshot: string | null;
  x?: number;
  y?: number;
  rect?: Rect;
  warning?: string;
}
export interface AudioChunk {
  id: string;
  sessionId: string;
  sequence: number;
  file: string;
  startedAt: number;
  offsetMs: number;
  durationMs: number;
  sampleCount: number;
  transcript: string;
  status: "saved" | "queued" | "processing" | "done" | "failed";
}
export type JobStatus =
  "queued" | "running" | "completed" | "failed" | "canceled";
export interface Job {
  id: string;
  sessionId: string | null;
  chunkId: string | null;
  kind: "stt" | "tts";
  status: JobStatus;
  progress: number;
  createdAt: number;
  updatedAt: number;
  error: string | null;
  text: string;
  modelId: string;
  output: string | null;
  generation: number;
}
export interface Settings {
  audioEnabled: boolean;
  screenEnabled: boolean;
  chunkSeconds: 15 | 30 | 60 | 120;
  screenshotLimit: number;
  monitorId: string;
  micDeviceId: string;
  language: string;
  autoTranscribe: boolean;
  whisperModel: string;
  launchOnLogin: boolean;
  preventSleep: boolean;
  storageLimitGiB: number;
}
export interface Schedule {
  id: string;
  title: string;
  enabled: boolean;
  startTime: string;
  durationMinutes: number;
  days: number[];
  nextRun: number;
  lastRun: number | null;
}
export interface ModelInfo {
  id: string;
  name: string;
  kind: "stt" | "tts";
  engine: string;
  languages: string[];
  license: string;
  sizeBytes: number;
  status: "missing" | "downloading" | "ready" | "error";
  progress: number;
  error?: string;
}
export interface Capability {
  name: string;
  supported: boolean;
  detail: string;
}
export interface DisplaySource {
  id: string;
  name: string;
  displayId: string;
  thumbnail?: string;
}
export interface SessionDetail {
  session: Session;
  steps: Step[];
  chunks: AudioChunk[];
  jobs: Job[];
}
export interface AppSnapshot {
  sessions: Session[];
  activeSession: Session | null;
  jobs: Job[];
  settings: Settings;
  schedules: Schedule[];
  models: ModelInfo[];
  capabilities: Capability[];
  recordingError: string | null;
  dataDirectory: string;
}
export interface StartOptions {
  title?: string;
  audio: boolean;
  screen: boolean;
}
export interface SynthOptions {
  text: string;
  voiceId: string;
  speed: number;
}
export interface DesktopAPI {
  snapshot(): Promise<AppSnapshot>;
  startSession(options: StartOptions): Promise<Session>;
  pauseSession(): Promise<void>;
  resumeSession(): Promise<void>;
  stopSession(): Promise<void>;
  getSession(id: string): Promise<SessionDetail>;
  renameSession(id: string, title: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
  exportSession(id: string): Promise<string | null>;
  addComment(sessionId: string, text: string, rect?: Rect): Promise<void>;
  selectCommentRegion(): Promise<Rect | null>;
  updateSettings(settings: Partial<Settings>): Promise<void>;
  listDisplays(): Promise<DisplaySource[]>;
  installModel(id: string): Promise<void>;
  importModel(id: string): Promise<void>;
  configureEngine(engine: string): Promise<void>;
  transcribe(sessionId: string): Promise<void>;
  synthesize(input: SynthOptions): Promise<Job>;
  jobAction(id: string, action: "cancel" | "retry"): Promise<void>;
  saveSchedule(
    schedule: Omit<Schedule, "id" | "lastRun"> & { id?: string },
  ): Promise<void>;
  deleteSchedule(id: string): Promise<void>;
  revealData(): Promise<void>;
  onState(callback: (state: AppSnapshot) => void): () => void;
  minimize(): void;
  maximize(): void;
  closeWindow(): void;
  assetUrl(sessionId: string, file: string): string;
}
export interface RecordedAction {
  kind: StepKind;
  description: string;
  appName: string;
  windowTitle: string;
  timestamp: number;
  x?: number;
  y?: number;
  warning?: string;
  eventId?: string;
}
export interface StoreSnapshot {
  sessions: Session[];
  jobs: Job[];
  settings: Settings;
  schedules: Schedule[];
}
export interface AppendStepInput {
  sessionId: string;
  kind: StepKind;
  description: string;
  appName?: string;
  windowTitle?: string;
  timestamp: number;
  offsetMs: number;
  x?: number;
  y?: number;
  rect?: Rect;
  warning?: string;
  screenshot?: Uint8Array;
}
export interface AppendAudioInput {
  sessionId: string;
  pcm: Uint8Array;
  startedAt: number;
  offsetMs: number;
}
export interface StoreAPI {
  snapshot(): Promise<StoreSnapshot>;
  createSession(options: StartOptions): Promise<Session>;
  transition(
    id: string,
    status: SessionStatus,
    durationMs: number,
  ): Promise<Session>;
  getSession(id: string): Promise<SessionDetail>;
  renameSession(id: string, title: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
  appendStep(input: AppendStepInput): Promise<Step>;
  appendAudio(input: AppendAudioInput): Promise<AudioChunk[]>;
  flushAudio(id: string): Promise<AudioChunk[]>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  createJob(input: {
    sessionId: string | null;
    chunkId: string | null;
    kind: "stt" | "tts";
    text: string;
    modelId: string;
  }): Promise<Job>;
  updateJob(
    id: string,
    patch: Partial<
      Pick<Job, "status" | "progress" | "error" | "output" | "text">
    >,
    generation?: number,
  ): Promise<Job | null>;
  updateChunk(
    id: string,
    patch: Partial<Pick<AudioChunk, "transcript" | "status">>,
    guard?: { jobId: string; generation: number },
  ): Promise<void>;
  saveSchedule(
    schedule: Omit<Schedule, "id"> & { id?: string },
  ): Promise<Schedule>;
  deleteSchedule(id: string): Promise<void>;
  exportSession(id: string, destination: string): Promise<void>;
  resolveAsset(sessionId: string, file: string): Promise<string>;
  importOutput(
    jobId: string,
    source: string,
    generation?: number,
  ): Promise<string>;
  close(): Promise<void>;
}
export const DEFAULT_SETTINGS: Settings = {
  audioEnabled: true,
  screenEnabled: true,
  chunkSeconds: 30,
  screenshotLimit: 25,
  monitorId: "",
  micDeviceId: "",
  language: "ko",
  autoTranscribe: false,
  whisperModel: "whisper-small",
  launchOnLogin: false,
  preventSleep: false,
  storageLimitGiB: 10,
};
declare global {
  interface Window {
    automanager: DesktopAPI;
  }
}

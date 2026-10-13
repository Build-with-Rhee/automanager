import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync,
  readdirSync, realpathSync, renameSync, rmSync, statfsSync, statSync, truncateSync,
  unlinkSync, writeSync, fstatSync, createWriteStream
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import archiver from 'archiver'
import { DEFAULT_SETTINGS } from '../shared/types'
import type {
  AppendAudioInput, AppendStepInput, AudioChunk, Job, Schedule, Session, SessionDetail,
  SessionStatus, Settings, StartOptions, Step, StoreAPI, StoreSnapshot
} from '../shared/types'
import { BYTES_PER_SAMPLE, inspectWav, SAMPLE_RATE, wavHeader } from './wav'

const RESERVE_BYTES = 512 * 1024 * 1024
const MAX_PCM_BYTES = SAMPLE_RATE * BYTES_PER_SAMPLE * 4
const MAX_SCREENSHOT_BYTES = 32 * 1024 * 1024
const MAX_PENDING_JOBS = 5000
type Table = 'sessions' | 'steps' | 'chunks' | 'jobs' | 'schedules'
interface DataRow { data: string }
interface Journal {
  version: 1; id: string; sessionId: string; sequence: number; startedAt: number;
  offsetMs: number; chunkSeconds: number;
}
interface PendingAudio extends Journal { fd: number; sampleCount: number }
interface ArtifactRow { id: string; session_id: string | null; kind: string; path: string; temporary: string | null; journal: string | null; state: string; data: string }

function finite(value: number, name: string, minimum = 0) {
  if (!Number.isFinite(value) || value < minimum) throw new Error(`Invalid ${name}`)
}
function identifier(id: string) { if (!/^[a-zA-Z0-9_-]{1,120}$/.test(id)) throw new Error('Invalid asset/session identifier') }
function decode<T>(row: DataRow | undefined): T | null { return row ? JSON.parse(row.data) as T : null }
function escapeHtml(text: string): string { return text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!)) }

/** A single, synchronous DB/file owner. All public operations implement the asynchronous IPC contract. */
export class TrackerStore implements StoreAPI {
  private readonly db: DatabaseSync
  private readonly directory: string
  private readonly token = randomUUID()
  private readonly pending = new Map<string, PendingAudio>()
  private closed = false
  private mediaBytes = 0
  private lastInventory = 0

  constructor(dataDirectory: string) {
    mkdirSync(resolve(dataDirectory), { recursive: true, mode: 0o700 })
    this.directory = realpathSync(resolve(dataDirectory))
    for (const folder of ['sessions', 'tts', 'quarantine']) {
      const path = join(this.directory, folder)
      mkdirSync(path, { recursive: true, mode: 0o700 })
      if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw new Error('Storage namespaces must be real directories')
    }
    this.acquireWriter()
    try {
      this.db = new DatabaseSync(join(this.directory, 'tracker.sqlite'))
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
      this.migrate()
      this.recover()
      this.inventory()
    } catch (error) { this.releaseWriter(); throw error }
  }

  private acquireWriter() {
    const file = join(this.directory, '.writer.lock')
    if (existsSync(file)) {
      const lock = JSON.parse(readFileSync(file, 'utf8')) as { pid: number }
      if (!Number.isInteger(lock.pid) || lock.pid < 1) throw new Error('Invalid storage writer lock')
      if (this.writerAlive(lock.pid)) throw new Error('Storage already has an active writer')
      unlinkSync(file)
    }
    const fd = openSync(file, 'wx', 0o600)
    try { this.writeFully(fd, Buffer.from(JSON.stringify({ pid: process.pid, token: this.token }))); fsyncSync(fd) } finally { closeSync(fd) }
  }
  private writerAlive(pid: number): boolean {
    try { process.kill(pid, 0) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error }
    if (process.platform === 'linux') {
      try {
        const state = /^State:\s+([A-Z])/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1]
        // Zombies still answer kill(pid, 0), but their address space and file descriptors are gone.
        if (state === 'Z' || state === 'X') return false
      } catch { /* An unavailable /proc is not proof that a live process can be replaced. */ }
    }
    return true
  }
  private releaseWriter() {
    const file = join(this.directory, '.writer.lock')
    if (existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).token === this.token) unlinkSync(file)
  }
  private assertOpen() { if (this.closed) throw new Error('Storage is closed') }
  private migrate() {
    const version = Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
    if (version > 1) throw new Error('Storage schema is newer than this app')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS steps (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, sequence INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(session_id, sequence));
      CREATE TABLE IF NOT EXISTS chunks (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, sequence INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(session_id, sequence));
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE, chunk_id TEXT REFERENCES chunks(id) ON DELETE CASCADE, kind TEXT NOT NULL, model_id TEXT NOT NULL, status TEXT NOT NULL, generation INTEGER NOT NULL, created_at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS stt_identity ON jobs(chunk_id, model_id) WHERE kind='stt';
      CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status, created_at);
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE, sequence INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL, path TEXT NOT NULL UNIQUE, temporary TEXT, journal TEXT, state TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS results (job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, generation INTEGER NOT NULL, chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE, PRIMARY KEY(job_id,generation));
      CREATE TABLE IF NOT EXISTS cleanup (path TEXT PRIMARY KEY);
      PRAGMA user_version=1;
    `)
    this.db.prepare('INSERT OR IGNORE INTO settings(id,data) VALUES(1,?)').run(JSON.stringify(DEFAULT_SETTINGS))
  }
  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = operation(); this.db.exec('COMMIT'); return result }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  private get<T>(table: Table, id: string): T | null { return decode<T>(this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id) as DataRow | undefined) }
  private rows<T>(sql: string, ...args: (string | number | null)[]): T[] { return (this.db.prepare(sql).all(...args) as unknown as DataRow[]).map(row => JSON.parse(row.data) as T) }
  private session(id: string): Session { this.assertOpen(); identifier(id); const session = this.get<Session>('sessions', id); if (!session) throw new Error('Session not found'); return session }
  private writableSession(id: string, feature?: 'audio' | 'screen'): Session {
    const session = this.session(id)
    if (session.status !== 'recording') throw new Error(`Session is ${session.status}; 기록 중인 상태가 아닙니다`)
    if (feature && !session[feature]) throw new Error(`${feature} recording is disabled`)
    return session
  }
  private settings(): Settings { return JSON.parse((this.db.prepare('SELECT data FROM settings WHERE id=1').get() as unknown as DataRow).data) as Settings }
  private saveSession(session: Session) { this.db.prepare('UPDATE sessions SET data=? WHERE id=?').run(JSON.stringify(session), session.id) }
  private enrichedSession(session: Session): Session {
    return { ...session, stepCount: Number((this.db.prepare('SELECT COUNT(*) AS total FROM steps WHERE session_id=?').get(session.id) as {total:number}).total), audioCount: Number((this.db.prepare('SELECT COUNT(*) AS total FROM chunks WHERE session_id=?').get(session.id) as {total:number}).total) }
  }
  private base(id: string) { identifier(id); return join(this.directory, 'sessions', id) }
  private internal(path: string) {
    if (isAbsolute(path) || win32.isAbsolute(path) || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe asset path')
    const target = resolve(this.directory, path)
    if (!target.startsWith(this.directory + sep)) throw new Error('Unsafe asset path')
    return target
  }
  private fullAsset(sessionId: string, file: string) { return this.internal(sessionId === 'tts' ? `tts/${file}` : `sessions/${sessionId}/${file}`) }
  private directorySync(directory: string) {
    let fd: number | undefined
    try { fd = openSync(directory, 'r'); fsyncSync(fd) }
    catch (error) { if (process.platform !== 'win32') throw error }
    finally { if (fd !== undefined) closeSync(fd) }
  }
  private writeFully(fd: number, data: Uint8Array, position?: number) {
    let offset = 0
    while (offset < data.length) {
      const written = writeSync(fd, data, offset, data.length - offset, position === undefined ? undefined : position + offset)
      if (!written) throw new Error('File write made no progress')
      offset += written
    }
  }
  private atomicFile(path: string, bytes: Uint8Array) {
    const temporary = `${path}.${randomUUID()}.tmp`, fd = openSync(temporary, 'wx', 0o600)
    try { this.writeFully(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temporary, path); this.directorySync(dirname(path)); this.mediaBytes += bytes.length
  }
  private inventory() {
    const visit = (directory: string): number => readdirSync(directory, { withFileTypes: true }).reduce((bytes, entry) => {
      const path = join(directory, entry.name)
      return bytes + (entry.isDirectory() ? visit(path) : entry.isFile() ? statSync(path).size : 0)
    }, 0)
    this.mediaBytes = ['sessions', 'tts', 'quarantine'].reduce((bytes, folder) => bytes + visit(join(this.directory, folder)), 0)
    this.lastInventory = Date.now()
  }
  private space(bytes: number) {
    if (Date.now() - this.lastInventory > 30000) this.inventory()
    let databaseBytes = 0
    for (const name of ['tracker.sqlite', 'tracker.sqlite-wal', 'tracker.sqlite-shm']) {
      const path = join(this.directory, name); if (existsSync(path)) databaseBytes += statSync(path).size
    }
    if (this.mediaBytes + databaseBytes + bytes > this.settings().storageLimitGiB * 1024 ** 3) throw new Error('Storage quota exceeded: 기록 저장 한도에 도달했습니다')
    const free = statfsSync(this.directory)
    if (free.bavail * free.bsize < RESERVE_BYTES + bytes) throw new Error('Insufficient disk space: 최소 512 MiB의 여유 공간이 필요합니다')
  }
  private removeFile(path: string) {
    const absolute = this.internal(path)
    try {
      if (existsSync(absolute)) { const bytes = lstatSync(absolute).size; unlinkSync(absolute); this.mediaBytes = Math.max(0, this.mediaBytes - bytes) }
      this.db.prepare('DELETE FROM cleanup WHERE path=?').run(path)
    } catch { this.db.prepare('INSERT OR IGNORE INTO cleanup(path) VALUES(?)').run(path) }
  }
  private nextSequence(table: 'steps' | 'chunks', id: string): number {
    const result = table === 'chunks'
      ? this.db.prepare("SELECT COALESCE(MAX(sequence),-1)+1 AS next FROM (SELECT sequence FROM chunks WHERE session_id=? UNION ALL SELECT sequence FROM artifacts WHERE session_id=? AND kind='audio')").get(id, id) as {next:number}
      : this.db.prepare('SELECT COALESCE(MAX(sequence),-1)+1 AS next FROM steps WHERE session_id=?').get(id) as {next:number}
    return Number(result.next)
  }

  async snapshot(): Promise<StoreSnapshot> {
    this.assertOpen()
    const sessions = this.rows<Session>('SELECT data FROM sessions ORDER BY json_extract(data,\'$.startedAt\') DESC').map(session => this.enrichedSession(session))
    const jobs = this.rows<Job>("SELECT data FROM jobs WHERE status IN ('queued','running') OR id IN (SELECT id FROM jobs WHERE status NOT IN ('queued','running') ORDER BY created_at DESC LIMIT 200) ORDER BY created_at DESC")
    return { sessions, jobs, settings: this.settings(), schedules: this.rows<Schedule>('SELECT data FROM schedules ORDER BY id') }
  }
  async createSession(options: StartOptions): Promise<Session> {
    this.assertOpen(); this.space(4096)
    if (this.rows<Session>("SELECT data FROM sessions WHERE json_extract(data,'$.status') IN ('recording','paused')").length) throw new Error('An active session already exists')
    const session: Session = { id: randomUUID(), title: options.title?.trim() || new Date().toLocaleString('ko-KR'), startedAt: Date.now(), endedAt: null, durationMs: 0, status: 'recording', stepCount: 0, audioCount: 0, audio: options.audio, screen: options.screen }
    this.db.prepare('INSERT INTO sessions(id,data) VALUES(?,?)').run(session.id, JSON.stringify(session))
    for (const folder of ['audio', 'screens']) mkdirSync(join(this.base(session.id), folder), { recursive: true, mode: 0o700 })
    return session
  }
  async transition(id: string, status: SessionStatus, durationMs: number): Promise<Session> {
    const session = this.session(id); finite(durationMs, 'session duration')
    const valid: Record<SessionStatus, SessionStatus[]> = { recording: ['paused', 'completed', 'interrupted'], paused: ['recording', 'completed', 'interrupted'], completed: [], interrupted: [] }
    if (status !== session.status && !valid[session.status].includes(status)) throw new Error(`Invalid session transition ${session.status} → ${status}`)
    if (durationMs < session.durationMs) throw new Error('Session duration cannot go backwards')
    if (status !== 'recording') this.flush(id)
    session.status = status; session.durationMs = durationMs
    if (status === 'completed' || status === 'interrupted') session.endedAt = Date.now()
    this.saveSession(session)
    return this.enrichedSession(session)
  }
  async disableSessionAudio(id: string): Promise<Session> {
    const session = this.session(id)
    if (session.status !== 'recording') throw new Error('Audio mode can only be set during recording startup')
    if (this.pending.has(id) || this.db.prepare('SELECT id FROM chunks WHERE session_id=? LIMIT 1').get(id)) throw new Error('Cannot disable audio after samples were accepted')
    session.audio = false
    this.saveSession(session)
    return this.enrichedSession(session)
  }
  async getSession(id: string): Promise<SessionDetail> {
    const session = this.enrichedSession(this.session(id))
    return { session, steps: this.rows<Step>('SELECT data FROM steps WHERE session_id=? ORDER BY sequence', id), chunks: this.rows<AudioChunk>('SELECT data FROM chunks WHERE session_id=? ORDER BY sequence', id), jobs: this.rows<Job>('SELECT data FROM jobs WHERE session_id=? ORDER BY created_at', id) }
  }
  async renameSession(id: string, title: string): Promise<void> {
    const session = this.session(id)
    if (!title.trim() || title.length > 200) throw new Error('Session title must contain 1–200 characters')
    session.title = title.trim(); this.saveSession(session)
  }
  async deleteSession(id: string): Promise<void> {
    this.session(id)
    const current = this.pending.get(id)
    if (current) { closeSync(current.fd); this.pending.delete(id) }
    const paths = this.db.prepare('SELECT path,temporary,journal FROM artifacts WHERE session_id=?').all(id) as unknown as {path:string;temporary:string|null;journal:string|null}[]
    this.transaction(() => {
      for (const artifact of paths) for (const path of [artifact.path, artifact.temporary, artifact.journal]) if (path) this.db.prepare('INSERT OR IGNORE INTO cleanup(path) VALUES(?)').run(path)
      this.db.prepare('DELETE FROM sessions WHERE id=?').run(id)
    })
    try {
      this.runCleanup()
      rmSync(this.base(id), { recursive: true, force: true })
      const failed: string[] = []
      for (const artifact of paths) for (const path of [artifact.path, artifact.temporary, artifact.journal]) if (path) {
        if (existsSync(this.internal(path))) failed.push(path)
        else this.db.prepare('DELETE FROM cleanup WHERE path=?').run(path)
      }
      this.inventory()
      if (failed.length) throw new Error(`${failed.length} files remain in the cleanup journal`)
    }
    catch (error) { throw new Error(`Session metadata deleted, but file cleanup failed: ${(error as Error).message}`) }
  }

  private insertStep(input: Omit<AppendStepInput, 'screenshot'>, screenshot: string | null = null): Step {
    const step: Step = { id: randomUUID(), sessionId: input.sessionId, sequence: this.nextSequence('steps', input.sessionId), timestamp: input.timestamp, offsetMs: input.offsetMs, kind: input.kind, description: input.description, appName: input.appName ?? '', windowTitle: input.windowTitle ?? '', screenshot }
    for (const key of ['x', 'y', 'rect', 'warning'] as const) if (input[key] !== undefined) Object.assign(step, { [key]: input[key] })
    this.db.prepare('INSERT INTO steps(id,session_id,sequence,data) VALUES(?,?,?,?)').run(step.id, step.sessionId, step.sequence, JSON.stringify(step))
    return step
  }
  async appendStep(input: AppendStepInput): Promise<Step> {
    const session = this.session(input.sessionId)
    const archivedComment = input.kind === 'comment' && ['completed', 'interrupted'].includes(session.status)
    if (!archivedComment) this.writableSession(input.sessionId)
    finite(input.timestamp, 'timestamp'); finite(input.offsetMs, 'step offset')
    if (archivedComment && input.offsetMs > session.durationMs) throw new Error('Archived comments must refer to a time inside the session')
    if (!['click', 'double-click', 'drag', 'scroll', 'shortcut', 'comment', 'gap', 'system'].includes(input.kind) || input.description.length > 100000) throw new Error('Invalid recorded step')
    const { screenshot: _screenshot, ...metadata } = input
    this.space(Buffer.byteLength(JSON.stringify(metadata)) + 4096)
    const step = this.insertStep(input)
    let warning = input.warning
    if (input.screenshot && session.screen) {
      try {
        if (!(input.screenshot instanceof Uint8Array) || !input.screenshot.byteLength || input.screenshot.byteLength > MAX_SCREENSHOT_BYTES) throw new Error('화면 전송 한도 초과')
        this.space(input.screenshot.byteLength + 4096)
        const bytes = Buffer.from(input.screenshot.buffer, input.screenshot.byteOffset, input.screenshot.byteLength)
        const format = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'png' : bytes[0] === 255 && bytes[1] === 216 ? 'jpg' : null
        if (!format) throw new Error('Invalid screenshot image')
        const id = randomUUID(), screenshot = `screens/${id}.${format}`
        const path = `sessions/${input.sessionId}/${screenshot}`
        this.db.prepare('INSERT INTO artifacts(id,session_id,kind,path,state,data) VALUES(?,?,?,?,?,?)').run(id, input.sessionId, 'screenshot', path, 'pending', JSON.stringify({stepId:step.id}))
        this.atomicFile(this.internal(path), bytes)
        step.screenshot = screenshot
        this.transaction(() => { this.db.prepare("UPDATE artifacts SET state='ready' WHERE id=?").run(id); this.db.prepare('UPDATE steps SET data=? WHERE id=?').run(JSON.stringify(step), step.id) })
      } catch (error) {
        warning = [warning, `화면 누락: ${(error as Error).message}`].filter(Boolean).join('; ')
        step.screenshot = null; step.warning = warning; this.db.prepare('UPDATE steps SET data=? WHERE id=?').run(JSON.stringify(step), step.id)
      }
    }
    this.retainScreenshots(input.sessionId)
    return this.get<Step>('steps', step.id)!
  }
  private retainScreenshots(id: string) {
    const images = this.rows<Step>("SELECT data FROM steps WHERE session_id=? AND json_extract(data,'$.screenshot') IS NOT NULL ORDER BY sequence DESC", id)
    const removed = images.slice(this.settings().screenshotLimit)
    this.transaction(() => {
      for (const step of removed) {
        const path = `sessions/${id}/${step.screenshot}`
        step.screenshot = null; step.warning = [step.warning, '스크린샷 보관 한도로 화면 제거'].filter(Boolean).join('; ')
        this.db.prepare('UPDATE steps SET data=? WHERE id=?').run(JSON.stringify(step), step.id)
        this.db.prepare('DELETE FROM artifacts WHERE path=?').run(path)
        this.db.prepare('INSERT OR IGNORE INTO cleanup(path) VALUES(?)').run(path)
      }
    })
    this.runCleanup()
  }
  private runCleanup() { for (const row of this.db.prepare('SELECT path FROM cleanup').all() as unknown as {path:string}[]) this.removeFile(row.path) }

  private beginAudio(input: AppendAudioInput, consumedBytes: number): PendingAudio {
    const id = randomUUID(), sequence = this.nextSequence('chunks', input.sessionId)
    const journal: Journal = { version: 1, id, sessionId: input.sessionId, sequence, startedAt: input.startedAt + consumedBytes / 32, offsetMs: input.offsetMs + consumedBytes / 32, chunkSeconds: this.settings().chunkSeconds }
    const prefix = `sessions/${input.sessionId}/audio/${id}.wav`
    this.db.prepare('INSERT INTO artifacts(id,session_id,sequence,kind,path,temporary,journal,state,data) VALUES(?,?,?,?,?,?,?,?,?)').run(id, input.sessionId, sequence, 'audio', prefix, `${prefix}.tmp`, `${prefix}.journal.json`, 'pending', JSON.stringify(journal))
    this.atomicFile(this.internal(`${prefix}.journal.json`), Buffer.from(JSON.stringify(journal)))
    const fd = openSync(this.internal(`${prefix}.tmp`), 'wx', 0o600)
    this.writeFully(fd, wavHeader(0)); fsyncSync(fd); this.directorySync(dirname(this.internal(`${prefix}.tmp`))); this.mediaBytes += 44
    const pending: PendingAudio = { ...journal, fd, sampleCount: 0 }; this.pending.set(input.sessionId, pending)
    return pending
  }
  async appendAudio(input: AppendAudioInput): Promise<AudioChunk[]> {
    this.writableSession(input.sessionId, 'audio'); finite(input.startedAt, 'audio start'); finite(input.offsetMs, 'audio offset')
    if (!(input.pcm instanceof Uint8Array)) throw new Error('PCM input must be binary Uint8Array data')
    if (input.pcm.byteLength % BYTES_PER_SAMPLE) throw new Error('PCM input must contain complete 16-bit samples')
    if (input.pcm.byteLength > MAX_PCM_BYTES) throw new Error('PCM input exceeds the bounded four-second transport')
    if (!input.pcm.byteLength) return []
    try { this.space(input.pcm.byteLength + 4096) }
    catch (error) { this.flush(input.sessionId); throw error }
    const saved: AudioChunk[] = []
    const current = this.pending.get(input.sessionId)
    if (current && Math.abs(input.offsetMs - current.offsetMs - current.sampleCount * 1000 / SAMPLE_RATE) > 25) {
      const expected = current.offsetMs + current.sampleCount * 1000 / SAMPLE_RATE
      if (input.offsetMs < expected - 25) throw new Error('Audio sample ranges overlap')
      saved.push(...this.flush(input.sessionId))
      this.insertStep({ sessionId: input.sessionId, kind: 'gap', description: '오디오 입력 공백', timestamp: input.startedAt, offsetMs: expected, warning: `${Math.round(input.offsetMs - expected)} ms audio gap` })
    }
    let position = 0
    while (position < input.pcm.byteLength) {
      const pending = this.pending.get(input.sessionId) ?? this.beginAudio(input, position)
      const count = Math.min(input.pcm.byteLength - position, (pending.chunkSeconds * SAMPLE_RATE - pending.sampleCount) * BYTES_PER_SAMPLE)
      this.writeFully(pending.fd, input.pcm.subarray(position, position + count), 44 + pending.sampleCount * BYTES_PER_SAMPLE)
      pending.sampleCount += count / BYTES_PER_SAMPLE; position += count; this.mediaBytes += count
      fsyncSync(pending.fd)
      if (pending.sampleCount === pending.chunkSeconds * SAMPLE_RATE) saved.push(this.finalizeAudio(pending))
    }
    return saved
  }
  private finalizeAudio(pending: PendingAudio): AudioChunk {
    const prefix = `sessions/${pending.sessionId}/audio/${pending.id}.wav`
    this.writeFully(pending.fd, wavHeader(pending.sampleCount), 0); fsyncSync(pending.fd); closeSync(pending.fd)
    this.pending.delete(pending.sessionId)
    renameSync(this.internal(`${prefix}.tmp`), this.internal(prefix)); this.directorySync(dirname(this.internal(prefix)))
    const chunk = this.commitAudio(pending, pending.sampleCount)
    this.removeFile(`${prefix}.journal.json`)
    return chunk
  }
  private commitAudio(journal: Journal, sampleCount: number): AudioChunk {
    const existing = this.get<AudioChunk>('chunks', journal.id)
    if (existing) return existing
    const settings = this.settings()
    const queueAvailable = Number((this.db.prepare("SELECT COUNT(*) AS total FROM jobs WHERE status IN ('queued','running')").get() as {total:number}).total) < MAX_PENDING_JOBS
    const chunk: AudioChunk = { id: journal.id, sessionId: journal.sessionId, sequence: journal.sequence, file: `audio/${journal.id}.wav`, startedAt: journal.startedAt, offsetMs: journal.offsetMs, durationMs: sampleCount * 1000 / SAMPLE_RATE, sampleCount, transcript: '', status: settings.autoTranscribe && queueAvailable ? 'queued' : 'saved' }
    this.transaction(() => {
      this.db.prepare('INSERT INTO chunks(id,session_id,sequence,data) VALUES(?,?,?,?)').run(chunk.id, chunk.sessionId, chunk.sequence, JSON.stringify(chunk))
      this.db.prepare("UPDATE artifacts SET state='ready',temporary=NULL,journal=NULL WHERE id=?").run(chunk.id)
      if (settings.autoTranscribe && queueAvailable) this.createJobSync({ sessionId: chunk.sessionId, chunkId: chunk.id, kind: 'stt', text: '', modelId: settings.whisperModel })
      else if (settings.autoTranscribe) this.insertStep({ sessionId: chunk.sessionId, kind: 'system', description: '자동 변환 대기열 한도로 오디오만 저장했습니다', timestamp: Date.now(), offsetMs: chunk.offsetMs })
    })
    return chunk
  }
  private flush(id: string): AudioChunk[] {
    const pending = this.pending.get(id)
    if (!pending) return []
    if (pending.sampleCount) return [this.finalizeAudio(pending)]
    closeSync(pending.fd); this.pending.delete(id)
    const prefix = `sessions/${id}/audio/${pending.id}.wav`
    this.db.prepare('DELETE FROM artifacts WHERE id=?').run(pending.id)
    this.removeFile(`${prefix}.tmp`); this.removeFile(`${prefix}.journal.json`)
    return []
  }
  async flushAudio(id: string): Promise<AudioChunk[]> { this.session(id); return this.flush(id) }

  async updateSettings(patch: Partial<Settings>): Promise<Settings> {
    this.assertOpen()
    for (const key of Object.keys(patch)) if (!(key in DEFAULT_SETTINGS)) throw new Error(`Unknown setting ${key}`)
    const settings = { ...this.settings(), ...patch }
    if (![15, 30, 60, 120].includes(settings.chunkSeconds)) throw new Error('Invalid chunk length')
    if (!Number.isInteger(settings.screenshotLimit) || settings.screenshotLimit < 0 || settings.screenshotLimit > 10000) throw new Error('Invalid screenshot limit')
    finite(settings.storageLimitGiB, 'storage limit', Number.EPSILON)
    for (const key of ['audioEnabled', 'screenEnabled', 'autoTranscribe', 'launchOnLogin', 'preventSleep'] as const) if (typeof settings[key] !== 'boolean') throw new Error(`Invalid setting ${key}`)
    for (const key of ['monitorId', 'micDeviceId', 'language', 'whisperModel'] as const) if (typeof settings[key] !== 'string' || settings[key].length > 1000) throw new Error(`Invalid setting ${key}`)
    if (patch.chunkSeconds !== undefined && patch.chunkSeconds !== this.settings().chunkSeconds) for (const id of this.pending.keys()) this.flush(id)
    this.db.prepare('UPDATE settings SET data=? WHERE id=1').run(JSON.stringify(settings))
    if (patch.screenshotLimit !== undefined) for (const session of this.rows<Session>('SELECT data FROM sessions')) this.retainScreenshots(session.id)
    return settings
  }

  private createJobSync(input: {sessionId: string | null; chunkId: string | null; kind: 'stt' | 'tts'; text: string; modelId: string}): Job {
    if (!['stt', 'tts'].includes(input.kind) || !input.modelId || input.text.length > 100000) throw new Error('Invalid speech job')
    if (input.sessionId) this.session(input.sessionId)
    if (input.kind === 'stt') {
      const chunk = input.chunkId ? this.get<AudioChunk>('chunks', input.chunkId) : null
      if (!chunk || chunk.sessionId !== input.sessionId) throw new Error('STT job requires a saved chunk in the selected session')
      const existing = decode<Job>(this.db.prepare("SELECT data FROM jobs WHERE chunk_id=? AND model_id=? AND kind='stt'").get(input.chunkId!, input.modelId) as DataRow | undefined)
      if (existing) {
        if (existing.status === 'failed' || existing.status === 'canceled') {
          existing.status = 'queued'; existing.generation++; existing.error = null; existing.progress = 0; existing.updatedAt = Date.now(); this.saveJob(existing)
        }
        return existing
      }
    } else if (input.chunkId) throw new Error('TTS jobs cannot own an audio input chunk')
    if (Number((this.db.prepare("SELECT COUNT(*) AS total FROM jobs WHERE status IN ('queued','running')").get() as {total:number}).total) >= MAX_PENDING_JOBS) throw new Error('Speech job queue limit exceeded')
    const now = Date.now(), job: Job = { id: randomUUID(), ...input, status: 'queued', progress: 0, createdAt: now, updatedAt: now, error: null, output: null, generation: 0 }
    this.db.prepare('INSERT INTO jobs(id,session_id,chunk_id,kind,model_id,status,generation,created_at,data) VALUES(?,?,?,?,?,?,?,?,?)').run(job.id, job.sessionId, job.chunkId, job.kind, job.modelId, job.status, job.generation, job.createdAt, JSON.stringify(job))
    return job
  }
  private saveJob(job: Job) { this.db.prepare('UPDATE jobs SET status=?,generation=?,data=? WHERE id=?').run(job.status, job.generation, JSON.stringify(job), job.id) }
  async createJob(input: {sessionId: string | null; chunkId: string | null; kind: 'stt' | 'tts'; text: string; modelId: string}): Promise<Job> { this.assertOpen(); return this.createJobSync(input) }
  async updateJob(id: string, patch: Partial<Pick<Job, 'status' | 'progress' | 'error' | 'output' | 'text'>>, generation?: number): Promise<Job | null> {
    this.assertOpen()
    const job = this.get<Job>('jobs', id)
    if (!job || (generation !== undefined && generation !== job.generation)) return null
    if (patch.status && !['queued', 'running', 'completed', 'failed', 'canceled'].includes(patch.status)) throw new Error('Invalid job status')
    if (patch.progress !== undefined) { finite(patch.progress, 'job progress'); if (patch.progress > 100) throw new Error('Invalid job progress') }
    if (job.status === 'canceled' && patch.status !== 'queued') return null
    if (patch.status === 'canceled' && job.status !== 'canceled') job.generation++
    if (patch.status === 'queued' && ['failed', 'canceled', 'completed'].includes(job.status)) { job.generation++; job.error = null; job.progress = 0; job.output = null }
    Object.assign(job, patch); job.updatedAt = Date.now()
    if (job.status === 'completed') job.progress = 100
    this.saveJob(job)
    return job
  }
  async updateChunk(id: string, patch: Partial<Pick<AudioChunk, 'transcript' | 'status'>>, guard?: {jobId: string; generation: number}): Promise<void> {
    this.assertOpen()
    const chunk = this.get<AudioChunk>('chunks', id)
    if (!chunk) return
    if (guard) { const job = this.get<Job>('jobs', guard.jobId); if (!job || job.kind !== 'stt' || job.chunkId !== id || job.generation !== guard.generation || job.status !== 'running') return }
    if (patch.status && !['saved', 'queued', 'processing', 'done', 'failed'].includes(patch.status)) throw new Error('Invalid chunk status')
    Object.assign(chunk, patch)
    this.transaction(() => {
      this.db.prepare('UPDATE chunks SET data=? WHERE id=?').run(JSON.stringify(chunk), id)
      if (guard && patch.status === 'done') this.db.prepare('INSERT OR IGNORE INTO results(job_id,generation,chunk_id) VALUES(?,?,?)').run(guard.jobId, guard.generation, id)
    })
  }
  async saveSchedule(input: Omit<Schedule, 'id'> & {id?: string}): Promise<Schedule> {
    this.assertOpen()
    const id = input.id ?? randomUUID(); identifier(id)
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.startTime) || typeof input.enabled !== 'boolean' || !Array.isArray(input.days) || input.days.some(day => !Number.isInteger(day) || day < 0 || day > 6)) throw new Error('Invalid schedule')
    finite(input.durationMinutes, 'schedule duration', 1); finite(input.nextRun, 'next run')
    if (input.lastRun !== null) finite(input.lastRun, 'last run')
    const schedule: Schedule = { ...input, id, days: [...new Set(input.days)] }
    this.db.prepare('INSERT INTO schedules(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(id, JSON.stringify(schedule))
    return schedule
  }
  async deleteSchedule(id: string): Promise<void> { this.assertOpen(); this.db.prepare('DELETE FROM schedules WHERE id=?').run(id) }

  async resolveAsset(sessionId: string, file: string): Promise<string> {
    this.assertOpen(); identifier(sessionId)
    if (sessionId !== 'tts') this.session(sessionId)
    const target = this.fullAsset(sessionId, file)
    const artifact = this.db.prepare("SELECT path FROM artifacts WHERE path=? AND state='ready' AND ((session_id=? AND kind!='tts') OR (kind='tts' AND ?='tts'))").get(relative(this.directory, target).split(sep).join('/'), sessionId, sessionId)
    if (!artifact || !existsSync(target)) throw new Error('Asset not found')
    const actual = realpathSync(target), base = sessionId === 'tts' ? join(this.directory, 'tts') : this.base(sessionId)
    if (!actual.startsWith(this.directory + sep) || !actual.startsWith(realpathSync(base) + sep) || !lstatSync(target).isFile()) throw new Error('Unsafe asset path')
    return actual
  }
  async importOutput(jobId: string, source: string, generation?: number): Promise<string> {
    this.assertOpen()
    const job = this.get<Job>('jobs', jobId)
    if (!job || job.kind !== 'tts' || job.status !== 'running' || (generation !== undefined && generation !== job.generation)) throw new Error('TTS job is canceled, missing or belongs to an old generation')
    if (!lstatSync(source).isFile()) throw new Error('Invalid WAV audio source')
    inspectWav(source)
    const size = statSync(source).size; this.space(size + 4096)
    const name = `${job.id}-${job.generation}.wav`, path = `tts/${name}`, temporary = `${path}.tmp`, artifactId = `${job.id}-${job.generation}`
    this.db.prepare('INSERT INTO artifacts(id,session_id,kind,path,temporary,state,data) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET temporary=excluded.temporary,state=excluded.state,data=excluded.data').run(artifactId, job.sessionId, 'tts', path, temporary, 'pending', JSON.stringify({ jobId: job.id, generation: job.generation }))
    const sourceFd = openSync(source, 'r'), targetFd = openSync(this.internal(temporary), 'w', 0o600)
    try {
      const buffer = Buffer.alloc(65536); let position = 0
      while (position < size) { const count = readSync(sourceFd, buffer, 0, Math.min(buffer.length, size - position), position); if (!count) throw new Error('Truncated WAV audio output'); this.writeFully(targetFd, buffer.subarray(0, count)); position += count }
      fsyncSync(targetFd)
    } finally { closeSync(sourceFd); closeSync(targetFd) }
    inspectWav(this.internal(temporary))
    const oldSize = existsSync(this.internal(path)) ? statSync(this.internal(path)).size : 0
    renameSync(this.internal(temporary), this.internal(path)); this.directorySync(join(this.directory, 'tts')); this.mediaBytes += size - oldSize
    this.transaction(() => { this.db.prepare("UPDATE artifacts SET state='ready',temporary=NULL WHERE id=?").run(artifactId); job.output = name; job.updatedAt = Date.now(); this.saveJob(job) })
    return name
  }

  async exportSession(id: string, destination: string): Promise<void> {
    const detail = await this.getSession(id)
    if (this.rows<Session>("SELECT data FROM sessions WHERE json_extract(data,'$.status') IN ('recording','paused')").length) throw new Error('기록을 종료한 뒤 내보내세요. Export is unavailable while recording is active.')
    const target = resolve(destination)
    if (['sessions', 'tts', 'quarantine'].some(folder => target.startsWith(join(this.directory, folder) + sep)) || target.startsWith(join(this.directory, 'tracker.sqlite'))) throw new Error('Cannot overwrite internal storage with an export')
    mkdirSync(dirname(target), { recursive: true })
    const media: { file: string; absolute: string; type: string }[] = []
    for (const step of detail.steps) if (step.screenshot) media.push({ file: step.screenshot, absolute: await this.resolveAsset(id, step.screenshot), type: step.screenshot.endsWith('.png') ? 'image/png' : 'image/jpeg' })
    for (const chunk of detail.chunks) media.push({ file: chunk.file, absolute: await this.resolveAsset(id, chunk.file), type: 'audio/wav' })
    for (const job of detail.jobs) if (job.kind === 'tts' && job.output) media.push({ file: `tts/${job.output}`, absolute: await this.resolveAsset('tts', job.output), type: 'audio/wav' })
    const title = escapeHtml(detail.session.title)
    const html = `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><style>body{font:16px system-ui;max-width:960px;margin:40px auto;padding:0 24px;line-height:1.6}article{border-top:1px solid #ddd;padding:20px 0}img{max-width:100%}small{color:#555}pre{white-space:pre-wrap}</style><body><h1>${title}</h1><p>${escapeHtml(new Date(detail.session.startedAt).toISOString())}</p>${detail.steps.map(step => `<article><small>${step.sequence + 1} · ${(step.offsetMs / 1000).toFixed(2)}초 · ${escapeHtml(step.appName)}</small><p>${escapeHtml(step.description)}</p>${step.windowTitle ? `<p>${escapeHtml(step.windowTitle)}</p>` : ''}${step.warning ? `<p>${escapeHtml(step.warning)}</p>` : ''}${step.screenshot ? `<img src="${step.screenshot}" alt="단계 ${step.sequence + 1} 화면">` : ''}</article>`).join('')}<h2>녹음과 음성 변환</h2>${detail.chunks.map(chunk => `<article><p>${(chunk.offsetMs / 1000).toFixed(2)}초 · ${(chunk.durationMs / 1000).toFixed(2)}초 녹음</p><audio controls src="${chunk.file}"></audio><pre>${escapeHtml(chunk.transcript)}</pre></article>`).join('')}${detail.jobs.filter(job => job.kind === 'tts' && job.output).map(job => `<article><pre>${escapeHtml(job.text)}</pre><audio controls src="tts/${job.output}"></audio></article>`).join('')}</body></html>`
    const boundary = `automanager-${randomUUID()}`
    const base64Lines = (bytes: Buffer) => bytes.toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? ''
    const temporary = `${target}.${randomUUID()}.tmp`, mhtmlTemporary = `${target}.${randomUUID()}.mhtml.tmp`
    const output = createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), archive = archiver('zip', { zlib: { level: 6 } })
    try {
      // Spool MIME attachments in 64 KiB blocks: screenshot retention can be increased without growing export RAM.
      const mime = openSync(mhtmlTemporary, 'wx', 0o600)
      const mimeText = (text: string) => this.writeFully(mime, Buffer.from(text))
      try {
        mimeText(`MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="${boundary}"; type="text/html"\r\n\r\n--${boundary}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\nContent-Location: report.html\r\n\r\n`)
        const encodedHtml = Buffer.from(html)
        for (let position = 0; position < encodedHtml.length; position += 65535) mimeText(base64Lines(encodedHtml.subarray(position, position + 65535)) + '\r\n')
        for (const asset of media.filter(asset => asset.type.startsWith('image/'))) {
          mimeText(`--${boundary}\r\nContent-Type: ${asset.type}\r\nContent-Transfer-Encoding: base64\r\nContent-Location: ${asset.file}\r\n\r\n`)
          const fd = openSync(asset.absolute, 'r'), buffer = Buffer.alloc(65535)
          try { let count: number; while ((count = readSync(fd, buffer, 0, buffer.length, null))) mimeText(base64Lines(buffer.subarray(0, count)) + '\r\n') }
          finally { closeSync(fd) }
        }
        mimeText(`--${boundary}--\r\n`); fsyncSync(mime)
      } finally { closeSync(mime) }
      const finished = new Promise<void>((resolvePromise, reject) => { output.on('close', resolvePromise); output.on('error', reject); archive.on('error', reject); archive.on('warning', reject) })
      archive.pipe(output); archive.append(html, { name: 'report.html' }); archive.file(mhtmlTemporary, { name: 'report.mhtml' }); archive.append(JSON.stringify({ schemaVersion: 1, ...detail }, null, 2), { name: 'session.json' })
      for (const asset of media) archive.file(asset.absolute, { name: asset.file })
      await archive.finalize(); await finished
      // Windows FlushFileBuffers requires write access; r+ preserves ZIP bytes.
      const fd = openSync(temporary, 'r+'); try { fsyncSync(fd) } finally { closeSync(fd) }
      renameSync(temporary, target); this.directorySync(dirname(target))
    } catch (error) { archive.abort(); output.destroy(); rmSync(temporary, { force: true }); throw error }
    finally { rmSync(mhtmlTemporary, { force: true }) }
  }

  private recover() {
    this.runCleanup()
    // Journals carry enough identity to recover a file even if termination preceded its DB insertion.
    for (const session of this.rows<Session>('SELECT data FROM sessions')) {
      const directory = join(this.base(session.id), 'audio'); mkdirSync(directory, { recursive: true })
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.wav.journal.json')) continue
        const path = join(directory, entry.name)
        try {
          const journal = JSON.parse(readFileSync(path, 'utf8')) as Journal
          identifier(journal.id)
          if (journal.version !== 1 || journal.sessionId !== session.id || !Number.isInteger(journal.sequence) || journal.sequence < 0 || ![15, 30, 60, 120].includes(journal.chunkSeconds)) throw new Error('Invalid audio journal')
          finite(journal.startedAt, 'journal timestamp'); finite(journal.offsetMs, 'journal offset')
          const prefix = `sessions/${session.id}/audio/${journal.id}.wav`
          if (entry.name !== `${journal.id}.wav.journal.json`) throw new Error('Journal filename does not match identity')
          if (!this.db.prepare('SELECT id FROM artifacts WHERE id=?').get(journal.id)) this.db.prepare('INSERT INTO artifacts(id,session_id,sequence,kind,path,temporary,journal,state,data) VALUES(?,?,?,?,?,?,?,?,?)').run(journal.id, session.id, journal.sequence, 'audio', prefix, `${prefix}.tmp`, `${prefix}.journal.json`, 'pending', JSON.stringify(journal))
        } catch { this.quarantine(path) }
      }
    }
    for (const artifact of this.db.prepare("SELECT * FROM artifacts WHERE state='pending'").all() as unknown as ArtifactRow[]) {
      try {
        const final = this.internal(artifact.path), temporary = artifact.temporary ? this.internal(artifact.temporary) : null
        const source = existsSync(final) ? final : temporary && existsSync(temporary) ? temporary : null
        if (!source) { this.discardArtifact(artifact); continue }
        if (artifact.kind === 'audio') {
          const journal = JSON.parse(artifact.data) as Journal
          const fd = openSync(source, 'r+'), header = Buffer.alloc(44)
          let samples = 0
          try {
            const size = fstatSync(fd).size
            if (size < 44 || readSync(fd, header, 0, 44, 0) !== 44 || header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 16) !== 'WAVEfmt ' || header.readUInt16LE(20) !== 1 || header.readUInt16LE(22) !== 1 || header.readUInt32LE(24) !== SAMPLE_RATE || header.readUInt16LE(34) !== 16 || header.toString('ascii', 36, 40) !== 'data') throw new Error('Corrupt temporary WAV')
            samples = Math.floor((size - 44) / 2)
            if (samples > journal.chunkSeconds * SAMPLE_RATE) throw new Error('Recovery WAV exceeds its chunk size')
            if (samples) { truncateSync(source, 44 + samples * 2); this.writeFully(fd, wavHeader(samples), 0); fsyncSync(fd) }
          } finally { closeSync(fd) }
          if (!samples) { this.discardArtifact(artifact); continue }
          if (source !== final) { renameSync(source, final); this.directorySync(dirname(final)) }
          this.commitAudio(journal, samples)
          if (artifact.journal) this.removeFile(artifact.journal)
        } else if (artifact.kind === 'tts') {
          const meta = JSON.parse(artifact.data) as {jobId:string;generation:number}, job = this.get<Job>('jobs', meta.jobId)
          if (!job || job.status !== 'running' || job.generation !== meta.generation) { this.discardArtifact(artifact); continue }
          inspectWav(source)
          if (source !== final) renameSync(source, final)
          this.transaction(() => { this.db.prepare("UPDATE artifacts SET state='ready',temporary=NULL WHERE id=?").run(artifact.id); job.output = relative(join(this.directory, 'tts'), final); job.status = 'completed'; job.progress = 100; job.updatedAt = Date.now(); this.saveJob(job) })
        } else if (artifact.kind === 'screenshot') {
          const meta = JSON.parse(artifact.data) as {stepId:string}, step = this.get<Step>('steps', meta.stepId)
          if (!step || step.sessionId !== artifact.session_id) { this.discardArtifact(artifact); continue }
          const header = readFileSync(source).subarray(0, 8)
          if (!(header.equals(Buffer.from([137,80,78,71,13,10,26,10])) || (header[0] === 255 && header[1] === 216))) throw new Error('Invalid screenshot file')
          if (source !== final) renameSync(source, final)
          step.screenshot = relative(this.base(step.sessionId), final).split(sep).join('/')
          this.transaction(() => { this.db.prepare("UPDATE artifacts SET state='ready',temporary=NULL WHERE id=?").run(artifact.id); this.db.prepare('UPDATE steps SET data=? WHERE id=?').run(JSON.stringify(step), step.id) })
        } else this.discardArtifact(artifact)
      } catch {
        for (const path of [artifact.path, artifact.temporary, artifact.journal]) if (path && existsSync(this.internal(path))) this.quarantine(this.internal(path))
        this.db.prepare('DELETE FROM artifacts WHERE id=?').run(artifact.id)
      }
    }
    this.validateReadyArtifacts()
    const known = new Set((this.db.prepare('SELECT path FROM artifacts').all() as unknown as {path:string}[]).map(row => this.internal(row.path)))
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) visit(path)
        else if (entry.isFile() && !known.has(path)) this.quarantine(path)
      }
    }
    visit(join(this.directory, 'sessions')); visit(join(this.directory, 'tts'))
    for (const session of this.rows<Session>("SELECT data FROM sessions WHERE json_extract(data,'$.status') IN ('recording','paused')")) {
      session.status = 'interrupted'; session.endedAt = Date.now()
      const chunks = this.rows<AudioChunk>('SELECT data FROM chunks WHERE session_id=?', session.id)
      session.durationMs = Math.max(session.durationMs, ...chunks.map(chunk => chunk.offsetMs + chunk.durationMs)); this.saveSession(session)
      this.insertStep({ sessionId: session.id, kind: 'gap', description: '앱 종료 후 기록을 복구했습니다', timestamp: Date.now(), offsetMs: session.durationMs })
    }
    for (const job of this.rows<Job>("SELECT data FROM jobs WHERE status='running'")) {
      const committed = job.kind === 'stt'
        ? this.db.prepare('SELECT job_id FROM results WHERE job_id=? AND generation=?').get(job.id, job.generation)
        : job.output && this.db.prepare("SELECT id FROM artifacts WHERE path=? AND state='ready' AND id=?").get(`tts/${job.output}`, `${job.id}-${job.generation}`)
      if (committed) { job.status = 'completed'; job.progress = 100; job.updatedAt = Date.now(); this.saveJob(job); continue }
      job.status = 'queued'; job.generation++; job.progress = 0; job.error = null; job.updatedAt = Date.now(); this.saveJob(job)
      if (job.chunkId) { const chunk = this.get<AudioChunk>('chunks', job.chunkId); if (chunk) { chunk.status = 'queued'; this.db.prepare('UPDATE chunks SET data=? WHERE id=?').run(JSON.stringify(chunk), chunk.id) } }
    }
  }
  private quarantine(path: string) {
    const relativePath = relative(this.directory, path).split(sep).join('__')
    renameSync(path, join(this.directory, 'quarantine', `${randomUUID()}-${relativePath}`))
  }
  private validateReadyArtifacts() {
    for (const artifact of this.db.prepare("SELECT * FROM artifacts WHERE state='ready'").all() as unknown as ArtifactRow[]) {
      try {
        const path = this.internal(artifact.path)
        if (!existsSync(path) || !lstatSync(path).isFile()) throw new Error('Missing or unsafe asset file')
        if (artifact.kind === 'audio' || artifact.kind === 'tts') {
          const wave = inspectWav(path)
          if (artifact.kind === 'audio') {
            const chunk = this.get<AudioChunk>('chunks', artifact.id)
            if (!chunk || wave.channels !== 1 || wave.sampleRate !== SAMPLE_RATE || wave.sampleCount !== chunk.sampleCount) throw new Error('Recorded audio sample count does not match metadata')
          }
        }
      } catch (error) {
        const warning = `${artifact.kind} 파일 누락 또는 손상: ${(error as Error).message}`
        this.transaction(() => {
          this.db.prepare("UPDATE artifacts SET state='error' WHERE id=?").run(artifact.id)
          if (artifact.kind === 'audio') {
            const chunk = this.get<AudioChunk>('chunks', artifact.id)
            if (chunk) {
              chunk.status = 'failed'; this.db.prepare('UPDATE chunks SET data=? WHERE id=?').run(JSON.stringify(chunk), chunk.id)
              this.insertStep({ sessionId: chunk.sessionId, kind: 'gap', description: '저장된 오디오를 읽을 수 없습니다', timestamp: Date.now(), offsetMs: chunk.offsetMs, warning })
            }
          } else if (artifact.kind === 'screenshot') {
            const meta = JSON.parse(artifact.data) as {stepId?:string}, step = meta.stepId ? this.get<Step>('steps', meta.stepId) : null
            if (step) { step.screenshot = null; step.warning = [step.warning, warning].filter(Boolean).join('; '); this.db.prepare('UPDATE steps SET data=? WHERE id=?').run(JSON.stringify(step), step.id) }
          }
          const metadata = JSON.parse(artifact.data) as {jobId?:string}
          const jobs = artifact.kind === 'audio' ? this.rows<Job>('SELECT data FROM jobs WHERE chunk_id=?', artifact.id) : metadata.jobId ? [this.get<Job>('jobs', metadata.jobId)].filter((job):job is Job => job !== null) : []
          for (const job of jobs) { job.status = 'failed'; job.error = warning; job.generation++; job.updatedAt = Date.now(); this.saveJob(job) }
        })
        const file = this.internal(artifact.path)
        if (existsSync(file) && lstatSync(file).isFile()) this.quarantine(file)
      }
    }
    for (const session of this.rows<Session>('SELECT data FROM sessions')) this.retainScreenshots(session.id)
  }
  private discardArtifact(artifact: ArtifactRow) {
    this.db.prepare('DELETE FROM artifacts WHERE id=?').run(artifact.id)
    for (const path of [artifact.path, artifact.temporary, artifact.journal]) if (path) this.removeFile(path)
  }
  async close(): Promise<void> {
    if (this.closed) return
    try { for (const id of [...this.pending.keys()]) this.flush(id); this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)') }
    finally { this.closed = true; this.db.close(); this.releaseWriter() }
  }
}

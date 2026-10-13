import { access, copyFile, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { cpus, freemem } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { Job, ModelInfo, StoreAPI, SynthOptions } from '../shared/types'
import { artifactPath, diskReserve, downloadArtifact, installArtifacts, publishDirectory, verifyFile } from './download'
import { manifest, MODEL_MANIFESTS, VOICES, type ModelManifest } from './manifests'
import { JsonLineWorker } from './process'
import { WhisperServer } from './whisper'

const executeFile = promisify(execFile)
const MAX_PENDING = 32
type Installation = { status: 'downloading' | 'error'; progress: number; error?: string }
interface Options { store: StoreAPI; dataDirectory: string; resourcesDirectory: string; onChange: () => void }
export class EngineManager {
  private directory: string
  private modelDirectory: string
  private executablePaths: Record<string, string> = {}
  private installations: Record<string, Installation> = {}
  private downloads = new Map<string, AbortController>()
  private active = new Map<string, { controller: AbortController; completion: Promise<void>; kind: Job['kind'] }>()
  private verified = new Map<string, string>()
  private whisper: { modelId: string; worker: WhisperServer } | null = null
  private tts: { modelId: string; worker: JsonLineWorker } | null = null
  private initialized: Promise<void>
  private operations = Promise.resolve()
  private ticking: Promise<void> | null = null
  private recovered = false
  private disposed = false
  constructor(private options: Options) {
    this.directory = join(options.dataDirectory, 'engines')
    this.modelDirectory = join(this.directory, 'models')
    this.initialized = this.initialize()
  }
  private emit(): void { if (!this.disposed) this.options.onChange() }
  private async initialize(): Promise<void> {
    await mkdir(this.modelDirectory, { recursive: true })
    for (const [name, target] of [['engine-paths.json', this.executablePaths], ['install-state.json', this.installations]] as const) {
      try { Object.assign(target, JSON.parse(await readFile(join(this.directory, name), 'utf8'))) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Engine configuration unreadable: ${name}`)
      }
    }
    for (const model of MODEL_MANIFESTS) {
      if (this.installations[model.id]?.status === 'downloading') this.installations[model.id] = {
        status: 'error', progress: 0, error: 'Model installation interrupted; retry installation' }
    }
    for (const root of this.resourceCandidates()) {
      try {
        try {
          const target = JSON.parse(await readFile(join(root, 'runtime', 'runtime-platform.json'), 'utf8')) as { platform: string; architecture: string }
          if (target.platform !== process.platform || target.architecture !== process.arch) continue
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        const paths = JSON.parse(await readFile(join(root, 'runtime', 'engine-paths.json'), 'utf8')) as Record<string, string>
        for (const engine of ['whisper', 'melo', 'sherpa']) if (!this.executablePaths[engine] && typeof paths[engine] === 'string') {
          const path = isAbsolute(paths[engine]) ? paths[engine] : resolve(root, 'runtime', paths[engine])
          try { await access(path, constants.X_OK); this.executablePaths[engine] = path } catch { /* Show missing runtime when invoked. */ }
        }
      } catch { /* Bundled runtimes are optional until provisioned. */ }
      for (const model of MODEL_MANIFESTS) {
        // Provisioned model packs can live alongside packaged runtimes and are checked before use.
        try { await access(join(root, 'runtime', 'models', model.id)); this.bundledModels.set(model.id, join(root, 'runtime', 'models', model.id)) } catch {}
      }
    }
  }
  private bundledModels = new Map<string, string>()
  private resourceCandidates(): string[] {
    return [join(this.options.resourcesDirectory, 'engines'), join(this.options.resourcesDirectory, 'resources', 'engines'), this.options.resourcesDirectory]
  }
  private async helper(name: string): Promise<string> {
    for (const root of this.resourceCandidates()) {
      const path = join(root, name)
      try { await access(path); return path } catch {}
    }
    throw new Error(`Engine helper missing: ${name}; reinstall application resources`)
  }
  private async persist(file: string, data: unknown): Promise<void> {
    const target = join(this.directory, file)
    const temporary = `${target}.${randomUUID()}.part`
    await writeFile(temporary, JSON.stringify(data, null, 2), { mode: 0o600 })
    await rename(temporary, target)
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation, operation)
    this.operations = result.then(() => {}, () => {})
    return result
  }
  private async modelPath(model: ModelManifest): Promise<string> {
    const own = join(this.modelDirectory, model.id)
    try { await access(own); return own } catch { return this.bundledModels.get(model.id) ?? own }
  }
  private async verifyModel(model: ModelManifest): Promise<string> {
    const root = await this.modelPath(model)
    const fingerprints = []
    for (const artifact of model.artifacts) {
      const path = artifactPath(root, artifact.path)
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Invalid model file: ${artifact.path}`)
      fingerprints.push(`${artifact.path}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`)
    }
    const fingerprint = root + ':' + fingerprints.join('|')
    if (this.verified.get(model.id) !== fingerprint) {
      for (const artifact of model.artifacts) await verifyFile(artifactPath(root, artifact.path), artifact)
      this.verified.set(model.id, fingerprint)
    }
    return root
  }
  async models(): Promise<ModelInfo[]> {
    await this.initialized
    return Promise.all(MODEL_MANIFESTS.map(async model => {
      const sizeBytes = model.artifacts.reduce((n, a) => n + a.sizeBytes, 0)
      const info: ModelInfo = { id: model.id, name: model.name, engine: model.engine, kind: model.kind,
        languages: model.languages, license: model.license, sizeBytes, status: 'missing', progress: 0 }
      const installation = this.installations[model.id]
      if (installation?.status === 'downloading') return { ...info, ...installation }
      try {
        await this.verifyModel(model)
        return { ...info, status: 'ready' as const, progress: 100,
          ...(!this.executablePaths[model.engine] ? { error: `${model.engine} 실행 파일을 먼저 설정하세요. 모델은 검증되었습니다.` } : {}) }
      } catch (error) {
        if (installation?.status === 'error') return { ...info, ...installation }
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return info
        return { ...info, status: 'error' as const, error: (error as Error).message }
      }
    }))
  }
  async installModel(id: string): Promise<void> {
    await this.initialized
    if (this.disposed) throw new Error('Engine manager disposed')
    const model = manifest(id)
    if (this.downloads.has(id)) throw new Error('Model installation already running')
    const controller = new AbortController()
    this.downloads.set(id, controller)
    this.installations[id] = { status: 'downloading', progress: 0 }
    await this.persist('install-state.json', this.installations)
    this.emit()
    const total = model.archive?.sizeBytes ?? model.artifacts.reduce((n, a) => n + a.sizeBytes, 0)
    const progress = (bytes: number) => {
      const next = Math.min(99, Math.floor(bytes * 100 / total))
      if (this.installations[id]?.progress !== next) { this.installations[id] = { status: 'downloading', progress: next }; this.emit() }
    }
    try {
      if (model.archive) await this.installArchive(model, progress, controller.signal)
      else await installArtifacts(model.artifacts, join(this.modelDirectory, id), progress, controller.signal)
      this.verified.delete(id)
      await this.verifyModel(model)
      delete this.installations[id]
    } catch (error) {
      this.installations[id] = { status: 'error', progress: 0, error: (error as Error).message }
      throw error
    } finally {
      this.downloads.delete(id)
      await this.persist('install-state.json', this.installations)
      this.emit()
    }
  }
  private async installArchive(model: ModelManifest, progress: (bytes: number) => void, signal: AbortSignal): Promise<void> {
    const staging = join(this.modelDirectory, `.${model.id}-${randomUUID()}.part`)
    const archive = join(staging, 'archive.tar.bz2')
    const extracted = join(staging, 'extracted')
    await diskReserve(this.modelDirectory, model.archive!.sizeBytes + model.artifacts.reduce((n, a) => n + a.sizeBytes, 0))
    await mkdir(staging)
    try {
      await downloadArtifact(model.archive!, archive, progress, signal)
      await executeFile(this.executablePaths.sherpa ?? this.executablePaths.melo ?? (process.platform === 'win32' ? 'python' : 'python3'),
        [await this.helper('unpack.py'), archive, extracted, model.archive!.prefix], { signal, windowsHide: true, maxBuffer: 1024 * 1024 })
      for (const artifact of model.artifacts) await verifyFile(artifactPath(extracted, artifact.path), artifact)
      signal.throwIfAborted()
      await publishDirectory(extracted, join(this.modelDirectory, model.id))
    } finally { await rm(staging, { recursive: true, force: true }) }
  }
  async importModel(id: string, source: string): Promise<void> {
    await this.initialized
    const model = manifest(id)
    if (this.downloads.has(id)) throw new Error('Model installation already running')
    const staging = join(this.modelDirectory, `.${id}-${randomUUID()}.part`)
    const information = await lstat(source)
    if (information.isSymbolicLink()) throw new Error('Model imports cannot use symbolic links')
    if (model.artifacts.length !== 1 && !information.isDirectory()) throw new Error('This model requires a complete offline model directory')
    await diskReserve(this.modelDirectory, model.artifacts.reduce((n, a) => n + a.sizeBytes, 0))
    await mkdir(staging)
    try {
      for (const artifact of model.artifacts) {
        const from = information.isDirectory() ? artifactPath(source, artifact.path) : source
        await verifyFile(from, artifact)
        const destination = artifactPath(staging, artifact.path)
        await mkdir(dirname(destination), { recursive: true })
        await copyFile(from, destination)
        await verifyFile(destination, artifact)
      }
      await publishDirectory(staging, join(this.modelDirectory, id))
      this.verified.delete(id); delete this.installations[id]
      await this.persist('install-state.json', this.installations)
    } catch (error) {
      this.installations[id] = { status: 'error', progress: 0, error: (error as Error).message }
      await this.persist('install-state.json', this.installations)
      throw error
    } finally { await rm(staging, { recursive: true, force: true }); this.emit() }
  }
  async configureEngine(engine: string, path: string): Promise<void> {
    await this.initialized
    if (!['whisper', 'whisper.cpp', 'melo', 'sherpa', 'sherpa-onnx'].includes(engine)) throw new Error('Unsupported engine')
    const key = engine === 'whisper.cpp' ? 'whisper' : engine === 'sherpa-onnx' ? 'sherpa' : engine
    const information = await stat(path)
    if (!information.isFile()) throw new Error('Engine executable must be a file')
    await access(path, constants.X_OK)
    if (key === 'whisper' && !basename(path).startsWith('whisper-server')) throw new Error('Select the whisper-server executable, not whisper-cli')
    if (this.active.size) throw new Error('Wait for or cancel active jobs before changing engines')
    await this.whisper?.worker.dispose(); this.whisper = null
    await this.tts?.worker.dispose(); this.tts = null
    this.executablePaths[key] = resolve(path)
    await this.persist('engine-paths.json', this.executablePaths)
    this.emit()
  }
  async transcribe(sessionId: string): Promise<void> {
    return this.serialize(() => this.queueSession(sessionId, false))
  }
  private async queueSession(sessionId: string, automatic: boolean): Promise<void> {
      await this.initialized
      if (this.disposed) throw new Error('Engine manager disposed')
      const detail = await this.options.store.getSession(sessionId)
      const state = await this.options.store.snapshot()
      const selected = manifest(state.settings.whisperModel)
      if (selected.kind !== 'stt') throw new Error('Selected model is not a speech recognizer')
      // Global snapshots intentionally cap terminal history. Session history is
      // complete and must own cancellation/dedup decisions for these chunks.
      let chunks = detail.chunks.filter(chunk => chunk.status !== 'done' && !detail.jobs.some(j => j.chunkId === chunk.id && j.kind === 'stt' && (automatic || j.status !== 'canceled' && j.status !== 'failed')))
      const remaining = MAX_PENDING - state.jobs.filter(j => ['queued', 'running'].includes(j.status)).length
      if (!automatic && chunks.length > remaining) throw new Error('Inference queue limit (32) reached; finish existing jobs before retrying')
      if (automatic) chunks = chunks.slice(0, Math.max(0, remaining))
      for (const chunk of chunks) {
        const failed = detail.jobs.find(j => j.chunkId === chunk.id && j.modelId === selected.id && ['failed', 'canceled'].includes(j.status))
        if (failed) await this.options.store.updateJob(failed.id, { status: 'queued', error: null, progress: 0 }, failed.generation)
        else await this.options.store.createJob({ sessionId, chunkId: chunk.id, kind: 'stt', text: '', modelId: selected.id })
        await this.options.store.updateChunk(chunk.id, { status: 'queued' })
      }
      this.emit()
  }
  async synthesize(input: SynthOptions): Promise<Job> {
    return this.serialize(async () => {
      await this.initialized
      if (this.disposed) throw new Error('Engine manager disposed')
      if (!input.text.trim() || input.text.length > 10000 || !Number.isFinite(input.speed) || input.speed < 0.5 || input.speed > 2) throw new Error('Enter 1–10000 text characters and speed 0.5–2')
      if (!(input.voiceId in VOICES)) throw new Error('Unsupported TTS voice')
      const state = await this.options.store.snapshot()
      if (state.jobs.filter(j => ['queued', 'running'].includes(j.status)).length >= MAX_PENDING) throw new Error('Inference queue limit (32) reached')
      const modelId = VOICES[input.voiceId as keyof typeof VOICES]
      const job = await this.options.store.createJob({ sessionId: null, chunkId: null, kind: 'tts', text: input.text, modelId })
      await mkdir(join(this.directory, 'job-options'), { recursive: true })
      try { await writeFile(join(this.directory, 'job-options', `${job.id}.json`), JSON.stringify(input), { flag: 'wx', mode: 0o600 }) }
      catch (error) { await this.options.store.updateJob(job.id, { status: 'failed', error: `Cannot save synthesis options: ${(error as Error).message}` }, job.generation); throw error }
      this.emit()
      return job
    })
  }
  async jobAction(id: string, action: 'cancel' | 'retry'): Promise<void> {
    return this.serialize(async () => {
      const state = await this.options.store.snapshot()
      const job = state.jobs.find(j => j.id === id)
      if (!job) throw new Error('Job not found')
      if (action === 'cancel') {
        if (!['queued', 'running'].includes(job.status)) return
        await this.options.store.updateJob(id, { status: 'canceled', error: null }, job.generation)
        this.active.get(id)?.controller.abort()
        if (job.chunkId) await this.options.store.updateChunk(job.chunkId, { status: 'saved' })
      } else {
        if (!['failed', 'canceled'].includes(job.status)) throw new Error('Only failed/canceled jobs can be retried')
        if (state.jobs.filter(j => ['queued', 'running'].includes(j.status)).length >= MAX_PENDING) throw new Error('Inference queue limit reached')
        await this.options.store.updateJob(id, { status: 'queued', progress: 0, error: null, output: null }, job.generation)
        if (job.chunkId) await this.options.store.updateChunk(job.chunkId, { status: 'queued' })
      }
      this.emit()
    })
  }
  async tick(): Promise<void> {
    if (this.disposed) return
    if (this.ticking) return this.ticking
    this.ticking = this.serialize(() => this.schedule()).finally(() => { this.ticking = null })
    return this.ticking
  }
  private async schedule(): Promise<void> {
    await this.initialized
    if (this.disposed) return
    let state = await this.options.store.snapshot()
    if (!this.recovered) {
      for (const job of state.jobs.filter(j => j.status === 'running')) await this.options.store.updateJob(job.id,
        { status: 'failed', error: 'Inference interrupted by application restart; retry this job' }, job.generation)
      this.recovered = true
      state = await this.options.store.snapshot()
    }
    for (const [id, active] of this.active) {
      const job = state.jobs.find(j => j.id === id)
      if (!job || job.status !== 'running') active.controller.abort()
    }
    if (state.settings.autoTranscribe) {
      for (const session of state.sessions) {
        try { await this.queueSession(session.id, true) } catch (error) {
          // Keep chunks intact on overload; the queue fills again after existing jobs finish.
          if (!String(error).includes('queue limit')) throw error
        }
      }
      state = await this.options.store.snapshot()
    }
    for (const kind of ['stt', 'tts'] as const) {
      if ([...this.active.values()].some(a => a.kind === kind)) continue
      const job = state.jobs.filter(j => j.kind === kind && j.status === 'queued').sort((a, b) => a.createdAt - b.createdAt)[0]
      if (!job) continue
      const controller = new AbortController()
      // Insert before asynchronous model loading so consecutive ticks cannot start a duplicate job.
      const entry = { controller, completion: Promise.resolve(), kind }
      this.active.set(job.id, entry)
      entry.completion = this.run(job, controller.signal).finally(() => { this.active.delete(job.id); this.emit() })
    }
  }
  private async run(job: Job, signal: AbortSignal): Promise<void> {
    let temporary: string | null = null
    try {
      const current = await this.options.store.updateJob(job.id, { status: 'running', progress: 5, error: null }, job.generation)
      if (!current || signal.aborted) return
      const model = manifest(job.modelId)
      let root: string
      try { root = await this.verifyModel(model) } catch (error) { throw new Error(`Model ${model.name} is missing or invalid: ${(error as Error).message}`) }
      const executable = this.executablePaths[model.engine]
      if (!executable) throw new Error(`${model.engine} runtime is not installed; run setup-engines or configure its executable`)
      const estimated = model.memoryMiB * 1024 * 1024
      if (estimated > Math.min(8 * 1024 ** 3, freemem() * 0.6)) throw new Error('Insufficient memory for this model; choose a smaller model or close other applications')
      signal.throwIfAborted()
      await this.options.store.updateJob(job.id, { progress: 15 }, job.generation)
      if (job.kind === 'stt') {
        if (!job.sessionId || !job.chunkId) throw new Error('STT job has no audio chunk')
        const session = await this.options.store.getSession(job.sessionId)
        const chunk = session.chunks.find(c => c.id === job.chunkId)
        if (!chunk) throw new Error('Audio chunk was deleted')
        await this.options.store.updateChunk(chunk.id, { status: 'processing' }, { jobId: job.id, generation: job.generation })
        if (!this.whisper || this.whisper.modelId !== model.id) {
          await this.whisper?.worker.dispose()
          this.whisper = { modelId: model.id, worker: new WhisperServer(executable, artifactPath(root, model.artifacts[0].path), Math.max(1, Math.min(4, cpus().length - 1))) }
        }
        const settings = (await this.options.store.snapshot()).settings
        const text = await this.whisper.worker.transcribe(await this.options.store.resolveAsset(job.sessionId, chunk.file), settings.language, signal)
        signal.throwIfAborted()
        await this.options.store.updateChunk(chunk.id, { transcript: text, status: 'done' }, { jobId: job.id, generation: job.generation })
        await this.options.store.updateJob(job.id, { status: 'completed', progress: 100, text }, job.generation)
      } else {
        if (!this.tts || this.tts.modelId !== model.id) {
          await this.tts?.worker.dispose()
          this.tts = { modelId: model.id, worker: new JsonLineWorker({ executable, args: ['-u', await this.helper('tts-worker.py'), '--engine', model.engine, '--models', root],
            env: { HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', TOKENIZERS_PARALLELISM: 'false', OMP_NUM_THREADS: '2', MKL_NUM_THREADS: '2' } }) }
        }
        const input = JSON.parse(await readFile(join(this.directory, 'job-options', `${job.id}.json`), 'utf8')) as SynthOptions
        const temporaryDirectory = join(this.directory, 'temporary')
        await diskReserve(temporaryDirectory, 64 * 1024 * 1024)
        temporary = join(temporaryDirectory, `${job.id}-${job.generation}-${randomUUID()}.wav`)
        const result = await this.tts.worker.request({ text: job.text, voice: input.voiceId, speed: input.speed, output: temporary }, signal) as { output?: string }
        if (result?.output !== temporary) throw new Error('Engine returned an unexpected output path')
        signal.throwIfAborted()
        const output = await this.options.store.importOutput(job.id, temporary, job.generation)
        await this.options.store.updateJob(job.id, { status: 'completed', progress: 100, output }, job.generation)
      }
    } catch (error) {
      if (job.kind === 'stt') { await this.whisper?.worker.dispose(); this.whisper = null }
      else { await this.tts?.worker.dispose(); this.tts = null }
      if (!signal.aborted) {
        if (job.chunkId) await this.options.store.updateChunk(job.chunkId, { status: 'failed' }, { jobId: job.id, generation: job.generation })
        await this.options.store.updateJob(job.id, { status: 'failed', error: (error as Error).message, progress: 0 }, job.generation)
      }
    } finally { if (temporary) await rm(temporary, { force: true }).catch(() => {}) }
  }
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const controller of this.downloads.values()) controller.abort()
    for (const active of this.active.values()) active.controller.abort()
    await Promise.allSettled([...this.active.values()].map(a => a.completion))
    await Promise.all([this.whisper?.worker.dispose(), this.tts?.worker.dispose()])
    this.whisper = null; this.tts = null
  }
}

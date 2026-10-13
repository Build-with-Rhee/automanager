import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EngineManager } from '../src/engines'
import { installArtifacts, verifyFile } from '../src/engines/download'
import { JsonLineWorker } from '../src/engines/process'
import { MODEL_MANIFESTS } from '../src/engines/manifests'
import { DEFAULT_SETTINGS, type Job, type StoreAPI, type AudioChunk } from '../src/shared/types'
import { TrackerStore } from '../src/storage'

let directory: string
const disposables: Array<{ dispose(): Promise<void> }> = []
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'automanager-engines-')) })
afterEach(async () => {
  await Promise.all(disposables.splice(0).map(item => item.dispose()))
  vi.unstubAllGlobals()
  await rm(directory, { recursive: true, force: true })
})
const digest = (data: string) => createHash('sha256').update(data).digest('hex')

function memoryStore(chunks: AudioChunk[] = []) {
  const jobs: Job[] = []
  let deleted = false
  const settings = { ...DEFAULT_SETTINGS }
  const api = {
    snapshot: async () => ({ sessions: chunks.length ? [{ id: 'session' }] : [], jobs: jobs.map(j => ({ ...j })), settings, schedules: [] }),
    getSession: async (id: string) => {
      if (deleted || id !== 'session') throw new Error('Session not found')
      return { session: { id }, steps: [], chunks, jobs }
    },
    createJob: async (input: Partial<Job>) => {
      const job: Job = { id: `job-${jobs.length}`, sessionId: null, chunkId: null, kind: 'tts', status: 'queued',
        progress: 0, createdAt: Date.now(), updatedAt: Date.now(), error: null, text: '',
        modelId: 'melo-ko', output: null, generation: 0, ...input }
      jobs.push(job)
      return { ...job }
    },
    updateJob: async (id: string, patch: Partial<Job>, generation?: number) => {
      const job = jobs.find(j => j.id === id)
      if (!job || generation !== undefined && generation !== job.generation) return null
      if (patch.status === 'canceled' || patch.status === 'queued' && ['failed', 'canceled'].includes(job.status)) job.generation++
      Object.assign(job, patch)
      return { ...job }
    },
    updateChunk: async (id: string, patch: Partial<AudioChunk>, guard?: { jobId: string; generation: number }) => {
      if (guard && !jobs.some(j => j.id === guard.jobId && j.generation === guard.generation && j.status === 'running')) return
      const chunk = chunks.find(c => c.id === id)
      if (chunk) Object.assign(chunk, patch)
    },
    resolveAsset: async () => join(directory, 'audio.wav'),
    deleteSession: async () => { deleted = true; jobs.splice(0); chunks.splice(0) },
    importOutput: async () => 'tts/test.wav'
  }
  return { store: api as unknown as StoreAPI, jobs, chunks, settings }
}
const chunk = (index: number): AudioChunk => ({ id: `chunk-${index}`, sessionId: 'session', sequence: index,
  file: `audio/${index}.wav`, startedAt: 0, offsetMs: index * 30000, durationMs: 30000,
  sampleCount: 480000, transcript: '', status: 'saved' })
const manager = (store: StoreAPI) => {
  const result = new EngineManager({ store, dataDirectory: directory,
    resourcesDirectory: join(directory, 'resources'), onChange: () => {} })
  disposables.push(result)
  return result
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000
  while (!check()) { if (Date.now() > deadline) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 10)) }
}

describe('verified model files', () => {
  it('rejects a corrupted file with the right length', async () => {
    const path = join(directory, 'model.bin')
    await writeFile(path, 'bad')
    await expect(verifyFile(path, { sizeBytes: 3, sha256: digest('yes') })).rejects.toThrow(/checksum/i)
  })
  it('publishes verified downloads atomically and removes a corrupt staging directory', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad')))
    const destination = join(directory, 'model')
    await expect(installArtifacts([{ path: 'weights.bin', url: 'https://example.test/model',
      sizeBytes: 3, sha256: digest('yes') }], destination)).rejects.toThrow(/checksum/i)
    expect(await readdir(directory)).toEqual([])
    vi.stubGlobal('fetch', vi.fn(async () => new Response('yes')))
    await installArtifacts([{ path: 'weights.bin', url: 'https://example.test/model',
      sizeBytes: 3, sha256: digest('yes') }], destination)
    expect(await readFile(join(destination, 'weights.bin'), 'utf8')).toBe('yes')
  })
  it('rejects insecure URLs and escaping artifact paths', async () => {
    const asset = { path: '../escape', url: 'https://example.test/model', sizeBytes: 1, sha256: digest('x') }
    await expect(installArtifacts([asset], join(directory, 'model'))).rejects.toThrow(/path/i)
    await expect(installArtifacts([{ ...asset, path: 'weights', url: 'http://example.test/model' }], join(directory, 'model'))).rejects.toThrow(/https/i)
  })
  it('manifests pin every model file, including Korean tokenizer and BERT assets', () => {
    expect(MODEL_MANIFESTS.some(m => m.id === 'melo-ko')).toBe(true)
    for (const model of MODEL_MANIFESTS) for (const file of model.artifacts) {
      expect(file.sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(file.url).toMatch(/^https:\/\//)
      expect(file.sizeBytes).toBeGreaterThan(0)
    }
    const korean = MODEL_MANIFESTS.find(m => m.id === 'melo-ko')!
    expect(korean.artifacts.some(f => f.path.endsWith('bert/pytorch_model.bin'))).toBe(true)
    expect(korean.artifacts.some(f => f.path.endsWith('bert/vocab.txt'))).toBe(true)
  })
})

describe('resident process protocol', () => {
  async function worker(source: string) {
    const script = join(directory, 'worker.cjs')
    await writeFile(script, source)
    const process = new JsonLineWorker({ executable: globalThis.process.execPath, args: [script], timeoutMs: 2000 })
    disposables.push(process)
    return process
  }
  it('keeps one real process resident across requests', async () => {
    const process = await worker(`console.log(JSON.stringify({ready:true}));
      require('readline').createInterface({input:process.stdin}).on('line',l=>{
        const r=JSON.parse(l);console.log(JSON.stringify({id:r.id,result:{pid:process.pid,value:r.value}}))})`)
    const first = await process.request({ value: 1 }) as { pid: number; value: number }
    const second = await process.request({ value: 2 }) as { pid: number; value: number }
    expect(first.pid).toBe(second.pid)
    expect([first.value, second.value]).toEqual([1, 2])
  })
  it('reports a real subprocess exit as failure', async () => {
    const process = await worker(`console.log(JSON.stringify({ready:true}));process.stdin.once('data',()=>{console.error('missing runtime');process.exit(7)})`)
    await expect(process.request({})).rejects.toThrow(/missing runtime|exit.*7/i)
  })
  it('cancels a running subprocess and rejects its outstanding request', async () => {
    const process = await worker(`console.log(JSON.stringify({ready:true}));process.stdin.resume();setInterval(()=>{},1000)`)
    const controller = new AbortController()
    const request = process.request({}, controller.signal)
    const rejected = expect(request).rejects.toThrow(/cancel|abort/i)
    setTimeout(() => controller.abort(), 50)
    await rejected
  })
  it('cancels expensive model startup before the ready handshake', async () => {
    const process = await worker(`process.stdin.resume();setInterval(()=>{},1000)`)
    const controller = new AbortController()
    const rejected = expect(process.request({}, controller.signal)).rejects.toThrow(/cancel|abort/i)
    setTimeout(() => controller.abort(), 50)
    await rejected
  })
  it('settles startup cancellation even when the loader ignores graceful termination', async () => {
    const process = await worker(`process.on('SIGTERM',()=>{});process.stdin.resume();setInterval(()=>{},1000)`)
    const controller = new AbortController()
    const request = process.request({}, controller.signal).then(() => 'succeeded', () => 'aborted')
    setTimeout(() => controller.abort(), 50)
    const outcome = await Promise.race([request, new Promise<string>(resolve => setTimeout(() => resolve('still-loading'), 400))])
    expect(outcome).toBe('aborted')
  })
})

describe('persistent engine jobs', () => {
  it('records a failed install without falsely declaring the model ready', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network unavailable') }))
    const engine = manager(memoryStore().store)
    await expect(engine.installModel('whisper-base')).rejects.toThrow('network unavailable')
    const info = (await engine.models()).find(m => m.id === 'whisper-base')!
    expect(info.status).toBe('error')
    expect(info.error).toContain('network unavailable')
  })
  it('queues each completed chunk once and cancels durable queued work', async () => {
    const state = memoryStore([chunk(0), chunk(1)])
    const engine = manager(state.store)
    await engine.transcribe('session')
    await engine.transcribe('session')
    expect(state.jobs).toHaveLength(2)
    await engine.jobAction(state.jobs[0].id, 'cancel')
    expect(state.jobs[0].status).toBe('canceled')
    expect(state.jobs[0].generation).toBe(1)
    expect(state.chunks[0].transcript).toBe('')
  })
  it('rejects excessive pending work before changing chunk states', async () => {
    const state = memoryStore(Array.from({ length: 100 }, (_, i) => chunk(i)))
    await expect(manager(state.store).transcribe('session')).rejects.toThrow(/queue|대기/i)
    expect(state.jobs).toHaveLength(0)
    expect(state.chunks.every(c => c.status === 'saved')).toBe(true)
  })
  it('fails missing-model jobs truthfully and supports retry with a new generation', async () => {
    const state = memoryStore()
    const engine = manager(state.store)
    const job = await engine.synthesize({ text: '안녕하세요', voiceId: 'melo-ko', speed: 1 })
    await engine.tick()
    await until(() => state.jobs[0].status === 'failed')
    expect(state.jobs[0].error).toMatch(/model|모델/i)
    expect(state.jobs[0].output).toBeNull()
    await engine.jobAction(job.id, 'retry')
    expect(state.jobs[0].status).toBe('queued')
    expect(state.jobs[0].generation).toBe(1)
  })
  it('never revives a job whose session was deleted before scheduling', async () => {
    const state = memoryStore([chunk(0)])
    const engine = manager(state.store)
    await engine.transcribe('session')
    await state.store.deleteSession('session')
    await engine.tick()
    expect(state.jobs).toEqual([])
  })
  it('does not repeatedly enqueue failed or canceled automatic transcription', async () => {
    const state = memoryStore([chunk(0)])
    state.settings.autoTranscribe = true
    const engine = manager(state.store)
    await engine.tick()
    await until(() => state.jobs[0]?.status === 'failed')
    await engine.tick()
    expect(state.jobs).toHaveLength(1)
  })
  it('keeps canceled session chunks canceled after their job ages out of the global snapshot', async () => {
    const store = new TrackerStore(directory)
    const engine = manager(store)
    try {
      const session = await store.createSession({ audio: true, screen: false })
      await store.appendAudio({ sessionId: session.id, pcm: Buffer.alloc(3200), startedAt: session.startedAt, offsetMs: 0 })
      await store.flushAudio(session.id)
      await engine.transcribe(session.id)
      const job = (await store.getSession(session.id)).jobs[0]
      await engine.jobAction(job.id, 'cancel')
      for (let i = 0; i < 201; i++) {
        const newer = await store.createJob({ sessionId: null, chunkId: null, kind: 'tts', text: 'completed history', modelId: 'melo-ko' })
        await store.updateJob(newer.id, { status: 'running' }, newer.generation)
        await store.updateJob(newer.id, { status: 'completed', progress: 100 }, newer.generation)
      }
      expect((await store.snapshot()).jobs.some(item => item.id === job.id)).toBe(false)
      await store.updateSettings({ autoTranscribe: true })
      await engine.tick()
      expect((await store.getSession(session.id)).jobs).toHaveLength(1)
      expect((await store.getSession(session.id)).jobs[0].status).toBe('canceled')
    } finally { await engine.dispose(); await store.close() }
  })
  it('waits for synthesis options to be saved before scheduling its durable job', async () => {
    const state = memoryStore()
    const createJob = state.store.createJob.bind(state.store)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    state.store.createJob = async input => { const result = await createJob(input); await gate; return result }
    const engine = manager(state.store)
    const enqueue = engine.synthesize({ text: '안녕하세요', voiceId: 'melo-ko', speed: 1 })
    await until(() => state.jobs.length === 1)
    const scheduled = engine.tick()
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(state.jobs[0].status).toBe('queued')
    release()
    await enqueue
    await scheduled
  })
  it('validates synthesis input and refuses executable directories', async () => {
    const engine = manager(memoryStore().store)
    await expect(engine.synthesize({ text: '', voiceId: 'melo-ko', speed: 1 })).rejects.toThrow()
    await expect(engine.synthesize({ text: 'hello', voiceId: 'unknown', speed: 1 })).rejects.toThrow()
    await expect(engine.configureEngine('melo', directory)).rejects.toThrow(/executable|file|실행/i)
  })
})

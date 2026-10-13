import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { fork, spawn, spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'
import { TrackerStore } from '../src/storage'

const RATE = 16000
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJxkAAAAASUVORK5CYII=', 'base64')
function wav(pcm: Buffer) {
  const header = Buffer.alloc(44)
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(RATE, 24); header.writeUInt32LE(RATE * 2, 28)
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}
function zipEntries(file: string): Map<string, Buffer> {
  const data = readFileSync(file), files = new Map<string, Buffer>()
  let end = data.length - 22
  while (end >= 0 && data.readUInt32LE(end) !== 0x06054b50) end--
  if (end < 0) throw new Error('ZIP has no central directory')
  let offset = data.readUInt32LE(end + 16)
  for (let index = 0; index < data.readUInt16LE(end + 10); index++) {
    expect(data.readUInt32LE(offset)).toBe(0x02014b50)
    const method = data.readUInt16LE(offset + 10), size = data.readUInt32LE(offset + 20)
    const nameLength = data.readUInt16LE(offset + 28), extra = data.readUInt16LE(offset + 30), comment = data.readUInt16LE(offset + 32)
    const name = data.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    const local = data.readUInt32LE(offset + 42)
    const body = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28)
    const compressed = data.subarray(body, body + size)
    files.set(name, method === 8 ? inflateRawSync(compressed) : compressed)
    offset += 46 + nameLength + extra + comment
  }
  return files
}

describe('durable tracker storage', () => {
  let directory: string
  let store: TrackerStore
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'automanager-store-')); store = new TrackerStore(directory) })
  afterEach(async () => { await store.close(); rmSync(directory, { recursive: true, force: true }) })

  it('preserves a live writer lock and refuses another writer', async () => {
    const original = readFileSync(join(directory, '.writer.lock'), 'utf8')
    expect(() => new TrackerStore(directory)).toThrow(/active writer/)
    expect(readFileSync(join(directory, '.writer.lock'), 'utf8')).toBe(original)
    expect((await store.snapshot()).sessions).toEqual([])
  })

  it.skipIf(process.platform !== 'linux')('recovers a lock held by an actual Linux zombie instead of treating it as a live writer', async () => {
    await store.close()
    const supervisor = spawn('python3', ['-u', '-c', 'import os, signal, sys\npid=os.fork()\nif pid==0: os._exit(0)\ndef stop(*args):\n os.waitpid(pid,0)\n sys.exit(0)\nsignal.signal(signal.SIGTERM,stop)\nprint(pid,flush=True)\nsignal.pause()'], { stdio: ['ignore', 'pipe', 'pipe'] })
    try {
      const pid = await new Promise<number>((resolvePromise, reject) => { supervisor.stdout.once('data', value => resolvePromise(Number(value.toString().trim()))); supervisor.once('error', reject); supervisor.once('exit', code => reject(new Error(`Zombie supervisor exited ${code}`))) })
      const deadline = Date.now() + 2000
      while (!/^State:\s+Z/m.test(readFileSync(`/proc/${pid}/status`, 'utf8')) && Date.now() < deadline) await new Promise(resolvePromise => setTimeout(resolvePromise, 10))
      expect(readFileSync(`/proc/${pid}/status`, 'utf8')).toMatch(/^State:\s+Z/m)
      expect(() => process.kill(pid, 0)).not.toThrow()
      writeFileSync(join(directory, '.writer.lock'), JSON.stringify({pid,token:'crashed-writer'}))
      store = new TrackerStore(directory)
      expect((await store.snapshot()).sessions).toEqual([])
      expect(JSON.parse(readFileSync(join(directory, '.writer.lock'), 'utf8')).pid).toBe(process.pid)
    } finally { supervisor.kill('SIGTERM'); await new Promise<void>(resolvePromise => supervisor.once('exit', () => resolvePromise())) }
  })

  it('persists text-only steps and rejects invalid lifecycle transitions', async () => {
    const session = await store.createSession({ audio: true, screen: false, title: '작업 기록' })
    const step = await store.appendStep({ sessionId: session.id, kind: 'click', description: '버튼 선택', timestamp: session.startedAt, offsetMs: 0 })
    expect(step.screenshot).toBeNull()
    await store.transition(session.id, 'paused', 500)
    await expect(store.appendStep({ sessionId: session.id, kind: 'click', description: '금지', timestamp: Date.now(), offsetMs: 500 })).rejects.toThrow(/paused|기록|상태/)
    await store.transition(session.id, 'recording', 500)
    await store.renameSession(session.id, '바뀐 제목')
    await store.transition(session.id, 'completed', 600)
    await expect(store.transition(session.id, 'recording', 600)).rejects.toThrow()
    await store.close(); store = new TrackerStore(directory)
    const detail = await store.getSession(session.id)
    expect(detail.session).toMatchObject({ title: '바뀐 제목', status: 'completed', stepCount: 1, durationMs: 600 })
    expect(detail.steps[0].description).toBe('버튼 선택')
  })

  it('allows explicit comments on archived sessions without collecting new recorded input', async () => {
    const session = await store.createSession({ audio: false, screen: false })
    await store.transition(session.id, 'completed', 500)
    const now = Date.now()
    const comment = await store.appendStep({ sessionId: session.id, kind: 'comment', description: '검토 후 주석', timestamp: now, offsetMs: 500 })
    expect(comment).toMatchObject({ timestamp: now, offsetMs: 500, kind: 'comment' })
    expect((await store.getSession(session.id)).session.status).toBe('completed')
    await expect(store.appendStep({ sessionId: session.id, kind: 'click', description: '새 입력', timestamp: now, offsetMs: 500 })).rejects.toThrow()
    await expect(store.appendStep({ sessionId: session.id, kind: 'comment', description: '잘못된 시간', timestamp: now, offsetMs: 501 })).rejects.toThrow()
  })

  it('partitions continuous PCM on exact sample boundaries with independent WAV headers', async () => {
    const session = await store.createSession({ audio: true, screen: false })
    const pcm = Buffer.alloc((RATE * 31 + 7) * 2)
    for (let sample = 0; sample < pcm.length / 2; sample++) pcm.writeInt16LE(sample % 30000, sample * 2)
    for (let position = 0; position < pcm.length; position += RATE * 2) {
      await store.appendAudio({ sessionId: session.id, pcm: pcm.subarray(position, position + RATE * 2), startedAt: session.startedAt + position / 32, offsetMs: position / 32 })
    }
    await store.flushAudio(session.id)
    const detail = await store.getSession(session.id)
    expect(detail.chunks.map(chunk => chunk.sampleCount)).toEqual([RATE * 30, RATE + 7])
    expect(detail.chunks.map(chunk => chunk.offsetMs)).toEqual([0, 30000])
    const files = await Promise.all(detail.chunks.map(chunk => store.resolveAsset(session.id, chunk.file)))
    const payloads = files.map(file => {
      const bytes = readFileSync(file)
      expect(bytes.subarray(0, 4).toString()).toBe('RIFF')
      expect(bytes.readUInt32LE(4)).toBe(bytes.length - 8)
      expect(bytes.readUInt32LE(24)).toBe(RATE)
      expect(bytes.readUInt32LE(40)).toBe(bytes.length - 44)
      return bytes.subarray(44)
    })
    expect(Buffer.concat(payloads)).toEqual(pcm)
  })

  it('flushes a partial chunk on pause and starts a separate chunk after the pause gap', async () => {
    const session = await store.createSession({ audio: true, screen: false })
    await store.appendAudio({ sessionId: session.id, pcm: Buffer.alloc(2000), startedAt: session.startedAt, offsetMs: 0 })
    await store.transition(session.id, 'paused', 62.5)
    expect((await store.getSession(session.id)).chunks[0].sampleCount).toBe(1000)
    await expect(store.appendAudio({ sessionId: session.id, pcm: Buffer.alloc(2), startedAt: Date.now(), offsetMs: 5000 })).rejects.toThrow()
    await store.transition(session.id, 'recording', 62.5)
    await store.appendAudio({ sessionId: session.id, pcm: Buffer.alloc(400), startedAt: session.startedAt + 5000, offsetMs: 5000 })
    await store.transition(session.id, 'completed', 75)
    expect((await store.getSession(session.id)).chunks.map(chunk => [chunk.sampleCount, chunk.offsetMs])).toEqual([[1000, 0], [200, 5000]])
  })

  it('retains step text while physically removing screenshots beyond the last N', async () => {
    await store.updateSettings({ screenshotLimit: 2 })
    const session = await store.createSession({ audio: false, screen: true })
    const first = await store.appendStep({ sessionId: session.id, kind: 'click', description: 'one', timestamp: Date.now(), offsetMs: 0, screenshot: PNG })
    const firstPath = await store.resolveAsset(session.id, first.screenshot!)
    for (let index = 1; index < 4; index++) await store.appendStep({ sessionId: session.id, kind: 'click', description: String(index), timestamp: Date.now(), offsetMs: index, screenshot: PNG })
    const detail = await store.getSession(session.id)
    expect(detail.steps).toHaveLength(4)
    expect(detail.steps.filter(step => step.screenshot)).toHaveLength(2)
    expect(existsSync(firstPath)).toBe(false)
    expect(detail.steps[0].warning).toMatch(/한도|retention/)
    await store.updateSettings({ screenshotLimit: 1 })
    expect((await store.getSession(session.id)).steps.filter(step => step.screenshot)).toHaveLength(1)
  })

  it('recovers a journaled partial WAV and interrupts unfinished sessions without duplicate jobs', async () => {
    await store.updateSettings({ autoTranscribe: true })
    const session = await store.createSession({ audio: true, screen: false })
    await store.close()
    const audioDirectory = join(directory, 'sessions', session.id, 'audio')
    writeFileSync(join(audioDirectory, 'recovery-fixture.wav.tmp'), Buffer.concat([wav(Buffer.alloc(642)), Buffer.from([123])]))
    writeFileSync(join(audioDirectory, 'recovery-fixture.wav.journal.json'), JSON.stringify({ version: 1, id: 'recovery-fixture', sessionId: session.id, sequence: 0, startedAt: session.startedAt, offsetMs: 0, chunkSeconds: 30 }))
    store = new TrackerStore(directory)
    let detail = await store.getSession(session.id)
    expect(detail.session.status).toBe('interrupted')
    expect(detail.chunks).toHaveLength(1)
    expect(detail.chunks[0].sampleCount).toBe(321)
    expect(detail.jobs.filter(job => job.kind === 'stt')).toHaveLength(1)
    await store.close(); store = new TrackerStore(directory)
    detail = await store.getSession(session.id)
    expect(detail.chunks).toHaveLength(1)
    expect(detail.jobs.filter(job => job.kind === 'stt')).toHaveLength(1)
  })

  it('rejects misaligned PCM and refuses writes over the configured storage quota', async () => {
    const session = await store.createSession({ audio: true, screen: false })
    await expect(store.appendAudio({ sessionId: session.id, pcm: Buffer.alloc(3), startedAt: session.startedAt, offsetMs: 0 })).rejects.toThrow(/PCM|sample/)
    await store.updateSettings({ storageLimitGiB: 0.00001 })
    await expect(store.appendAudio({ sessionId: session.id, pcm: Buffer.alloc(32000), startedAt: session.startedAt, offsetMs: 0 })).rejects.toThrow(/quota|공간|한도/)
    expect((await store.getSession(session.id)).chunks).toHaveLength(0)
  })

  it('applies the storage quota to text-only input too', async () => {
    const session = await store.createSession({ audio: false, screen: false })
    await store.updateSettings({ storageLimitGiB: 0.00001 })
    await expect(store.appendStep({ sessionId: session.id, kind: 'click', description: '한도 후 입력', timestamp: session.startedAt, offsetMs: 0 })).rejects.toThrow(/quota|한도/)
  })

  it('rejects non-binary and oversized audio calls without pretending they were saved', async () => {
    const session = await store.createSession({ audio: true, screen: false })
    await expect(store.appendAudio({ sessionId: session.id, pcm: { 0: 1 } as unknown as Uint8Array, startedAt: session.startedAt, offsetMs: 0 })).rejects.toThrow(/PCM|binary/)
    await expect(store.appendAudio({ sessionId: session.id, pcm: Buffer.alloc(RATE * 2 * 5), startedAt: session.startedAt, offsetMs: 0 })).rejects.toThrow(/bounded|transport/)
  })

  it('atomically guards late job results and increases generations on cancel and retry', async () => {
    const job = await store.createJob({ sessionId: null, chunkId: null, kind: 'tts', text: '안녕하세요', modelId: 'melo-ko' })
    const canceled = await store.updateJob(job.id, { status: 'canceled' }, job.generation)
    expect(canceled?.generation).toBe(job.generation + 1)
    expect(await store.updateJob(job.id, { status: 'completed' }, job.generation)).toBeNull()
    const retried = await store.updateJob(job.id, { status: 'queued' }, canceled!.generation)
    expect(retried?.generation).toBe(job.generation + 2)
    expect(await store.updateJob(job.id, { status: 'completed' }, canceled!.generation)).toBeNull()
  })

  it('rejects stale STT results after cancellation and a new running retry', async () => {
    const session = await store.createSession({ audio: true, screen: false })
    await store.appendAudio({ sessionId: session.id, pcm: Buffer.alloc(320), startedAt: session.startedAt, offsetMs: 0 })
    const [chunk] = await store.flushAudio(session.id)
    const job = await store.createJob({ sessionId: session.id, chunkId: chunk.id, kind: 'stt', text: '', modelId: 'whisper-small' })
    await store.updateJob(job.id, { status: 'running' })
    const canceled = await store.updateJob(job.id, { status: 'canceled' }, job.generation)
    const retried = await store.updateJob(job.id, { status: 'queued' }, canceled!.generation)
    await store.updateJob(job.id, { status: 'running' }, retried!.generation)
    await store.updateChunk(chunk.id, { transcript: 'stale', status: 'done' }, { jobId: job.id, generation: job.generation })
    expect((await store.getSession(session.id)).chunks[0].transcript).toBe('')
    await store.updateChunk(chunk.id, { transcript: '새 결과', status: 'done' }, { jobId: job.id, generation: retried!.generation })
    expect((await store.getSession(session.id)).chunks[0].transcript).toBe('새 결과')
  })

  it('preserves an already committed STT result when restart precedes job completion', async () => {
    const session = await store.createSession({ audio: true, screen: false })
    await store.appendAudio({ sessionId: session.id, pcm: Buffer.alloc(320), startedAt: session.startedAt, offsetMs: 0 })
    const [chunk] = await store.flushAudio(session.id)
    const job = await store.createJob({ sessionId: session.id, chunkId: chunk.id, kind: 'stt', text: '', modelId: 'whisper-small' })
    await store.updateJob(job.id, { status: 'running' })
    await store.updateChunk(chunk.id, { transcript: '완성된 결과', status: 'done' }, { jobId: job.id, generation: job.generation })
    await store.close(); store = new TrackerStore(directory)
    expect((await store.snapshot()).jobs.find(item => item.id === job.id)).toMatchObject({ status: 'completed', generation: job.generation })
    expect((await store.getSession(session.id)).chunks[0].transcript).toBe('완성된 결과')
  })

  it('restores fsynced PCM from an actual abruptly terminated writer process', async () => {
    await store.close()
    const bundle = await build({ entryPoints: [join(process.cwd(), 'src/storage/index.ts')], platform: 'node', format: 'cjs', bundle: true, external: ['archiver'], write: false })
    const code = bundle.outputFiles[0].text + '\nconst storage=new module.exports.TrackerStore(process.argv[1]); storage.createSession({audio:true,screen:false}).then(async session=>{await storage.appendAudio({sessionId:session.id,pcm:Buffer.alloc(2468),startedAt:session.startedAt,offsetMs:0}); process.stdout.write(session.id); process.kill(process.pid,"SIGKILL")});'
    const child = spawnSync(process.execPath, ['--input-type=commonjs', '-e', code, directory], { cwd: process.cwd(), encoding: 'utf8' })
    expect(child.error).toBeUndefined()
    if (process.platform === 'win32') {
      // Self-SIGKILL uses TerminateProcess on Windows, reported as an exit code.
      expect(child.signal).toBeNull()
      expect(child.status).toBe(1)
    } else {
      expect(child.signal).toBe('SIGKILL')
      expect(child.status).toBeNull()
    }
    expect(child.stdout).toMatch(/^[a-f0-9-]{36}$/)
    store = new TrackerStore(directory)
    const detail = await store.getSession(child.stdout)
    expect(detail.session.status).toBe('interrupted')
    expect(detail.chunks[0].sampleCount).toBe(1234)
    expect(readFileSync(await store.resolveAsset(child.stdout, detail.chunks[0].file)).length).toBe(44 + 2468)
  })

  it('recovers finalized WAV metadata when rename completed before the ready transaction', async () => {
    const session = await store.createSession({ audio: true, screen: false })
    await store.close()
    const journal = { version: 1, id: 'after-rename', sessionId: session.id, sequence: 0, startedAt: session.startedAt, offsetMs: 25, chunkSeconds: 30 }
    const path = `sessions/${session.id}/audio/after-rename.wav`
    writeFileSync(join(directory, path), wav(Buffer.alloc(128)))
    const database = new DatabaseSync(join(directory, 'tracker.sqlite'))
    database.prepare('INSERT INTO artifacts(id,session_id,sequence,kind,path,temporary,journal,state,data) VALUES(?,?,?,?,?,?,?,?,?)').run(journal.id, session.id, 0, 'audio', path, `${path}.tmp`, `${path}.journal.json`, 'pending', JSON.stringify(journal))
    database.close()
    store = new TrackerStore(directory)
    expect((await store.getSession(session.id)).chunks[0]).toMatchObject({ id: journal.id, sampleCount: 64, offsetMs: 25 })
  })

  it('marks missing previously saved audio as failed during recovery', async () => {
    const session = await store.createSession({ audio: true, screen: false })
    await store.appendAudio({ sessionId: session.id, pcm: Buffer.alloc(320), startedAt: session.startedAt, offsetMs: 0 })
    await store.transition(session.id, 'completed', 10)
    const [chunk] = (await store.getSession(session.id)).chunks
    const file = await store.resolveAsset(session.id, chunk.file)
    await store.close(); rmSync(file)
    store = new TrackerStore(directory)
    const detail = await store.getSession(session.id)
    expect(detail.chunks[0].status).toBe('failed')
    expect(detail.steps.some(step => step.warning?.includes('audio'))).toBe(true)
    await expect(store.resolveAsset(session.id, chunk.file)).rejects.toThrow()
  })

  it('reattaches a screenshot after file publication precedes its DB ready transaction', async () => {
    const session = await store.createSession({ audio: false, screen: true })
    const step = await store.appendStep({ sessionId: session.id, kind: 'click', description: '화면 저장 도중 종료', timestamp: session.startedAt, offsetMs: 0 })
    await store.close()
    const path = `sessions/${session.id}/screens/after-rename.png`
    writeFileSync(join(directory, path), PNG)
    const database = new DatabaseSync(join(directory, 'tracker.sqlite'))
    database.prepare('INSERT INTO artifacts(id,session_id,kind,path,state,data) VALUES(?,?,?,?,?,?)').run('after-rename-screen', session.id, 'screenshot', path, 'pending', JSON.stringify({ stepId: step.id }))
    database.close()
    store = new TrackerStore(directory)
    expect((await store.getSession(session.id)).steps[0].screenshot).toBe('screens/after-rename.png')
    expect(readFileSync(await store.resolveAsset(session.id, 'screens/after-rename.png'))).toEqual(PNG)
  })

  it('deletes all session assets and jobs and rejects late updates', async () => {
    const session = await store.createSession({ audio: true, screen: true })
    await store.appendAudio({ sessionId: session.id, pcm: Buffer.alloc(200), startedAt: session.startedAt, offsetMs: 0 })
    const [chunk] = await store.flushAudio(session.id)
    const job = await store.createJob({ sessionId: session.id, chunkId: chunk.id, kind: 'stt', text: '', modelId: 'whisper-small' })
    await store.deleteSession(session.id)
    expect(existsSync(join(directory, 'sessions', session.id))).toBe(false)
    expect((await store.snapshot()).jobs).toHaveLength(0)
    expect(await store.updateJob(job.id, { status: 'completed' }, job.generation)).toBeNull()
    await expect(store.getSession(session.id)).rejects.toThrow()
  })

  it('removes related TTS namespace assets when deleting their session', async () => {
    const session = await store.createSession({ audio: false, screen: false })
    const source = join(directory, 'engine.wav'); writeFileSync(source, wav(Buffer.alloc(320)))
    const job = await store.createJob({ sessionId: session.id, chunkId: null, kind: 'tts', text: '세션 음성', modelId: 'melo-ko' })
    await store.updateJob(job.id, { status: 'running' })
    const output = await store.importOutput(job.id, source, job.generation)
    const path = await store.resolveAsset('tts', output)
    await store.deleteSession(session.id)
    expect(existsSync(path)).toBe(false)
    await expect(store.resolveAsset('tts', output)).rejects.toThrow()
  })

  it('persists validated settings and schedules across reopening', async () => {
    await store.updateSettings({ chunkSeconds: 15, language: 'ko', storageLimitGiB: 2 })
    await expect(store.updateSettings({ chunkSeconds: 12 as 15 })).rejects.toThrow()
    const schedule = await store.saveSchedule({ title: '매일', enabled: true, startTime: '09:30', durationMinutes: 20, days: [1, 2, 3], nextRun: 42, lastRun: null })
    await store.close(); store = new TrackerStore(directory)
    expect((await store.snapshot()).settings.chunkSeconds).toBe(15)
    expect((await store.snapshot()).schedules).toEqual([schedule])
    await store.deleteSchedule(schedule.id)
    expect((await store.snapshot()).schedules).toHaveLength(0)
  })

  it('imports real TTS WAVs into a separate safe asset namespace', async () => {
    const source = join(directory, 'engine.wav'); writeFileSync(source, wav(Buffer.alloc(320)))
    const job = await store.createJob({ sessionId: null, chunkId: null, kind: 'tts', text: '음성', modelId: 'melo-ko' })
    await store.updateJob(job.id, { status: 'running' })
    const output = await store.importOutput(job.id, source)
    expect(readFileSync(await store.resolveAsset('tts', output))).toEqual(readFileSync(source))
    await expect(store.resolveAsset('tts', '../tracker.sqlite')).rejects.toThrow()
    await expect(store.resolveAsset('tts', source)).rejects.toThrow()
    const bad = join(directory, 'invalid.wav'); writeFileSync(bad, 'not audio')
    await expect(store.importOutput(job.id, bad)).rejects.toThrow(/WAV|audio/)
    await store.updateJob(job.id, { status: 'canceled' })
    await expect(store.importOutput(job.id, source)).rejects.toThrow(/canceled|취소/)
  })

  it('finishes a published TTS output on restart instead of synthesizing a duplicate', async () => {
    const source = join(directory, 'engine.wav'); writeFileSync(source, wav(Buffer.alloc(320)))
    const job = await store.createJob({ sessionId: null, chunkId: null, kind: 'tts', text: '음성', modelId: 'melo-ko' })
    await store.updateJob(job.id, { status: 'running' })
    const output = await store.importOutput(job.id, source, job.generation)
    await store.close(); store = new TrackerStore(directory)
    expect((await store.snapshot()).jobs.find(item => item.id === job.id)).toMatchObject({ status: 'completed', generation: job.generation, output })
    expect(readdirSync(join(directory, 'tts'))).toEqual([output])
  })

  it('exports a readable escaped HTML/MHTML report, JSON and complete media in ZIP', async () => {
    const session = await store.createSession({ audio: true, screen: true, title: '<작업 & 기록>' })
    await store.appendStep({ sessionId: session.id, kind: 'comment', description: '<script>alert(1)</script>', timestamp: session.startedAt, offsetMs: 0, screenshot: PNG })
    await store.appendAudio({ sessionId: session.id, pcm: Buffer.alloc(320), startedAt: session.startedAt, offsetMs: 0 })
    await store.transition(session.id, 'completed', 10)
    const archive = join(directory, 'report.zip'); await store.exportSession(session.id, archive)
    const files = zipEntries(archive)
    expect(files.has('report.html')).toBe(true); expect(files.has('report.mhtml')).toBe(true); expect(files.has('session.json')).toBe(true)
    const html = files.get('report.html')!.toString('utf8')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>alert')
    expect(files.get('report.mhtml')!.toString('utf8')).toContain('multipart/related')
    const detail = JSON.parse(files.get('session.json')!.toString('utf8'))
    expect(files.get(detail.chunks[0].file)!.subarray(0, 4).toString()).toBe('RIFF')
    expect(files.get(detail.steps[0].screenshot)).toEqual(PNG)
    expect(readdirSync(directory).some(file => file.endsWith('.tmp'))).toBe(false)
  })

  it('protects ongoing capture by refusing an archive export while another session is active', async () => {
    const archived = await store.createSession({ audio: false, screen: false })
    await store.transition(archived.id, 'completed', 0)
    await store.createSession({ audio: true, screen: false })
    await expect(store.exportSession(archived.id, join(directory, 'blocked.zip'))).rejects.toThrow(/기록.*종료|recording/)
    expect(existsSync(join(directory, 'blocked.zip'))).toBe(false)
  })

  it('handles real binary IPC calls in order and rejects unknown worker methods', async () => {
    await store.close()
    const bundle = await build({ entryPoints: [join(process.cwd(), 'src/workers/store-worker.ts')], platform: 'node', format: 'cjs', bundle: true, external: ['archiver'], write: false })
    const workerFile = join(directory, 'store-worker.cjs'); writeFileSync(workerFile, bundle.outputFiles[0].text)
    const child = fork(workerFile, [directory], { serialization: 'advanced', stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env, NODE_PATH: join(process.cwd(), 'node_modules') } })
    const pending = new Map<string, {resolve:(value:any)=>void;reject:(error:Error)=>void}>()
    let stderr = ''
    child.stderr!.on('data', chunk => { stderr += chunk.toString() })
    child.on('message', value => { const message = value as {id:string;result?:unknown;error?:string}; const request = pending.get(message.id); if (request) { pending.delete(message.id); message.error ? request.reject(new Error(message.error)) : request.resolve(message.result) } })
    child.on('error', error => { for (const request of pending.values()) request.reject(error) })
    child.on('exit', () => { for (const request of pending.values()) request.reject(new Error(`Worker exited: ${stderr}`)) })
    let next = 0
    const call = (method:string, ...args:unknown[]) => new Promise<any>((resolvePromise, reject) => { const id = String(next++); pending.set(id, {resolve:resolvePromise,reject}); child.send({id,method,args}) })
    try {
      const session = await call('createSession', {audio:true,screen:false})
      const appended = call('appendAudio', {sessionId:session.id,pcm:Buffer.alloc(800),startedAt:session.startedAt,offsetMs:0})
      const paused = call('transition', session.id, 'paused', 25)
      const detail = call('getSession', session.id)
      await appended; await paused
      expect((await detail).chunks[0].sampleCount).toBe(400)
      await expect(call('constructor')).rejects.toThrow('Invalid storage worker request')
      await call('close')
    } finally { child.kill('SIGTERM'); await new Promise<void>(resolvePromise => child.once('exit', () => resolvePromise())) }
    store = new TrackerStore(directory)
  })
})

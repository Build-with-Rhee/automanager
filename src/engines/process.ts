import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'

interface WorkerOptions { executable: string; args: string[]; env?: NodeJS.ProcessEnv; timeoutMs?: number; startupTimeoutMs?: number }
type Pending = { resolve(value: unknown): void; reject(error: Error): void; cleanup(): void }
export class JsonLineWorker {
  private child: ChildProcessWithoutNullStreams | null = null
  private ready: Promise<void> | null = null
  private pending = new Map<string, Pending>()
  private stderr = ''
  private closed = false
  constructor(private options: WorkerOptions) {}
  private start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Engine disposed'))
    if (this.ready) return this.ready
    this.ready = new Promise<void>((resolve, reject) => {
      const child = spawn(this.options.executable, this.options.args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false,
        windowsHide: true, env: { ...process.env, ...this.options.env } })
      this.child = child
      let buffer = ''
      let startup = true
      const timer = setTimeout(() => fail(new Error('Engine startup timed out')), this.options.startupTimeoutMs ?? 180000)
      const fail = (error: Error) => {
        clearTimeout(timer)
        if (startup) { startup = false; reject(error) }
        for (const request of this.pending.values()) { request.cleanup(); request.reject(error) }
        this.pending.clear()
        if (child.exitCode === null) child.kill()
      }
      child.stderr.on('data', data => { this.stderr = (this.stderr + String(data)).slice(-4096) })
      child.on('error', error => fail(new Error(`Engine process failed: ${error.message}`)))
      child.on('exit', (code, signal) => {
        fail(new Error(`Engine exited (${code ?? signal}): ${this.stderr.trim()}`))
        if (this.child === child) { this.child = null; this.ready = null }
      })
      child.stdout.on('data', data => {
        buffer += String(data)
        if (buffer.length > 1024 * 1024) { fail(new Error('Engine response exceeds 1 MiB')); return }
        let newline: number
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1)
          if (!line) continue
          try {
            const result = JSON.parse(line) as { ready?: boolean; error?: string; id?: string; result?: unknown }
            if (startup && result.ready === true) { clearTimeout(timer); startup = false; resolve(); continue }
            if (startup && result.error) { fail(new Error(result.error)); continue }
            if (typeof result.id !== 'string') throw new Error('Invalid resident engine protocol')
            const request = this.pending.get(result.id)
            if (!request) continue
            this.pending.delete(result.id); request.cleanup()
            if (result.error) request.reject(new Error(result.error)); else request.resolve(result.result)
          } catch (error) { fail(new Error(`Invalid engine response: ${(error as Error).message}`)) }
        }
      })
    })
    return this.ready
  }
  async request(payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted()
    // Abort during expensive model startup must terminate the loader as well.
    let rejectStartup: (error: Error) => void = () => {}
    const canceled = new Promise<never>((_, reject) => { rejectStartup = reject })
    const startupAbort = () => {
      this.closed = true
      rejectStartup(new Error('Engine startup canceled'))
      const child = this.child
      child?.kill()
      const force = setTimeout(() => { if (child && child.exitCode === null) child.kill('SIGKILL') }, 1000)
      force.unref()
    }
    signal?.addEventListener('abort', startupAbort, { once: true })
    try { await Promise.race([this.start(), canceled]) } catch (error) {
      if (signal?.aborted) throw new Error('Engine startup canceled')
      throw error
    } finally { signal?.removeEventListener('abort', startupAbort) }
    signal?.throwIfAborted()
    if (this.pending.size) throw new Error('Resident engine is busy')
    const child = this.child
    if (!child || child.exitCode !== null) throw new Error('Engine unavailable')
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const abort = () => { stop(new Error('Engine request canceled')) }
      const stop = (error: Error) => {
        const pending = this.pending.get(id)
        if (!pending) return
        this.pending.delete(id); pending.cleanup(); reject(error)
        child.kill()
        const force = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL') }, 1000)
        force.unref()
      }
      const timer = setTimeout(() => stop(new Error('Engine inference timed out')), this.options.timeoutMs ?? 300000)
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
      this.pending.set(id, { resolve, reject, cleanup })
      signal?.addEventListener('abort', abort, { once: true })
      child.stdin.write(JSON.stringify({ ...payload, id }) + '\n', error => { if (error) stop(error) })
    })
  }
  async dispose(): Promise<void> {
    this.closed = true
    for (const request of this.pending.values()) { request.cleanup(); request.reject(new Error('Engine disposed')) }
    this.pending.clear()
    const child = this.child
    if (!child || child.exitCode !== null) return
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 1000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
      child.kill()
    })
  }
}

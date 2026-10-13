import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') { server.close(); reject(new Error('Cannot allocate engine port')); return }
      server.close(error => error ? reject(error) : resolve(address.port))
    })
  })
}
export class WhisperServer {
  private child: ChildProcessWithoutNullStreams | null = null
  private endpoint = ''
  private ready: Promise<void> | null = null
  private log = ''
  private disposed = false
  constructor(private executable: string, private model: string, private threads = 2) {}
  private async start(signal: AbortSignal): Promise<void> {
    if (this.disposed) throw new Error('Whisper engine disposed')
    if (this.ready) return this.ready
    this.ready = (async () => {
      const port = await freePort()
      signal.throwIfAborted()
      const requestPath = '/' + randomUUID()
      this.endpoint = `http://127.0.0.1:${port}${requestPath}`
      const child = spawn(this.executable, ['--model', this.model, '--host', '127.0.0.1', '--port', String(port),
        '--request-path', requestPath, '--threads', String(this.threads), '--no-gpu'], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      this.child = child
      let failure: Error | null = null
      child.on('error', error => { failure = error })
      for (const stream of [child.stderr, child.stdout]) stream.on('data', value => { this.log = (this.log + String(value)).slice(-4096) })
      const deadline = Date.now() + 180000
      while (Date.now() < deadline) {
        signal.throwIfAborted()
        if (failure) throw failure
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`whisper-server exited: ${this.log}`)
        try {
          const response = await fetch(`${this.endpoint}/health`, { signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]) })
          if (response.ok) return
        } catch (error) { if (signal.aborted) throw error }
        await new Promise<void>(resolve => setTimeout(resolve, 150))
      }
      throw new Error('whisper-server model loading timed out')
    })()
    try { await this.ready } catch (error) { await this.dispose(); throw error }
  }
  async transcribe(file: string, language: string, signal: AbortSignal): Promise<string> {
    const abort = () => { this.child?.kill() }
    signal.addEventListener('abort', abort, { once: true })
    try {
      await this.start(signal)
      const audio = await readFile(file)
      if (audio.length > 8 * 1024 * 1024 || audio.length < 44 || audio.subarray(0, 4).toString() !== 'RIFF') throw new Error('Invalid or excessive WAV input')
      const body = new FormData()
      body.append('file', new Blob([audio]), 'audio.wav')
      body.append('response_format', 'json')
      body.append('language', language || 'auto')
      body.append('temperature', '0')
      const response = await fetch(`${this.endpoint}/inference`, { method: 'POST', body,
        signal: AbortSignal.any([signal, AbortSignal.timeout(300000)]) })
      if (!response.ok) throw new Error(`whisper-server inference failed: HTTP ${response.status}: ${(await response.text()).slice(0, 1000)}`)
      const result = await response.json() as { text?: unknown; transcription?: Array<{ text: string }>; error?: string }
      if (result.error) throw new Error(result.error)
      const text = typeof result.text === 'string' ? result.text : Array.isArray(result.transcription) ? result.transcription.map(s => s.text).join('') : null
      if (text === null || text.length > 1024 * 1024) throw new Error('Whisper returned an invalid transcript')
      return text.trim()
    } catch (error) {
      // A canceled/failed native request may still be computing: stop its process before reuse.
      await this.dispose()
      throw error
    } finally { signal.removeEventListener('abort', abort) }
  }
  async dispose(): Promise<void> {
    this.disposed = true
    const child = this.child
    this.child = null
    if (!child || child.exitCode !== null) return
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 1000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
      child.kill()
    })
  }
}

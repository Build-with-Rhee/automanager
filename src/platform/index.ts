import type { Capability, RecordedAction } from '../shared/types'
import { platformCapabilities } from './capabilities'
import { fork, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { release } from 'node:os'
export interface ActionRecorderOptions {
  onAction: (action: RecordedAction) => void; onError: (error: string) => void;
  excludePid?: number; workerPath?: string;
}
type WorkerMessage =
  | { type: 'ready'; capabilities: Capability[] }
  | { type: 'action'; action: RecordedAction }
  | { type: 'error'; error: string; fatal?: boolean }
  | { type: 'stopped' }

export function createActionRecorder(options: ActionRecorderOptions) {
  const unsupported = () => platformCapabilities({ platform: process.platform, nativeContext: false, wayland: !!process.env.WAYLAND_DISPLAY, arch: process.arch, windowsRelease: process.platform === 'win32' ? release() : undefined })
  let capabilities = unsupported()
  let child: ChildProcess | null = null
  let starting: Promise<void> | null = null
  let stopping: Promise<void> | null = null
  let running = false
  let startupResolve: (() => void) | null = null
  let startupReject: ((error: Error) => void) | null = null
  let stoppedResolve: (() => void) | null = null
  let startTimer: ReturnType<typeof setTimeout> | null = null
  let stopTimer: ReturnType<typeof setTimeout> | null = null
  let failed = false

  function fail(message: string): void {
    if (!failed) options.onError(message)
    failed = true
    running = false
    capabilities = unsupported()
    startupReject?.(new Error(message))
    startupReject = null
    if (startTimer) clearTimeout(startTimer)
    child?.kill()
  }
  function start(): Promise<void> {
    if (stopping) return stopping.then(start)
    if (running) return Promise.resolve()
    if (starting) return starting
    failed = false
    starting = new Promise<void>((resolve, reject) => { startupResolve = resolve; startupReject = reject })
    const startup = starting
    try {
      const owned = fork(options.workerPath ?? fileURLToPath(new URL('./platform-worker.js', import.meta.url)), [], {
        execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', AUTOMANAGER_RESOURCES_PATH: (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ?? process.env.AUTOMANAGER_RESOURCES_PATH }, serialization: 'json', windowsHide: true
      })
      child = owned
      owned.on('message', (value: unknown) => {
        if (child !== owned || !value || typeof value !== 'object' || !('type' in value)) return
        const message = value as WorkerMessage
        if (message.type === 'ready' && !failed) {
          capabilities = Array.isArray(message.capabilities) ? message.capabilities : unsupported()
          running = true
          if (startTimer) clearTimeout(startTimer)
          startupResolve?.()
          startupResolve = null; startupReject = null
        } else if (message.type === 'action' && running) {
          options.onAction(message.action)
        } else if (message.type === 'error' && typeof message.error === 'string') {
          if (message.fatal) fail(message.error)
          else options.onError(message.error)
        }
      })
      owned.once('error', error => fail(`Capture process could not start: ${error.message}`))
      owned.once('exit', (code, signal) => {
        if (child !== owned) return
        if (!stopping && !failed) fail(`Capture process exited unexpectedly (${signal ?? code ?? 'unknown'}).`)
        child = null; running = false; capabilities = unsupported(); starting = null
        if (startTimer) clearTimeout(startTimer)
        if (stopTimer) clearTimeout(stopTimer)
        stoppedResolve?.(); stoppedResolve = null
      })
      startTimer = setTimeout(() => fail('Operating-system capture startup timed out.'), 8000)
      owned.send({ type: 'start', excludePid: options.excludePid }, error => { if (error) fail(`Capture initialization failed: ${error.message}`) })
    } catch (error) { fail(`Capture process could not start: ${error instanceof Error ? error.message : String(error)}`); child = null }
    return startup.finally(() => { if (!running && !child) starting = null })
  }
  function stop(): Promise<void> {
    if (stopping) return stopping
    if (!child) { starting = null; running = false; return Promise.resolve() }
    stopping = (async () => {
      await starting?.catch(() => {})
      const owned = child
      if (!owned) return
      await new Promise<void>(resolve => {
        stoppedResolve = resolve
        stopTimer = setTimeout(() => {
          options.onError('Capture worker did not drain in time; it was stopped. Pending actions may be missing.')
          owned.kill('SIGKILL')
        }, 5000)
        if (owned.connected) owned.send({ type: 'stop' }, error => { if (error) owned.kill() })
        else owned.kill()
      })
    })().finally(() => { stopping = null; starting = null; running = false; capabilities = unsupported() })
    return stopping
  }
  return {
    start, stop,
    capabilities(): Capability[] { return capabilities.map(item => ({ ...item })) }
  }
}

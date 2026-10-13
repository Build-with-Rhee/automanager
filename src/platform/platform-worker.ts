import { fork, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { release } from 'node:os'
import type { Capability, RecordedAction } from '../shared/types'
import { createInputNormalizer, describeShortcut, type InputEvent, type WindowContext } from './normalizer'
import { platformCapabilities } from './capabilities'
import { createBoundedQueue } from './queue'
import { sampleX11Foreground } from './foreground'
import { loadWindowsBridge, type NativeElement, type WindowsBridge } from './windows-context'

const send = (message: unknown): void => { if (process.connected) process.send?.(message) }
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)
const require = createRequire(import.meta.url)

class ElementHelper {
  private child: ChildProcess | null = null
  private requestId = 0
  private pending = new Map<number, { resolve: (value: NativeElement) => void; timer: ReturnType<typeof setTimeout> }>()
  private ready = false
  private readyResolve: (() => void) | null = null
  constructor(private readonly nativePath: string) {}
  private launch(): ChildProcess {
    if (this.child) return this.child
    const child = fork(fileURLToPath(import.meta.url), ['--uia-helper'], {
      execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', AUTOMANAGER_WINDOWS_NATIVE: this.nativePath }
    })
    this.child = child
    this.ready = false
    child.on('message', (message: { type?: string; id?: number; element?: NativeElement }) => {
      if (message?.type === 'helper-ready') { if (this.child === child) this.ready = true; this.readyResolve?.(); this.readyResolve = null; return }
      if (typeof message?.id !== 'number') return
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer); this.pending.delete(message.id)
      pending.resolve(message.element ?? { unavailable: true })
    })
    const close = () => { if (this.child === child) { this.child = null; this.ready = false; this.clearPending() } }
    child.once('exit', close); child.once('error', close)
    return child
  }
  async initialize(): Promise<void> {
    this.launch()
    if (this.ready) return
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.readyResolve = null; this.stop(); reject(new Error('UI Automation helper startup timed out.')) }, 3000)
      this.readyResolve = () => { clearTimeout(timer); resolve() }
    })
  }
  query(context: WindowContext, action: RecordedAction): Promise<NativeElement> {
    const child = this.launch()
    if (!this.ready) return Promise.resolve({ unavailable: true })
    const id = ++this.requestId
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(id); resolve({ unavailable: true })
        if (this.child === child) this.child = null
        this.ready = false
        child.kill('SIGKILL')
        this.launch()
      }, 180)
      this.pending.set(id, { resolve, timer })
      if (!child.connected) { clearTimeout(timer); this.pending.delete(id); resolve({ unavailable: true }); return }
      child.send({ type: 'element', id, handle: context.handle, processId: context.processId, x: action.x ?? 0, y: action.y ?? 0, keyboard: action.kind === 'shortcut' }, error => {
        if (!error) return
        clearTimeout(timer); this.pending.delete(id); resolve({ unavailable: true })
      })
    })
  }
  private clearPending(): void {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.resolve({ unavailable: true }) }
    this.pending.clear()
  }
  stop(): void { this.child?.kill(); this.child = null; this.ready = false; this.clearPending() }
}

async function captureWorker(): Promise<void> {
  let active = false
  let started = false
  let bridge: WindowsBridge | null = null
  let helper: ElementHelper | null = null
  let hook: typeof import('uiohook-napi').uIOhook | null = null
  let normalizer: ReturnType<typeof createInputNormalizer> | null = null
  let eventSequence = 0
  let dropped = 0
  let gapQueued = false
  let currentCapabilities: Capability[] = []
  const queue = createBoundedQueue(12, error => send({ type: 'error', error: `Action metadata failed: ${errorText(error)}` }))
  const rawQueue = createBoundedQueue(12, error => send({ type: 'error', error: `Input sampling failed: ${errorText(error)}` }))

  function reportDrop(count = 1): void {
    dropped += count
    if (!gapQueued) { gapQueued = true; send({ type: 'error', error: 'Action capture overloaded; a visible gap will be added to the timeline.' }) }
  }
  function emitGap(): void {
    if (!dropped) return
    send({ type: 'action', action: { kind: 'gap', description: `${dropped} input events omitted because the bounded capture queue was full.`, appName: '', windowTitle: '', timestamp: Date.now() } satisfies RecordedAction })
    dropped = 0; gapQueued = false
  }
  function actionReady(action: RecordedAction, context: WindowContext | null): void {
    if (!queue.enqueue(async () => {
      if (helper && context && !action.warning) {
        const element = await helper.query(context, action)
        if (element.appName) action.appName = element.appName.slice(0, 120)
        if (element.unavailable) action.warning = 'UI Automation target changed, was inaccessible, or exceeded its timeout; control details omitted.'
        else if (!element.password && element.name) {
          const name = element.name.replace(/[\u0000-\u001f]/g, ' ').slice(0, 160)
          action.description += ` on "${name}"${element.controlType ? ` (${element.controlType.slice(0, 50)})` : ''}`
        }
      }
      send({ type: 'action', action })
      emitGap()
    })) reportDrop()
  }

  async function start(excludePid?: number): Promise<void> {
    if (started) return
    if (process.platform === 'linux' && (process.env.WAYLAND_DISPLAY || !process.env.DISPLAY)) throw new Error('Global actions require an X11 desktop. Wayland and headless input capture are unsupported.')
    if (process.platform === 'win32' && (process.arch !== 'x64' || Number(release().split('.')[0]) < 10)) throw new Error('Windows action capture requires Windows 10/11 x64. Legacy Windows and Windows ARM64 are unsupported.')
    if (process.platform !== 'linux' && process.platform !== 'win32') throw new Error('Global action capture is supported on Windows 10/11 x64, with a best-effort Linux X11 fallback.')
    normalizer = createInputNormalizer({ onAction: actionReady, excludePid })
    active = true
    const native = loadWindowsBridge()
    if (native) {
      bridge = native.bridge
      helper = new ElementHelper(native.path)
      try { await helper.initialize() }
      catch (error) { helper.stop(); helper = null; send({ type: 'error', error: `Named controls unavailable: ${errorText(error)}` }) }
      bridge.start(event => {
        if (!active) return
        if (event.dropped) reportDrop(event.dropped)
        normalizer?.push(event)
      })
    } else {
      const module = require('uiohook-napi') as typeof import('uiohook-napi')
      hook = module.uIOhook
      const keys = new Map(Object.entries(module.UiohookKey).map(([name, code]) => [code, name]))
      const types = new Map<number, InputEvent['type']>([[4, 'keydown'], [5, 'keyup'], [7, 'mousedown'], [8, 'mouseup'], [11, 'wheel']])
      hook.on('input', event => {
        const type = types.get(event.type)
        if (!active || !type) return
        const timestamp = Date.now()
        const key = 'keycode' in event ? keys.get(event.keycode) : undefined
        const raw: InputEvent = {
          type, timestamp, eventId: `fallback-${++eventSequence}`, context: null, contextQuality: 'sampled',
          key, modifiers: { ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey },
          ...('x' in event ? { x: event.x, y: event.y } : {}),
          ...('button' in event ? { button: typeof event.button === 'number' ? event.button : 1 } : {}),
          ...('rotation' in event ? { rotation: event.rotation, amount: event.amount, direction: event.direction === 4 ? 'horizontal' as const : 'vertical' as const } : {})
        }
        // Ignore printable-key events before any asynchronous metadata lookup.
        if (type === 'keydown' && !describeShortcut(raw)) return
        if (!rawQueue.enqueue(async () => {
          raw.context = process.platform === 'linux' && type !== 'keyup' && type !== 'mouseup' ? await sampleX11Foreground() : null
          normalizer?.push(raw)
        })) { reportDrop(); normalizer?.reset() }
      })
      hook.start()
      if (process.platform === 'win32') send({ type: 'error', error: 'Windows native context bridge is unavailable. Actions are captured without exact window identity or named controls. Build with npm run native:win.' })
    }
    started = true
    currentCapabilities = platformCapabilities({ platform: process.platform, nativeContext: !!bridge, wayland: !!process.env.WAYLAND_DISPLAY, hookActive: true, namedControls: !!helper, arch: process.arch, windowsRelease: process.platform === 'win32' ? release() : undefined })
    send({ type: 'ready', capabilities: currentCapabilities })
  }

  async function stop(): Promise<void> {
    // Native stop resolves only after its queued callbacks are delivered.
    if (bridge) { const stopped = await bridge.stop(); if (stopped?.dropped) reportDrop(stopped.dropped) }
    hook?.stop()
    active = false
    await rawQueue.drain()
    normalizer?.reset()
    await queue.drain()
    emitGap(); helper?.stop()
    started = false
    if (process.connected) process.send?.({ type: 'stopped' }, () => process.exit(0))
    else process.exit(0)
  }
  let commands: Promise<void> = Promise.resolve()
  process.on('message', (message: { type?: string; excludePid?: number }) => {
    commands = commands.then(async () => {
      if (message?.type === 'start') await start(message.excludePid)
      if (message?.type === 'stop') await stop()
    }).catch(error => { send({ type: 'error', error: errorText(error), fatal: true }); helper?.stop(); process.exitCode = 1 })
  })
  process.on('disconnect', () => { void stop().catch(() => process.exit(1)) })
}

function uiAutomationHelper(): void {
  const native = loadWindowsBridge()
  if (!native) { process.exitCode = 1; return }
  process.on('message', (message: { type?: string; id: number; handle: string; processId: number; x: number; y: number; keyboard: boolean }) => {
    if (message?.type !== 'element') return
    try { send({ id: message.id, element: native.bridge.getElement(message.handle, message.processId, message.x, message.y, message.keyboard) }) }
    catch { send({ id: message.id, element: { unavailable: true } }) }
  })
  send({ type: 'helper-ready' })
  process.on('disconnect', () => process.exit(0))
}

if (process.argv.includes('--uia-helper')) uiAutomationHelper()
else void captureWorker().catch(error => send({ type: 'error', error: errorText(error), fatal: true }))

import { describe, expect, it } from 'vitest'
import { createInputNormalizer, type InputEvent, type WindowContext } from '../src/platform/normalizer'
import { platformCapabilities } from '../src/platform/capabilities'
import type { RecordedAction } from '../src/shared/types'
import { createActionRecorder } from '../src/platform/index'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createBoundedQueue } from '../src/platform/queue'
import { parseX11Context } from '../src/platform/foreground'

const app = (title = 'Original window', processId = 42): WindowContext => ({
  handle: '1234', processId, appName: 'editor.exe', title, capturedAt: 1000
})
const input = (type: InputEvent['type'], patch: Partial<InputEvent> = {}): InputEvent => ({
  type, timestamp: 1000, eventId: 'event-1', context: app(), contextQuality: 'event-time',
  x: 10, y: 20, button: 1, ...patch
})
const harness = (excludePid?: number) => {
  const actions: RecordedAction[] = []
  return { actions, normalizer: createInputNormalizer({ onAction: action => actions.push(action), excludePid }) }
}

describe('desktop input privacy and normalization', () => {
  it('ignores ordinary typed characters and exposes no raw input text', () => {
    const { actions, normalizer } = harness()
    for (const key of ['a', '1', '한', 'password-value']) normalizer.push(input('keydown', { key }))
    expect(actions).toEqual([])
    normalizer.push(input('keydown', { key: 'C', modifiers: { ctrl: true } }))
    expect(actions).toHaveLength(1)
    expect(actions[0].description).toBe('Ctrl+C')
    expect(JSON.stringify(actions)).not.toContain('password-value')
  })

  it('records navigation keys and named modifier shortcuts without interpreting text', () => {
    const { actions, normalizer } = harness()
    normalizer.push(input('keydown', { key: 'Enter' }))
    normalizer.push(input('keyup', { key: 'Enter' }))
    normalizer.push(input('keydown', { key: 'F5', modifiers: { shift: true } }))
    expect(actions.map(action => action.description)).toEqual(['Enter', 'Shift+F5'])
  })

  it('supports modified punctuation and space without recording plain whitespace', () => {
    const { actions, normalizer } = harness()
    normalizer.push(input('keydown', { key: 'Space' }))
    normalizer.push(input('keydown', { key: 'Space', modifiers: { ctrl: true } }))
    normalizer.push(input('keydown', { key: 'Equal', modifiers: { ctrl: true, shift: true } }))
    expect(actions.map(action => action.description)).toEqual(['Ctrl+Space', 'Ctrl+Shift+Equal'])
  })

  it('retains the mouse-down target when a click changes foreground focus', () => {
    const { actions, normalizer } = harness()
    normalizer.push(input('mousedown'))
    normalizer.push(input('mouseup', { timestamp: 1040, context: app('Next foreground'), eventId: 'event-2' }))
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({ kind: 'click', windowTitle: 'Original window', eventId: 'event-1', timestamp: 1000 })
  })

  it('marks late context unavailable instead of borrowing a new foreground identity', () => {
    const { actions, normalizer } = harness()
    normalizer.push(input('mousedown', { context: { ...app('New window'), capturedAt: 1300 } }))
    normalizer.push(input('mouseup'))
    expect(actions[0].windowTitle).toBe('')
    expect(actions[0].warning).toMatch(/context/i)
  })

  it('distinguishes drags, double clicks and horizontal scrolls', () => {
    const { actions, normalizer } = harness()
    normalizer.push(input('mousedown'))
    normalizer.push(input('mouseup', { timestamp: 1100, x: 60, y: 80 }))
    normalizer.push(input('mousedown', { timestamp: 2000, context: { ...app(), capturedAt: 2000 } }))
    normalizer.push(input('mouseup', { timestamp: 2040 }))
    normalizer.push(input('mousedown', { timestamp: 2150, context: { ...app(), capturedAt: 2150 } }))
    normalizer.push(input('mouseup', { timestamp: 2200 }))
    normalizer.push(input('wheel', { timestamp: 2300, rotation: -120, direction: 'horizontal', context: null }))
    expect(actions.map(action => action.kind)).toEqual(['drag', 'click', 'double-click', 'scroll'])
    expect(actions[0].description).toContain('(60, 80)')
    expect(actions[3].description).toMatch(/horizontal/i)
  })

  it('drops the recorder process and suppresses repeated keydown events', () => {
    const { actions, normalizer } = harness(42)
    normalizer.push(input('keydown', { key: 'Enter' }))
    normalizer.push(input('keyup', { key: 'Enter' }))
    normalizer.push(input('keydown', { key: 'Enter', context: app('Other', 43) }))
    normalizer.push(input('keydown', { key: 'Enter', context: app('Other', 43) }))
    expect(actions).toHaveLength(1)
  })

  it('reports sampled fallback metadata and omits UI names for password controls', () => {
    const { actions, normalizer } = harness()
    normalizer.push(input('mousedown', {
      contextQuality: 'sampled', context: { ...app(), element: { name: 'secret', controlType: 'Edit', password: true } }
    }))
    normalizer.push(input('mouseup'))
    expect(actions[0].warning).toMatch(/sampled/i)
    expect(actions[0].description).not.toContain('secret')
  })

  it('reset discards incomplete gestures and pressed keys across pause boundaries', () => {
    const { actions, normalizer } = harness()
    normalizer.push(input('mousedown'))
    normalizer.reset()
    normalizer.push(input('mouseup'))
    expect(actions).toEqual([])
  })
})

describe('truthful platform capabilities', () => {
  it('does not advertise Windows readiness when its native hook has not loaded', () => {
    const capabilities = platformCapabilities({ platform: 'win32', nativeContext: false })
    expect(capabilities.find(item => item.name === 'event-time-window-context')?.supported).toBe(false)
    expect(capabilities.find(item => item.name === 'named-controls')?.supported).toBe(false)
    expect(capabilities.find(item => item.name === 'secure-desktop')?.supported).toBe(false)
  })

  it('does not advertise global capture on Wayland', () => {
    const capabilities = platformCapabilities({ platform: 'linux', wayland: true, nativeContext: false })
    expect(capabilities.find(item => item.name === 'global-actions')?.supported).toBe(false)
  })

  it('rejects unsupported Windows architecture and legacy releases', () => {
    for (const support of [
      { platform: 'win32' as const, arch: 'arm64', windowsRelease: '10.0.22631', nativeContext: true, hookActive: true },
      { platform: 'win32' as const, arch: 'x64', windowsRelease: '6.1.7601', nativeContext: true, hookActive: true }
    ]) expect(platformCapabilities(support).find(item => item.name === 'global-actions')?.supported).toBe(false)
  })
})

describe('owned capture process lifecycle', () => {
  it('starts one process, forwards actions and drains it before stop resolves', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'automanager-platform-'))
    const workerPath = join(directory, 'worker.cjs')
    await writeFile(workerPath, `process.on('message', m => {
      if (m.type === 'start') {
        process.send({type:'ready',capabilities:[{name:'global-actions',supported:true,detail:'fixture'}]});
        process.send({type:'action',action:{kind:'click',description:'Click',appName:'editor',windowTitle:'Target',timestamp:123}});
      }
      if (m.type === 'stop') {
        process.send({type:'action',action:{kind:'scroll',description:'Final scroll',appName:'editor',windowTitle:'Target',timestamp:124}});
        process.send({type:'stopped'}, () => process.exit(0));
      }
    });`)
    const actions: RecordedAction[] = []
    const errors: string[] = []
    const recorder = createActionRecorder({ workerPath, onAction: action => actions.push(action), onError: error => errors.push(error) })
    try {
      await Promise.all([recorder.start(), recorder.start()])
      expect(recorder.capabilities().find(item => item.name === 'global-actions')?.supported).toBe(true)
      await recorder.stop()
      expect(actions.map(action => action.kind)).toEqual(['click', 'scroll'])
      expect(errors).toEqual([])
      await recorder.stop()
    } finally { await recorder.stop(); await rm(directory, { recursive: true, force: true }) }
  })

  it('rejects failed hook startup and leaves capture unsupported', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'automanager-platform-'))
    const workerPath = join(directory, 'worker.cjs')
    await writeFile(workerPath, `process.on('message', m => { if(m.type==='start') process.send({type:'error',error:'Hook unavailable',fatal:true}); });`)
    const errors: string[] = []
    const recorder = createActionRecorder({ workerPath, onAction: () => {}, onError: error => errors.push(error) })
    try {
      await expect(recorder.start()).rejects.toThrow('Hook unavailable')
      expect(errors).toContain('Hook unavailable')
      expect(recorder.capabilities().find(item => item.name === 'global-actions')?.supported).toBe(false)
    } finally { await recorder.stop(); await rm(directory, { recursive: true, force: true }) }
  })

  it('can stop while the capture process is still becoming ready', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'automanager-platform-'))
    const workerPath = join(directory, 'worker.cjs')
    await writeFile(workerPath, `process.on('message', m => {
      if(m.type==='start') setTimeout(() => process.send({type:'ready',capabilities:[]}),30);
      if(m.type==='stop') process.exit(0);
    });`)
    const errors: string[] = []
    const recorder = createActionRecorder({ workerPath, onAction: () => {}, onError: error => errors.push(error) })
    try {
      const startup = recorder.start()
      await recorder.stop()
      await startup
      expect(errors).toEqual([])
    } finally { await recorder.stop(); await rm(directory, { recursive: true, force: true }) }
  })
})

describe('bounded capture work', () => {
  it('preserves accepted order, rejects overload and drains accepted work', async () => {
    let release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    const written: number[] = []
    const queue = createBoundedQueue(2)
    expect(queue.enqueue(async () => { await barrier; written.push(1) })).toBe(true)
    expect(queue.enqueue(async () => { written.push(2) })).toBe(true)
    expect(queue.enqueue(async () => { written.push(3) })).toBe(false)
    release()
    await queue.drain()
    expect(written).toEqual([1, 2])
  })

  it('reads only window identity fields from X11 properties', () => {
    const context = parseX11Context('0x123', '_NET_WM_PID(CARDINAL) = 77\nWM_CLASS(STRING) = "editor", "Editor"\n_NET_WM_NAME(UTF8_STRING) = "Document"', 1000)
    expect(context).toEqual({ handle: '0x123', processId: 77, appName: 'Editor', title: 'Document', capturedAt: 1000 })
  })
})

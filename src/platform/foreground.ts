import type { WindowContext } from './normalizer'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const execute = promisify(execFile)

export function parseX11Context(handle: string, properties: string, capturedAt: number): WindowContext | null {
  if (!/^0x[0-9a-f]+$/i.test(handle) || /^0x0+$/i.test(handle)) return null
  const processId = Number(properties.match(/_NET_WM_PID\([^)]*\)\s*=\s*(\d+)/)?.[1])
  const title = properties.match(/_NET_WM_NAME\([^)]*\)\s*=\s*"(.*)"/)?.[1] ?? ''
  const appName = properties.match(/WM_CLASS\([^)]*\)\s*=\s*"[^"]*",\s*"([^"]*)"/)?.[1] ?? ''
  if (!Number.isInteger(processId) || processId <= 0) return null
  return { handle, processId, appName: appName.slice(0, 120), title: title.slice(0, 400), capturedAt }
}

/** X11 fallback only: lookup is explicitly sampled, never claimed to be event-time. */
export async function sampleX11Foreground(): Promise<WindowContext | null> {
  if (process.platform !== 'linux' || process.env.WAYLAND_DISPLAY || !process.env.DISPLAY) return null
  try {
    const root = await execute('xprop', ['-root', '_NET_ACTIVE_WINDOW'], { timeout: 60, maxBuffer: 4096 })
    const handle = root.stdout.match(/0x[0-9a-f]+/i)?.[0]
    if (!handle || /^0x0+$/i.test(handle)) return null
    const properties = await execute('xprop', ['-id', handle, '_NET_WM_PID', 'WM_CLASS', '_NET_WM_NAME'], { timeout: 60, maxBuffer: 8192 })
    const current = await execute('xprop', ['-root', '_NET_ACTIVE_WINDOW'], { timeout: 40, maxBuffer: 4096 })
    if (current.stdout.match(/0x[0-9a-f]+/i)?.[0] !== handle) return null
    return parseX11Context(handle, properties.stdout, Date.now())
  } catch { return null }
}

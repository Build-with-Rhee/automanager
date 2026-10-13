import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { InputEvent } from './normalizer'

export interface NativeElement {
  name?: string; controlType?: string; password?: boolean; unavailable?: boolean; appName?: string;
}
export interface WindowsBridge {
  start(callback: (event: InputEvent & { dropped?: number }) => void): void;
  stop(): Promise<{ dropped: number }>;
  getElement(handle: string, processId: number, x: number, y: number, keyboard: boolean): NativeElement;
}

export function loadWindowsBridge(): { bridge: WindowsBridge; path: string } | null {
  if (process.platform !== 'win32') return null
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ?? process.env.AUTOMANAGER_RESOURCES_PATH
  const candidates = [
    process.env.AUTOMANAGER_WINDOWS_NATIVE,
    resourcesPath ? join(resourcesPath, 'native', 'windows_context.node') : undefined,
    resolve(dirname(fileURLToPath(import.meta.url)), '../../native/windows-context/build/Release/windows_context.node'),
    resolve(process.cwd(), 'native/windows-context/build/Release/windows_context.node')
  ].filter((path): path is string => !!path)
  const require = createRequire(import.meta.url)
  for (const path of candidates) {
    if (!existsSync(path)) continue
    try {
      const bridge = require(path) as WindowsBridge
      if (typeof bridge.start === 'function' && typeof bridge.stop === 'function' && typeof bridge.getElement === 'function') return { bridge, path }
    } catch { /* The worker reports degraded capabilities if the addon is unavailable. */ }
  }
  return null
}

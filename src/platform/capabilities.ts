import type { Capability } from '../shared/types'
export interface PlatformSupport { platform: NodeJS.Platform; nativeContext: boolean; wayland?: boolean; hookActive?: boolean; namedControls?: boolean; arch?: string; windowsRelease?: string }
export function platformCapabilities(support: PlatformSupport): Capability[] {
  const windows = support.platform === 'win32' && (!support.arch || support.arch === 'x64') && (!support.windowsRelease || Number(support.windowsRelease.split('.')[0]) >= 10)
  const x11 = support.platform === 'linux' && !support.wayland
  const hook = (windows || x11) && !!support.hookActive
  return [
    { name: 'global-actions', supported: hook, detail: support.wayland ? 'Wayland global input capture is unsupported.' : hook ? 'Global clicks, drags, scrolls and navigation shortcuts; ordinary typed text is discarded.' : 'Available only after the operating-system hook starts successfully.' },
    { name: 'event-time-window-context', supported: windows && support.nativeContext && hook, detail: windows && support.nativeContext ? 'Windows HWND and process identity are frozen in the native input callback.' : 'Exact event-time window identity requires the Windows native bridge; fallback metadata is explicitly sampled.' },
    { name: 'named-controls', supported: windows && support.nativeContext && hook && !!support.namedControls, detail: 'Windows UI Automation names/roles are best effort, bounded by timeout. Password controls and all Value/Text patterns are omitted.' },
    { name: 'secure-desktop', supported: false, detail: 'UAC, logon, locked and secure desktops are not captured. Elevated-app metadata can be unavailable.' },
    { name: 'windows-7', supported: false, detail: 'Supported target is Windows 10/11 x64; modern Electron does not support Windows 7.' }
  ]
}

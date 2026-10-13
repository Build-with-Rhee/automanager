import type { RecordedAction } from '../shared/types'

export interface WindowContext {
  handle: string; processId: number; appName: string; title: string; capturedAt: number;
  element?: { name?: string; controlType?: string; password?: boolean }
}
export interface InputEvent {
  type: 'mousedown' | 'mouseup' | 'mousemove' | 'wheel' | 'keydown' | 'keyup';
  timestamp: number; eventId: string; context: WindowContext | null;
  contextQuality: 'event-time' | 'sampled' | 'unavailable';
  x?: number; y?: number; button?: number; key?: string;
  modifiers?: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean };
  rotation?: number; amount?: number; direction?: 'horizontal' | 'vertical';
}
export interface NormalizerOptions {
  onAction: (action: RecordedAction, context: WindowContext | null) => void;
  excludePid?: number;
}
const navigationKeys = new Set(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PrintScreen', 'Pause'])
const modifiedKeys = new Set(['Space', 'Semicolon', 'Equal', 'Comma', 'Minus', 'Period', 'Slash', 'Backquote', 'BracketLeft', 'Backslash', 'BracketRight', 'Quote', 'NumpadAdd', 'NumpadSubtract', 'NumpadMultiply', 'NumpadDivide', 'NumpadDecimal'])
const clean = (value: string, limit = 400): string => value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, limit)
const distance = (first: InputEvent, second: InputEvent): number => Math.hypot((first.x ?? 0) - (second.x ?? 0), (first.y ?? 0) - (second.y ?? 0))

export function describeShortcut(event: InputEvent): string | null {
  const key = event.key ?? ''
  const modifiers = event.modifiers ?? {}
  const named = navigationKeys.has(key) || /^F(?:[1-9]|1\d|2[0-4])$/.test(key)
  const modifiedCharacter = !!(modifiers.ctrl || modifiers.alt || modifiers.meta) && (/^[a-zA-Z0-9]$/.test(key) || modifiedKeys.has(key) || /^Numpad[0-9]$/.test(key))
  if (!named && !modifiedCharacter) return null
  const prefix = [modifiers.ctrl && 'Ctrl', modifiers.alt && 'Alt', modifiers.shift && 'Shift', modifiers.meta && 'Win'].filter(Boolean)
  return [...prefix, /^[a-zA-Z]$/.test(key) ? key.toUpperCase() : key].join('+')
}

export function createInputNormalizer(options: NormalizerOptions) {
  const presses = new Map<number, InputEvent>()
  const heldKeys = new Set<string>()
  let previousClick: InputEvent | null = null
  function emit(event: InputEvent, kind: RecordedAction['kind'], description: string): void {
    if (options.excludePid !== undefined && event.context?.processId === options.excludePid) return
    // Context obtained after an async lookup must never be attributed to the old event.
    const context = event.context && Math.abs(event.context.capturedAt - event.timestamp) <= 75 ? event.context : null
    let warning = context ? undefined : 'Window context unavailable or captured too late.'
    if (context && event.contextQuality !== 'event-time') warning = 'Window context sampled after input; exact event-time target is unavailable.'
    const element = context?.element
    if (element && !element.password && element.name) description += ` on "${clean(element.name, 160)}"${element.controlType ? ` (${clean(element.controlType, 50)})` : ''}`
    options.onAction({
      kind, description, appName: clean(context?.appName ?? '', 120), windowTitle: clean(context?.title ?? ''),
      timestamp: event.timestamp, eventId: event.eventId,
      ...(Number.isFinite(event.x) && Number.isFinite(event.y) ? { x: event.x, y: event.y } : {}),
      ...(warning ? { warning } : {})
    }, context)
  }
  return {
    push(event: InputEvent): void {
      if (!Number.isFinite(event.timestamp)) return
      if (event.type === 'keyup') { if (event.key) heldKeys.delete(event.key); return }
      if (event.type === 'keydown') {
        const key = event.key ?? ''
        const description = describeShortcut(event)
        if (!description) return
        if (heldKeys.has(key)) return
        heldKeys.add(key)
        emit(event, 'shortcut', description)
        return
      }
      if (event.type === 'mousedown') {
        presses.set(event.button ?? 1, { ...event, context: event.context ? { ...event.context } : null })
        return
      }
      if (event.type === 'mouseup') {
        const button = event.button ?? 1
        const start = presses.get(button)
        presses.delete(button)
        if (!start) return
        const label = button === 2 ? 'right' : button === 3 ? 'middle' : 'left'
        if (distance(start, event) >= 5) {
          emit(start, 'drag', `Drag with ${label} mouse button from (${start.x ?? 0}, ${start.y ?? 0}) to (${event.x ?? 0}, ${event.y ?? 0})`)
          previousClick = null
        } else {
          const double = previousClick && start.timestamp - previousClick.timestamp >= 0 && start.timestamp - previousClick.timestamp <= 500 && distance(previousClick, start) <= 4 && previousClick.button === start.button && previousClick.context?.handle === start.context?.handle
          emit(start, double ? 'double-click' : 'click', `${double ? 'Double-click' : 'Click'} ${label} mouse button`)
          previousClick = double ? null : start
        }
        return
      }
      if (event.type === 'wheel' && Number.isFinite(event.rotation) && event.rotation !== 0) {
        emit(event, 'scroll', `Scroll ${event.direction ?? 'vertical'} ${event.rotation! > 0 ? 'positive' : 'negative'} (${Math.abs(event.rotation!)} units)`)
      }
    },
    reset(): void { presses.clear(); heldKeys.clear(); previousClick = null }
  }
}

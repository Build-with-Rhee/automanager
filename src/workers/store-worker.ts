import { TrackerStore } from '../storage'
import type { StoreAPI } from '../shared/types'

interface Request { id: number | string; method: keyof StoreAPI; args: unknown[] }
interface Port { on(event: 'message', callback: (event: {data: unknown}) => void): void; postMessage(message: unknown): void }
const parentPort = (process as NodeJS.Process & { parentPort?: Port }).parentPort
const directory = process.argv[2] ?? process.env.AUTOMANAGER_DATA_DIRECTORY
if (!directory) throw new Error('Storage worker requires a data directory')
const store = new TrackerStore(directory)
const allowed = new Set<keyof StoreAPI>(['snapshot', 'createSession', 'transition', 'getSession', 'renameSession', 'deleteSession', 'appendStep', 'appendAudio', 'flushAudio', 'updateSettings', 'createJob', 'updateJob', 'updateChunk', 'saveSchedule', 'deleteSchedule', 'exportSession', 'resolveAsset', 'importOutput', 'close'])
let queue = Promise.resolve()
let queuedBytes = 0
let queuedPcm = 0
let queuedRequests = 0
const send = (message: unknown) => parentPort ? parentPort.postMessage(message) : process.send?.(message)
const receive = (value: unknown) => {
  const message = value as Partial<Request> | null
  if (!message || !['string', 'number'].includes(typeof message.id) || !Array.isArray(message.args) || typeof message.method !== 'string' || !allowed.has(message.method)) {
    send({ id: message?.id, error: 'Invalid storage worker request' }); return
  }
  let bytes = 0, pcmBytes = 0
  for (const argument of message.args) if (argument && typeof argument === 'object') {
    const input = argument as {pcm?:Uint8Array;screenshot?:Uint8Array}
    bytes += (input.pcm?.byteLength ?? 0) + (input.screenshot?.byteLength ?? 0)
    pcmBytes += input.pcm?.byteLength ?? 0
  }
  if (queuedBytes + bytes > 32 * 1024 * 1024 || queuedPcm + pcmBytes > 16000 * 2 * 4 || queuedRequests >= 512) { send({ id: message.id, error: 'Storage IPC queue limit exceeded' }); return }
  queuedBytes += bytes; queuedPcm += pcmBytes; queuedRequests++
  const request = message as Request
  queue = queue.then(async () => {
    try {
      const method = store[request.method] as (...args: unknown[]) => Promise<unknown>
      const result = await method.apply(store, request.args)
      send({ id: request.id, result })
    } catch (error) { send({ id: request.id, error: error instanceof Error ? error.message : String(error) }) }
    finally { queuedBytes -= bytes; queuedPcm -= pcmBytes; queuedRequests-- }
  })
}
if (parentPort) parentPort.on('message', event => receive(event.data))
else process.on('message', receive)
process.on('disconnect', () => { void queue.then(() => store.close()) })
process.on('SIGTERM', () => { void queue.then(() => store.close()).finally(() => process.exit(0)) })

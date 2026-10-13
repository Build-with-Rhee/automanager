import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, open, rename, rm, statfs } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { EnvHttpProxyAgent } from 'undici'

export interface Artifact { path: string; url: string; sizeBytes: number; sha256: string }
export interface Integrity { sizeBytes: number; sha256: string }
let proxy: EnvHttpProxyAgent | undefined
export function artifactPath(directory: string, path: string): string {
  if (!path || isAbsolute(path) || path.includes('\\') || path.includes(':') || path.split('/').some(p => p === '..' || !p)) throw new Error('Invalid artifact path')
  const target = resolve(directory, path)
  if (!target.startsWith(resolve(directory) + sep)) throw new Error('Artifact path escapes model directory')
  return target
}
export async function verifyFile(path: string, expected: Integrity): Promise<void> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Model artifact is not a regular file')
  if (info.size !== expected.sizeBytes) throw new Error(`Model size mismatch: ${basename(path)}`)
  const hash = createHash('sha256')
  for await (const buffer of createReadStream(path)) hash.update(buffer)
  if (hash.digest('hex') !== expected.sha256) throw new Error(`Model checksum mismatch: ${basename(path)}`)
}
export async function diskReserve(directory: string, bytes: number): Promise<void> {
  await mkdir(directory, { recursive: true })
  const filesystem = await statfs(directory)
  if (filesystem.bavail * filesystem.bsize < bytes + 512 * 1024 * 1024) throw new Error('Insufficient disk space: 512 MiB reserve required')
}
function secureURL(input: string): URL {
  const url = new URL(input)
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Model download requires HTTPS')
  return url
}
export async function downloadArtifact(artifact: Artifact, destination: string, progress: (bytes: number) => void = () => {}, signal?: AbortSignal): Promise<void> {
  let url = secureURL(artifact.url)
  let response: Response | undefined
  for (let redirect = 0; redirect <= 5; redirect++) {
    const proxied = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
    if (proxied && !proxy) proxy = new EnvHttpProxyAgent()
    const request = { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(1800000)]) : AbortSignal.timeout(1800000),
      redirect: 'manual' as const, ...(proxied ? { dispatcher: proxy } : {}) }
    response = await fetch(url, request)
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      if (!location || redirect === 5) throw new Error('Too many model download redirects')
      await response.body?.cancel()
      url = secureURL(new URL(location, url).href)
      continue
    }
    break
  }
  if (!response?.ok || !response.body) throw new Error(`Model download failed: HTTP ${response?.status ?? 'unknown'}`)
  const reader = response.body.getReader()
  await mkdir(dirname(destination), { recursive: true })
  const file = await open(destination, 'wx')
  const hash = createHash('sha256')
  let bytes = 0
  try {
    while (true) {
      signal?.throwIfAborted()
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > artifact.sizeBytes) throw new Error('Model download exceeds pinned size')
      hash.update(next.value)
      await file.writeFile(next.value)
      progress(bytes)
    }
    if (bytes !== artifact.sizeBytes) throw new Error('Model download size mismatch')
    if (hash.digest('hex') !== artifact.sha256) throw new Error('Model download checksum mismatch')
    await file.sync()
  } finally {
    await reader.cancel().catch(() => {})
    await file.close()
  }
}
export async function publishDirectory(staging: string, destination: string): Promise<void> {
  const backup = `${destination}.old-${randomUUID()}`
  let hadPrevious = false
  try { await rename(destination, backup); hadPrevious = true } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  try { await rename(staging, destination) } catch (error) {
    if (hadPrevious) await rename(backup, destination)
    throw error
  }
  if (hadPrevious) await rm(backup, { recursive: true, force: true })
}
export async function installArtifacts(artifacts: Artifact[], destination: string, progress: (bytes: number) => void = () => {}, signal?: AbortSignal): Promise<void> {
  for (const artifact of artifacts) { artifactPath(destination, artifact.path); secureURL(artifact.url) }
  const staging = join(dirname(destination), `.${basename(destination)}-${randomUUID()}.part`)
  await diskReserve(dirname(destination), artifacts.reduce((n, a) => n + a.sizeBytes, 0))
  await mkdir(staging)
  let complete = 0
  try {
    for (const artifact of artifacts) {
      await downloadArtifact(artifact, artifactPath(staging, artifact.path), bytes => progress(complete + bytes), signal)
      complete += artifact.sizeBytes
    }
    signal?.throwIfAborted()
    await publishDirectory(staging, destination)
  } finally { await rm(staging, { recursive: true, force: true }) }
}

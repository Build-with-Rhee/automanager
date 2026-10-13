import { afterEach, describe, expect, it, vi } from 'vitest'
import { MicrophoneError, requestMicrophone } from '../src/capture/devices'

const liveStream = { id: 'live-microphone-stream' } as MediaStream
function fixture(failures: unknown[] = []) {
  const requests: MediaStreamConstraints[] = []
  const media: Pick<MediaDevices, 'getUserMedia'> = {
    async getUserMedia(constraints) {
      requests.push(constraints ?? {})
      const failure = failures.shift()
      if (failure) throw failure
      return liveStream
    }
  }
  return { media, requests }
}
const browserError = (name: string, constraint?: string) => Object.assign(new DOMException('Browser media failure', name), constraint ? { constraint } : {})

describe('microphone acquisition and recovery', () => {
  it('opens the explicitly selected microphone with mono capture constraints', async () => {
    const { media, requests } = fixture()
    const result = await requestMicrophone(media, 'selected-input')
    expect(result.stream).toBe(liveStream)
    expect(result.usedDefault).toBe(false)
    expect(result.warning).toBeNull()
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ audio: { deviceId: { exact: 'selected-input' }, channelCount: 1 }, video: false })
  })

  it('retries the default once when the selected device no longer exists', async () => {
    const { media, requests } = fixture([browserError('NotFoundError')])
    const result = await requestMicrophone(media, 'removed-input')
    expect(requests).toHaveLength(2)
    expect((requests[1].audio as MediaTrackConstraints).deviceId).toBeUndefined()
    expect(result).toMatchObject({ stream: liveStream, usedDefault: true })
    expect(result.warning).toMatch(/기본 마이크/)
  })

  it('recovers a stale exact deviceId constraint through the default microphone', async () => {
    const { media, requests } = fixture([browserError('OverconstrainedError', 'deviceId')])
    const result = await requestMicrophone(media, 'stale-input')
    expect(requests).toHaveLength(2)
    expect(result.usedDefault).toBe(true)
  })

  it('reports a missing system microphone without repeating the default request', async () => {
    const { media, requests } = fixture([browserError('NotFoundError')])
    const error = await requestMicrophone(media).catch(error => error)
    expect(error).toBeInstanceOf(MicrophoneError)
    expect(error.kind).toBe('missing')
    expect(error.message).toMatch(/마이크/)
    expect(error.message).toMatch(/설정|연결/)
    expect(requests).toHaveLength(1)
  })

  it('stops after the single default retry also reports no microphone', async () => {
    const { media, requests } = fixture([browserError('NotFoundError'), browserError('NotFoundError')])
    const error = await requestMicrophone(media, 'removed-input').catch(error => error)
    expect(error.kind).toBe('missing')
    expect(requests).toHaveLength(2)
  })

  it.each([
    ['NotAllowedError', 'denied', /권한/],
    ['NotReadableError', 'busy', /사용|연결/]
  ] as const)('never retries %s or hides it as a missing device', async (name, kind, message) => {
    const { media, requests } = fixture([browserError(name)])
    const error = await requestMicrophone(media, 'selected-input').catch(error => error)
    expect(error).toBeInstanceOf(MicrophoneError)
    expect(error.kind).toBe(kind)
    expect(error.message).toMatch(message)
    expect(requests).toHaveLength(1)
  })

  it('does not retry constraints unrelated to device identity', async () => {
    const { media, requests } = fixture([browserError('OverconstrainedError', 'sampleRate')])
    const error = await requestMicrophone(media, 'selected-input').catch(error => error)
    expect(error.kind).toBe('unknown')
    expect(requests).toHaveLength(1)
  })

  it('preserves permission denial after a stale device fallback attempt', async () => {
    const { media, requests } = fixture([browserError('NotFoundError'), browserError('NotAllowedError')])
    const error = await requestMicrophone(media, 'removed-input').catch(error => error)
    expect(error.kind).toBe('denied')
    expect(requests).toHaveLength(2)
  })

  it('treats unknown failures as failures rather than manufacturing a silent stream', async () => {
    const { media, requests } = fixture([new Error('Media stack failed')])
    const error = await requestMicrophone(media).catch(error => error)
    expect(error).toBeInstanceOf(MicrophoneError)
    expect(error.kind).toBe('unknown')
    expect(requests).toHaveLength(1)
  })
})

describe('capture command microphone failure isolation', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

  async function rendererFixture(audioError: unknown, screenError?: unknown) {
    let commandHandler!: (command: unknown) => void
    let resolveResult!: (payload: any) => void
    const displays: DisplayMediaStreamOptions[] = []
    const screenTrack = { stop: () => {}, onended: null }
    const screenStream = { getTracks: () => [screenTrack] } as unknown as MediaStream
    vi.stubGlobal('window', { capture: {
      onCommand: (callback: (command: unknown) => void) => { commandHandler = callback },
      send: (type: string, payload: unknown) => { if (type === 'result') resolveResult(payload) },
      writeAudio: async () => {}
    } })
    vi.stubGlobal('navigator', { mediaDevices: {
      async getUserMedia() { throw audioError },
      async getDisplayMedia(options: DisplayMediaStreamOptions) {
        displays.push(options)
        if (screenError) throw screenError
        return screenStream
      }
    } })
    vi.stubGlobal('document', { createElement: () => ({ videoWidth: 1280, videoHeight: 720, play: async () => {} }) })
    await import('../src/capture/main')
    return {
      displays,
      run(command: { type: string; audio?: boolean; screen?: boolean; sourceId?: string }) {
        const result = new Promise<any>(resolve => { resolveResult = resolve })
        commandHandler({ id: 'test-command', ...command })
        return result
      }
    }
  }

  it.each(['start', 'resume'])('continues %s by requesting screen acquisition when only the microphone is missing', async type => {
    const fixture = await rendererFixture(browserError('NotFoundError'))
    const response = await fixture.run({ type, audio: true, screen: true })
    expect(response.error).toBeUndefined()
    expect(response.result).toMatchObject({ width: 1280, height: 720, audio: false, usedDefaultMicrophone: false })
    expect(response.result.warning).toBe('마이크를 찾을 수 없어 이번 기록은 음성 없이 화면과 작업 단계만 기록합니다. 설정에서 마이크를 확인하세요.')
    expect(fixture.displays).toHaveLength(1)
    await fixture.run({ type: 'stop' })
  })

  it('keeps an audio-only missing-device request as an actionable error', async () => {
    const fixture = await rendererFixture(browserError('NotFoundError'))
    const response = await fixture.run({ type: 'start', audio: true, screen: false })
    expect(response.error).toMatch(/마이크.*설정/)
    expect(response.result).toBeUndefined()
    expect(fixture.displays).toHaveLength(0)
  })

  it.each(['NotAllowedError', 'NotReadableError'])('does not silently disable audio for %s', async name => {
    const fixture = await rendererFixture(browserError(name))
    const response = await fixture.run({ type: 'start', audio: true, screen: true })
    expect(response.error).toMatch(/마이크/)
    expect(response.result).toBeUndefined()
    expect(fixture.displays).toHaveLength(0)
  })

  it('labels a screen failure as screen capture rather than a missing microphone', async () => {
    const fixture = await rendererFixture(browserError('NotFoundError'), browserError('NotFoundError'))
    const response = await fixture.run({ type: 'start', audio: false, screen: true, sourceId: 'screen:fixture' })
    expect(response.error).toMatch(/^화면/)
    expect(response.error).not.toMatch(/^마이크/)
    expect(response.result).toBeUndefined()
  })
})

export type MicrophoneErrorKind = 'missing' | 'denied' | 'busy' | 'unknown'
export class MicrophoneError extends Error {
  constructor(readonly kind: MicrophoneErrorKind, message: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'MicrophoneError'
  }
}

function mediaFailure(error: unknown): { name: string; constraint: string } {
  if (!error || typeof error !== 'object') return { name: '', constraint: '' }
  const value = error as { name?: unknown; constraint?: unknown }
  return {
    name: typeof value.name === 'string' ? value.name : '',
    constraint: typeof value.constraint === 'string' ? value.constraint : ''
  }
}
function microphoneError(error: unknown): MicrophoneError {
  const { name } = mediaFailure(error)
  if (name === 'NotFoundError') return new MicrophoneError('missing', '마이크를 찾을 수 없습니다. 마이크를 연결하거나 설정에서 입력 장치를 확인하세요.', error)
  if (name === 'NotAllowedError') return new MicrophoneError('denied', '마이크 접근 권한이 거부되었습니다. 운영체제 설정에서 마이크 접근 권한을 허용한 뒤 다시 시도하세요.', error)
  if (name === 'NotReadableError') return new MicrophoneError('busy', '마이크 입력을 시작할 수 없습니다. 다른 앱의 마이크 사용을 중지하고 장치 연결을 확인한 뒤 다시 시도하세요.', error)
  return new MicrophoneError('unknown', '마이크 녹음을 시작할 수 없습니다. 입력 장치와 녹음 설정을 확인한 뒤 다시 시도하세요.', error)
}

export async function requestMicrophone(media: Pick<MediaDevices, 'getUserMedia'>, deviceId?: string): Promise<{ stream: MediaStream; usedDefault: boolean; warning: string | null }> {
  const request = (selectedId?: string) => media.getUserMedia({
    audio: {
      ...(selectedId ? { deviceId: { exact: selectedId } } : {}),
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    },
    video: false
  })
  try {
    return { stream: await request(deviceId), usedDefault: false, warning: null }
  } catch (error) {
    const failure = mediaFailure(error)
    const staleDevice = !!deviceId && (failure.name === 'NotFoundError' || (failure.name === 'OverconstrainedError' && failure.constraint === 'deviceId'))
    if (!staleDevice) throw microphoneError(error)
    try {
      return {
        stream: await request(), usedDefault: true,
        warning: '선택한 마이크를 찾을 수 없어 시스템 기본 마이크로 녹음합니다.'
      }
    } catch (fallbackError) { throw microphoneError(fallbackError) }
  }
}

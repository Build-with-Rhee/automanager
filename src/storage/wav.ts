import { closeSync, fstatSync, openSync, readSync } from 'node:fs'

export const SAMPLE_RATE = 16000
export const BYTES_PER_SAMPLE = 2

export function wavHeader(sampleCount: number): Buffer {
  const length = sampleCount * BYTES_PER_SAMPLE
  const header = Buffer.alloc(44)
  header.write('RIFF'); header.writeUInt32LE(length + 36, 4); header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(SAMPLE_RATE, 24); header.writeUInt32LE(SAMPLE_RATE * 2, 28)
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
  header.write('data', 36); header.writeUInt32LE(length, 40)
  return header
}

/** Validate real RIFF/WAVE chunks without loading an entire engine output into RAM. */
export function inspectWav(file: string): { sampleRate: number; sampleCount: number; channels: number; dataBytes: number } {
  const fd = openSync(file, 'r')
  try {
    const size = fstatSync(fd).size, header = Buffer.alloc(12)
    if (readSync(fd, header, 0, 12, 0) !== 12 || header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE' || header.readUInt32LE(4) + 8 !== size) throw new Error('Invalid WAV audio container')
    let offset = 12, format: { channels: number; sampleRate: number; blockAlign: number } | null = null, dataBytes = 0
    for (let count = 0; offset + 8 <= size && count < 256; count++) {
      const chunk = Buffer.alloc(8)
      if (readSync(fd, chunk, 0, 8, offset) !== 8) throw new Error('Truncated WAV audio')
      const id = chunk.toString('ascii', 0, 4), length = chunk.readUInt32LE(4)
      if (offset + 8 + length > size) throw new Error('Truncated WAV audio data')
      if (id === 'fmt ') {
        if (length < 16) throw new Error('Invalid WAV format')
        const fmt = Buffer.alloc(16); readSync(fd, fmt, 0, 16, offset + 8)
        const encoding = fmt.readUInt16LE(0), channels = fmt.readUInt16LE(2), sampleRate = fmt.readUInt32LE(4)
        const blockAlign = fmt.readUInt16LE(12), bits = fmt.readUInt16LE(14)
        if (![1, 3].includes(encoding) || channels < 1 || channels > 8 || sampleRate < 8000 || sampleRate > 192000 || ![8, 16, 24, 32, 64].includes(bits) || blockAlign !== channels * bits / 8 || fmt.readUInt32LE(8) !== sampleRate * blockAlign) throw new Error('Unsupported WAV audio format')
        format = { channels, sampleRate, blockAlign }
      } else if (id === 'data') dataBytes += length
      offset += 8 + length + (length % 2)
    }
    if (!format || !dataBytes || dataBytes % format.blockAlign || offset !== size) throw new Error('WAV audio contains no complete samples')
    return { sampleRate: format.sampleRate, channels: format.channels, sampleCount: dataBytes / format.blockAlign, dataBytes }
  } finally { closeSync(fd) }
}

import models from '../../resources/engines/models.json'
import type { ModelInfo } from '../shared/types'
import type { Artifact } from './download'
export interface ModelManifest extends Pick<ModelInfo, 'id' | 'name' | 'kind' | 'engine' | 'languages' | 'license'> {
  revision: string; memoryMiB: number; artifacts: Artifact[];
  archive?: Artifact & { prefix: string }
}
export const MODEL_MANIFESTS: ModelManifest[] = models as ModelManifest[]
export function manifest(id: string): ModelManifest {
  const model = MODEL_MANIFESTS.find(m => m.id === id)
  if (!model) throw new Error(`Unknown model: ${id}`)
  return model
}
export const VOICES = { 'melo-ko': 'melo-ko', af_heart: 'kokoro-en', 'kokoro-en': 'kokoro-en' } as const

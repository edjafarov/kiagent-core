// Local-llm runtime core: capability checking, backend detection, and model catalog

export {
  checkCapability,
  readHostProbes,
  type HostProbes,
  type CapabilityResult,
  CPU_MIN_RAM_BYTES,
} from './capability';

export {
  detectHostBackend,
  detectBackend,
  parseVulkanDevices,
  type Accel,
  type BackendInfo,
  type VulkanDevice,
} from './backend';

export {
  selectCuratedModel,
  resolveModelOverride,
  modelDir,
  modelTotalBytes,
  CURATED_MODEL,
  E4B_MODEL,
  E2B_MODEL,
  GLM_OCR_MODEL,
  CURATED_TIERS,
  type ModelDescriptor,
  type ModelFile,
  type CuratedTier,
  type ModelSelectInput,
} from './models';

export {
  downloadModel,
  modelFilesPresent,
  DownloadError,
  type DownloadErrorCode,
  type DownloadOptions,
} from './downloader';

export {
  createLocalLlmProvider,
  type LocalLlmProvider,
  type ServerLike,
} from './provider';

export { LlamaServer, type LlamaServerOptions } from './server';

export { chatText, describeImage } from './api';

export const CLOUD_STORAGE_MAX_BYTES = 20 * 1024 ** 3;
export const CLOUD_COMBINED_STORAGE_MAX_BYTES = 30 * 1024 ** 3;
export const RUNTIME_STORAGE_BYTES = 20 * 1024 ** 3;
export const DESKTOP_STORAGE_BYTES = 0;

export function cloudStorageLimits(runtime = RUNTIME_STORAGE_BYTES, desktop = DESKTOP_STORAGE_BYTES) {
  if (!Number.isSafeInteger(runtime) || runtime < 128 * 1024 ** 2 || runtime % (1024 ** 2)) throw new Error('storage size must be whole MiB, at least 128 MiB');
  if (desktop === undefined || desktop === null || desktop === 0) {
    if (runtime > CLOUD_STORAGE_MAX_BYTES) throw new Error('Cloud runtime storage must not exceed 20 GiB per user');
    return { runtime, desktop: 0 };
  }
  if (!Number.isSafeInteger(desktop) || desktop < 128 * 1024 ** 2 || desktop % (1024 ** 2)) throw new Error('storage size must be whole MiB, at least 128 MiB');
  if (runtime > CLOUD_STORAGE_MAX_BYTES || runtime + desktop > CLOUD_COMBINED_STORAGE_MAX_BYTES) throw new Error('combined Cloud storage exceeds per-user ceiling');
  return { runtime, desktop };
}

export function requireDesktopImage(image, development) {
  if (!image) return;
  if (!development && !/^(?:[a-zA-Z0-9./:_-]+@)?sha256:[a-f0-9]{64}$/.test(image)) {
    throw new Error('production CLOUD_DESKTOP_IMAGE must be an immutable image digest when configured');
  }
}

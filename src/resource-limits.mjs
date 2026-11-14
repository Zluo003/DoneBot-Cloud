export const CLOUD_STORAGE_MAX_BYTES = 15 * 1024 ** 3;
export const RUNTIME_STORAGE_BYTES = 5 * 1024 ** 3;
export const DESKTOP_STORAGE_BYTES = 10 * 1024 ** 3;

export function cloudStorageLimits(runtime = RUNTIME_STORAGE_BYTES, desktop = DESKTOP_STORAGE_BYTES) {
  for (const bytes of [runtime, desktop]) {
    if (!Number.isSafeInteger(bytes) || bytes < 128 * 1024 ** 2 || bytes % (1024 ** 2)) throw new Error('storage size must be whole MiB, at least 128 MiB');
  }
  if (runtime + desktop > CLOUD_STORAGE_MAX_BYTES) throw new Error('combined Cloud storage must not exceed 15 GiB per user');
  return { runtime, desktop };
}

export function requireDesktopImage(image, development) {
  if (!development && !image) throw new Error('production Cloud requires CLOUD_DESKTOP_IMAGE for its graphical desktop');
}

const fs = require('fs/promises');
const path = require('path');

const storageRoot = path.resolve(
  process.env.FILE_STORAGE_PATH ||
    (process.env.RENDER ? '/var/data/gallery' : path.join(__dirname, '..', 'data', 'gallery'))
);
const publicRoot = path.resolve(__dirname, '..', 'public');

function getFilePath(storageKey) {
  if (!/^[a-f0-9-]{36}$/i.test(storageKey)) {
    throw new Error('Invalid storage key');
  }
  return path.join(storageRoot, storageKey);
}

async function ensureStorageReady() {
  if (process.env.VERCEL) {
    const err = new Error('Gallery storage requires a persistent disk and is unavailable on Vercel.');
    err.code = 'GALLERY_STORAGE_UNAVAILABLE';
    throw err;
  }
  const relativeToPublic = path.relative(publicRoot, storageRoot);
  if (
    relativeToPublic === '' ||
    (relativeToPublic !== '..' &&
      !relativeToPublic.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativeToPublic))
  ) {
    const err = new Error('Gallery file storage must be outside the public web directory.');
    err.code = 'GALLERY_STORAGE_MISCONFIGURED';
    throw err;
  }
  await fs.mkdir(storageRoot, { recursive: true });
}

module.exports = { fs, storageRoot, getFilePath, ensureStorageReady };

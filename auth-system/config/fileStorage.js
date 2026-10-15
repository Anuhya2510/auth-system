const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { createReadStream } = require('fs');
const { Readable } = require('stream');
const isVercel = Boolean(process.env.VERCEL);

const storageRoot = path.resolve(
  process.env.FILE_STORAGE_PATH || (isVercel
    ? path.join(os.tmpdir(), 'gallery')
    : process.env.RENDER ? '/var/data/gallery' : path.join(__dirname, '..', 'data', 'gallery'))
);
const publicRoot = path.resolve(__dirname, '..', 'public');
const blobAccess = 'private';

function blobClient() {
  return require('@vercel/blob');
}

function getFilePath(storageKey) {
  if (!/^[a-f0-9-]{36}$/i.test(storageKey)) {
    throw new Error('Invalid storage key');
  }
  return path.join(storageRoot, storageKey);
}

async function ensureStorageReady() {
  if (isVercel) {
    const hasOidcCredentials = Boolean(process.env.BLOB_STORE_ID && process.env.VERCEL_OIDC_TOKEN);
    const hasReadWriteToken = Boolean(process.env.BLOB_READ_WRITE_TOKEN);
    if (!hasOidcCredentials && !hasReadWriteToken) {
      const err = new Error('Connect a private Vercel Blob store or configure its read/write token to enable file uploads.');
      err.code = 'GALLERY_STORAGE_NOT_CONFIGURED';
      throw err;
    }
    return;
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

async function storeFile(sourcePath, storageKey, contentType) {
  if (isVercel) {
    const { put } = blobClient();
    await put(storageKey, Readable.toWeb(createReadStream(sourcePath)), {
      access: blobAccess,
      contentType: contentType || 'application/octet-stream',
    });
    await fs.unlink(sourcePath);
    return;
  }
  await fs.rename(sourcePath, getFilePath(storageKey));
}

async function deleteStorageFile(storageKey) {
  if (isVercel) {
    const { del } = blobClient();
    await del(storageKey, { access: blobAccess });
    return;
  }
  await fs.unlink(getFilePath(storageKey));
}

async function storageFileExists(storageKey) {
  if (isVercel) {
    const { head } = blobClient();
    try {
      await head(storageKey, { access: blobAccess });
      return true;
    } catch (err) {
      if (err.status === 404 || err.statusCode === 404) return false;
      throw err;
    }
  }
  try {
    await fs.access(getFilePath(storageKey));
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

async function getStorageStream(storageKey) {
  if (isVercel) {
    const { get } = blobClient();
    const result = await get(storageKey, { access: blobAccess });
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    return Readable.fromWeb(result.stream);
  }
  return createReadStream(getFilePath(storageKey));
}

module.exports = {
  fs, storageRoot, getFilePath, ensureStorageReady, storeFile,
  deleteStorageFile, storageFileExists, getStorageStream, isVercel,
};

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const requireAuth = require('../middleware/requireAuth');
const Gallery = require('../models/Gallery');
const { db, initDb } = require('../config/db');
const {
  fs, storageRoot, getFilePath, ensureStorageReady, storeFile,
  deleteStorageFile, storageFileExists, getStorageObject, isVercel,
} = require('../config/fileStorage');

const router = express.Router();
const RETENTION_DAYS = 30;
const MAX_UPLOAD_SIZE = 25 * 1024 * 1024;
const MAX_BATCH_SIZE = 500;
const PURGE_DIR = path.join(storageRoot, '.purging');

const upload = multer({
  preservePath: true,
  storage: multer.diskStorage({
    destination: async (req, file, callback) => {
      try {
        await ensureStorageReady();
        const incoming = path.join(storageRoot, '.incoming');
        await fs.mkdir(incoming, { recursive: true });
        callback(null, incoming);
      } catch (err) {
        callback(err);
      }
    },
    filename: (req, file, callback) => callback(null, crypto.randomUUID()),
  }),
  limits: { fileSize: MAX_UPLOAD_SIZE, files: 10 },
});

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Upload limit reached. Please try again later.' },
});

function httpError(status, message, code) {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
}

function positiveId(value, label = 'id') {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw httpError(400, `Invalid ${label}.`);
  }
  return id;
}

function rootOrPositiveId(value, label = 'folder id') {
  if (value === undefined || value === null || value === '' || value === '0' || value === 0) return 0;
  return positiveId(value, label);
}

function pageValue(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, maximum);
}

function idArray(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_BATCH_SIZE) {
    throw httpError(400, `Provide at most ${MAX_BATCH_SIZE} ${label}.`);
  }
  const ids = value.map((id) => positiveId(id, label));
  return [...new Set(ids)];
}

function cleanName(value) {
  if (typeof value !== 'string') throw httpError(400, 'A name is required.');
  const name = value.trim().replace(/[\u0000-\u001f\u007f]/g, '');
  if (!name || name === '.' || name === '..' || /[\\/]/.test(name) || name.length > 255) {
    throw httpError(400, 'Names must be 1-255 characters.');
  }
  return name;
}

function uploadPathParts(originalName) {
  const parts = String(originalName || '').split(/[\\/]/).filter(Boolean);
  const cleaned = parts.map((part) => cleanName(part));
  if (!cleaned.length) throw httpError(400, 'One or more uploaded files have an invalid name.');
  return cleaned;
}

function splitExtension(name) {
  const extensionIndex = name.lastIndexOf('.');
  if (extensionIndex <= 0) return [name, ''];
  return [name.slice(0, extensionIndex), name.slice(extensionIndex)];
}

async function uniqueName(ownerId, folderId, proposedName, reserved, restored = false) {
  const [base, extension] = splitExtension(proposedName);
  let name = proposedName;
  let suffix = 1;
  while (
    reserved.has(`${folderId}:${name.toLowerCase()}`) ||
    await Gallery.nameExists(ownerId, folderId, name)
  ) {
    name = `${base} (${restored ? 'restored ' : ''}${suffix})${extension}`;
    suffix += 1;
  }
  reserved.add(`${folderId}:${name.toLowerCase()}`);
  return name;
}

async function assertActiveFolder(ownerId, folderId) {
  if (folderId === 0) return;
  if (!(await Gallery.getFolder(ownerId, folderId))) {
    throw httpError(404, 'Folder not found.');
  }
}

async function collectFolderTree(ownerId, rootFolderId) {
  const folderIds = [rootFolderId];
  let frontier = [rootFolderId];
  while (frontier.length) {
    const children = await Gallery.getActiveFolderChildren(ownerId, frontier);
    frontier = children.map((folder) => Number(folder.id));
    folderIds.push(...frontier);
  }
  return folderIds;
}

async function reconcilePurgeDirectory() {
  await ensureStorageReady();
  if (isVercel) return;
  await fs.mkdir(PURGE_DIR, { recursive: true });
  for (const entry of await fs.readdir(PURGE_DIR)) {
    if (!/^[a-f0-9-]{36}$/i.test(entry)) continue;
    const quarantinedPath = path.join(PURGE_DIR, entry);
    if (await Gallery.getStorageKeyExists(entry)) {
      const originalPath = getFilePath(entry);
      try {
        await fs.access(originalPath);
        await fs.unlink(quarantinedPath);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        await fs.rename(quarantinedPath, originalPath);
      }
    } else {
      await fs.unlink(quarantinedPath);
    }
  }
}

async function purgeGroup(ownerId, groupId) {
  const files = await Gallery.getGroupFiles(ownerId, groupId);
  if (isVercel) {
    for (const file of files) await deleteStorageFile(file.storage_key);
    await Gallery.deleteGroupMetadata(ownerId, groupId);
    return;
  }
  await fs.mkdir(PURGE_DIR, { recursive: true });
  const moved = [];
  try {
    for (const file of files) {
      const source = getFilePath(file.storage_key);
      const destination = path.join(PURGE_DIR, file.storage_key);
      try {
        await fs.rename(source, destination);
        moved.push({ source, destination });
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
    await Gallery.deleteGroupMetadata(ownerId, groupId);
  } catch (err) {
    for (const entry of moved.reverse()) {
      try {
        await fs.rename(entry.destination, entry.source);
      } catch (restoreError) {
        console.error('Could not roll back gallery file purge:', restoreError);
      }
    }
    throw err;
  }
  for (const entry of moved) {
    await fs.unlink(entry.destination);
  }
}

async function ensureGroupFilesPresent(ownerId, groupId) {
  const files = await Gallery.getGroupFiles(ownerId, groupId);
  for (const file of files) {
    if (!(await storageFileExists(file.storage_key))) {
      throw httpError(409, 'A stored file is missing, so the selected items were not restored.', 'RESTORE_CONTENT_MISSING');
    }
  }
}

let cleanupPromise;
function cleanupExpiredItems() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    await initDb();
    await reconcilePurgeDirectory();
    const groups = await Gallery.getExpiredGroups();
    for (const group of groups) {
      if (group.deletion_group) {
        await purgeGroup(Number(group.owner_id), group.deletion_group);
        console.info('Expired gallery deletion group cleaned up.');
      }
    }
  })();
  return cleanupPromise.finally(() => {
    cleanupPromise = null;
  });
}

let cleanupTimer;
function startGalleryCleanup() {
  if (cleanupTimer || process.env.VERCEL) return;
  const run = () => cleanupExpiredItems().catch((err) => {
    console.error('Gallery expiry cleanup failed:', err);
  });
  run();
  cleanupTimer = setInterval(run, 60 * 60 * 1000);
  cleanupTimer.unref();
}

router.use(requireAuth);

router.get('/items', async (req, res, next) => {
  try {
    const ownerId = Number(req.user.userId);
    const folderId = rootOrPositiveId(req.query.folderId);
    const category = ['all', 'photos', 'videos', 'documents', 'folders'].includes(req.query.category)
      ? req.query.category
      : 'all';
    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : '';
    const limit = pageValue(req.query.limit, 100, 100);
    const offset = pageValue(req.query.offset, 0, 1000000);
    const sort = ['name', 'favorites', 'date', 'size', 'type'].includes(req.query.sort) ? req.query.sort : 'name';
    await assertActiveFolder(ownerId, folderId);
    const result = await Gallery.list(ownerId, folderId, category, search, { limit, offset, sort });
    res.json({ success: true, ...result, limit, offset });
  } catch (err) {
    next(err);
  }
});

router.get('/folders', async (req, res, next) => {
  try {
    const result = await db.execute({
      sql: `SELECT id, name, parent_id FROM gallery_folders
        WHERE owner_id = ? AND deleted_at IS NULL ORDER BY lower(name)`,
      args: [Number(req.user.userId)],
    });
    res.json({ success: true, folders: result.rows });
  } catch (err) {
    next(err);
  }
});

router.get('/trash', async (req, res, next) => {
  try {
    const limit = pageValue(req.query.limit, 100, 100);
    const offset = pageValue(req.query.offset, 0, 1000000);
    const sort = ['name', 'date', 'size', 'type'].includes(req.query.sort) ? req.query.sort : 'date';
    const category = ['all', 'photos', 'videos', 'documents', 'folders'].includes(req.query.category)
      ? req.query.category
      : 'all';
    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : '';
    const result = await Gallery.listTrash(Number(req.user.userId), { limit, offset, search, category, sort });
    res.json({ success: true, ...result, limit, offset });
  } catch (err) {
    next(err);
  }
});

router.post('/folders', async (req, res, next) => {
  try {
    const body = req.body || {};
    const ownerId = Number(req.user.userId);
    const name = cleanName(body.name);
    const parentId = rootOrPositiveId(body.parentId);
    await assertActiveFolder(ownerId, parentId);
    if (await Gallery.nameExists(ownerId, parentId, name)) {
      return res.status(409).json({ success: false, message: 'An item with that name already exists here.' });
    }
    const folder = await Gallery.createFolder(ownerId, name, parentId);
    res.status(201).json({ success: true, folder });
  } catch (err) {
    next(err);
  }
});

router.patch('/folders/:id', async (req, res, next) => {
  try {
    const body = req.body || {};
    const ownerId = Number(req.user.userId);
    const folderId = positiveId(req.params.id, 'folder id');
    const name = cleanName(body.name);
    const folder = await Gallery.getFolder(ownerId, folderId);
    if (!folder) return res.status(404).json({ success: false, message: 'Folder not found.' });
    if (
      name.toLowerCase() !== folder.name.toLowerCase()
      && await Gallery.nameExists(ownerId, Number(folder.parent_id), name)
    ) {
      return res.status(409).json({ success: false, message: 'An item with that name already exists here.' });
    }
    await Gallery.renameFolder(ownerId, folderId, name);
    res.json({ success: true, message: 'Folder renamed.' });
  } catch (err) {
    next(err);
  }
});

router.patch('/files/:id', async (req, res, next) => {
  try {
    const body = req.body || {};
    const ownerId = Number(req.user.userId);
    const fileId = positiveId(req.params.id, 'file id');
    const name = cleanName(body.name);
    const file = await Gallery.getFile(ownerId, fileId);
    if (!file) return res.status(404).json({ success: false, message: 'File not found.' });
    if (
      name.toLowerCase() !== file.name.toLowerCase()
      && await Gallery.nameExists(ownerId, Number(file.folder_id), name)
    ) {
      return res.status(409).json({ success: false, message: 'An item with that name already exists here.' });
    }
    await Gallery.renameFile(ownerId, fileId, name);
    res.json({ success: true, message: 'File renamed.' });
  } catch (err) {
    next(err);
  }
});

router.post('/upload', uploadLimiter, (req, res, next) => {
  upload.array('files', 10)(req, res, (err) => {
    if (err) {
      const staged = (req.files || []).filter((file) => file.path);
      Promise.all(staged.map((file) => fs.unlink(file.path).catch((cleanupError) => {
        if (cleanupError.code !== 'ENOENT') console.error('Could not clean failed gallery upload:', cleanupError);
      }))).then(() => next(err));
      return;
    }
    next();
  });
}, async (req, res, next) => {
  const incomingFiles = req.files || [];
  const createdStorageKeys = [];
  const createdFolderIds = new Set();
  try {
    const ownerId = Number(req.user.userId);
    const baseFolderId = rootOrPositiveId(req.body.folderId);
    await ensureStorageReady();
    await assertActiveFolder(ownerId, baseFolderId);
    if (!incomingFiles.length) throw httpError(400, 'Choose at least one file to upload.');
    const totalSize = incomingFiles.reduce((total, file) => total + file.size, 0);
    if (totalSize > 50 * 1024 * 1024) {
      throw httpError(413, 'A single upload cannot exceed 50 MB in total.');
    }

    const items = [];
    for (const file of incomingFiles) {
      const parts = uploadPathParts(file.originalname);
      let folderId = baseFolderId;
      for (const folderName of parts.slice(0, -1)) {
        const existing = await db.execute({
          sql: `SELECT id FROM gallery_folders
            WHERE owner_id = ? AND parent_id = ? AND deleted_at IS NULL AND lower(name) = lower(?)
            LIMIT 1`,
          args: [ownerId, folderId, folderName],
        });
        if (existing.rows[0]) {
          folderId = Number(existing.rows[0].id);
        } else {
          if (await Gallery.nameExists(ownerId, folderId, folderName)) {
            throw httpError(409, `A file already exists with the folder name "${folderName}".`);
          }
          const createdFolder = await Gallery.createFolder(ownerId, folderName, folderId);
          folderId = Number(createdFolder.id);
          createdFolderIds.add(folderId);
        }
      }
      const name = await uniqueName(ownerId, folderId, parts[parts.length - 1], new Set());
      const storageKey = crypto.randomUUID();
      await storeFile(file.path, storageKey, file.mimetype);
      createdStorageKeys.push(storageKey);
      const item = await Gallery.createFile(ownerId, {
        folderId,
        name,
        storageKey,
        mimeType: file.mimetype || 'application/octet-stream',
        size: file.size,
      });
      items.push(item);
    }
    res.status(201).json({ success: true, items });
  } catch (err) {
    try {
      await Gallery.deleteUploadedFiles(Number(req.user.userId), createdStorageKeys);
      await Gallery.deleteEmptyFolders(Number(req.user.userId), [...createdFolderIds].reverse());
    } catch (cleanupError) {
      console.error('Could not roll back gallery upload metadata:', cleanupError);
      return next(cleanupError);
    }
    for (const file of incomingFiles) {
      try {
        await fs.unlink(file.path);
      } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') console.error('Could not remove temporary gallery upload:', cleanupError);
      }
    }
    for (const storageKey of createdStorageKeys) {
      try {
        await deleteStorageFile(storageKey);
      } catch (cleanupError) {
        console.error('Could not roll back gallery upload:', cleanupError);
      }
    }
    next(err);
  }
});

router.post('/trash', async (req, res, next) => {
  try {
    const ownerId = Number(req.user.userId);
    const body = req.body || {};
    const fileIds = idArray(body.fileIds, 'file IDs');
    const folderIds = idArray(body.folderIds, 'folder IDs');
    if (!fileIds.length && !folderIds.length) throw httpError(400, 'Select at least one item to delete.');
    const selectedFolders = [];
    for (const folderId of folderIds) {
      if (!(await Gallery.getFolder(ownerId, folderId))) throw httpError(404, 'One or more folders were not found.');
      selectedFolders.push(folderId);
    }

    const selectedFolderSet = new Set(selectedFolders);
    const topLevelFolders = [];
    for (const folderId of selectedFolders) {
      let folder = await Gallery.getFolder(ownerId, folderId);
      let parentId = Number(folder.parent_id);
      let nested = false;
      while (parentId !== 0) {
        if (selectedFolderSet.has(parentId)) {
          nested = true;
          break;
        }
        folder = await Gallery.getFolder(ownerId, parentId);
        if (!folder) break;
        parentId = Number(folder.parent_id);
      }
      if (!nested) topLevelFolders.push(folderId);
    }

    const coveredFolders = new Set();
    for (const folderId of topLevelFolders) {
      for (const descendantId of await collectFolderTree(ownerId, folderId)) coveredFolders.add(descendantId);
    }
    const selectedFiles = [];
    for (const fileId of fileIds) {
      const file = await Gallery.getFile(ownerId, fileId);
      if (!file) throw httpError(404, 'One or more files were not found.');
      if (!coveredFolders.has(Number(file.folder_id))) selectedFiles.push(fileId);
    }

    const now = new Date();
    const deletedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    for (const folderId of topLevelFolders) {
      const folderTree = await collectFolderTree(ownerId, folderId);
      await Gallery.trashGroup(
        ownerId, crypto.randomUUID(), folderTree, [], deletedAt, expiresAt, [folderId], []
      );
    }
    for (const fileId of selectedFiles) {
      await Gallery.trashGroup(
        ownerId, crypto.randomUUID(), [], [fileId], deletedAt, expiresAt, [], [fileId]
      );
    }

    res.json({
      success: true,
      message: 'Selected items moved to Recently Deleted.',
      count: topLevelFolders.length + selectedFiles.length,
      expiresInDays: RETENTION_DAYS,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/favorites', async (req, res, next) => {
  try {
    const ownerId = Number(req.user.userId);
    const body = req.body || {};
    const fileIds = idArray(body.fileIds, 'file IDs');
    const folderIds = idArray(body.folderIds, 'folder IDs');
    if (fileIds.length + folderIds.length === 0) {
      throw httpError(400, 'Select at least one item to update favorites.');
    }
    if (fileIds.length + folderIds.length > MAX_BATCH_SIZE) {
      throw httpError(400, `Select at most ${MAX_BATCH_SIZE} items.`);
    }
    if (typeof body.isFavorite !== 'boolean') {
      throw httpError(400, 'Favorite status must be true or false.');
    }
    for (const fileId of fileIds) {
      if (!(await Gallery.getFile(ownerId, fileId))) {
        throw httpError(404, 'One or more files were not found.');
      }
    }
    for (const folderId of folderIds) {
      if (!(await Gallery.getFolder(ownerId, folderId))) {
        throw httpError(404, 'One or more folders were not found.');
      }
    }
    await Gallery.setFavorites(ownerId, fileIds, folderIds, body.isFavorite);
    res.json({
      success: true,
      message: body.isFavorite ? 'Selected items added to Favorites.' : 'Selected items removed from Favorites.',
      count: fileIds.length + folderIds.length,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/restore', async (req, res, next) => {
  try {
    const body = req.body || {};
    const ownerId = Number(req.user.userId);
    let fileIds = idArray(body.fileIds, 'file IDs');
    let folderIds = idArray(body.folderIds, 'folder IDs');
    if (body.all === true) {
      const all = await Gallery.listRestorableTrash(ownerId);
      fileIds = all.filter((item) => item.kind === 'file').map((item) => Number(item.id));
      folderIds = all.filter((item) => item.kind === 'folder').map((item) => Number(item.id));
      if (!fileIds.length && !folderIds.length) {
        return res.json({ success: true, message: 'There are no eligible items to restore.' });
      }
    }
    const hasTarget = Object.prototype.hasOwnProperty.call(body, 'targetFolderId');
    const targetFolderId = hasTarget ? rootOrPositiveId(body.targetFolderId) : null;
    if (!fileIds.length && !folderIds.length) throw httpError(400, 'Select at least one item to restore.');
    await ensureStorageReady();
    if (targetFolderId !== null) await assertActiveFolder(ownerId, targetFolderId);

    const reserved = new Set();
    const restoredGroups = new Set();
    const operations = [];
    for (const fileId of fileIds) {
      const file = await Gallery.getFile(ownerId, fileId, { includeDeleted: true });
      if (!file || !file.deleted_at || !file.deletion_root) throw httpError(404, 'One or more deleted files were not found.');
      if (new Date(file.delete_expires_at).getTime() <= Date.now()) {
        throw httpError(410, 'One or more items have expired and can no longer be restored.');
      }
      const groupId = file.deletion_group;
      if (restoredGroups.has(groupId)) continue;
      await ensureGroupFilesPresent(ownerId, groupId);
      const destinationFolder = targetFolderId === null ? Number(file.folder_id) : targetFolderId;
      if (destinationFolder !== 0 && !(await Gallery.getFolder(ownerId, destinationFolder))) {
        if (targetFolderId === null) {
          return res.status(409).json({
            success: false,
            code: 'RESTORE_DESTINATION_REQUIRED',
            message: 'The original folder is no longer available. Choose a destination folder.',
          });
        }
        throw httpError(404, 'The selected destination folder was not found.');
      }
      const name = await uniqueName(ownerId, destinationFolder, file.name, reserved, true);
      operations.push({
        kind: 'file', groupId, id: fileId, destinationFolder, name,
      });
      restoredGroups.add(groupId);
    }

    for (const folderId of folderIds) {
      const folder = await Gallery.getFolder(ownerId, folderId, { includeDeleted: true });
      if (!folder || !folder.deleted_at || !folder.deletion_root) throw httpError(404, 'One or more deleted folders were not found.');
      if (new Date(folder.delete_expires_at).getTime() <= Date.now()) {
        throw httpError(410, 'One or more items have expired and can no longer be restored.');
      }
      const groupId = folder.deletion_group;
      if (restoredGroups.has(groupId)) continue;
      await ensureGroupFilesPresent(ownerId, groupId);
      const destinationFolder = targetFolderId === null ? Number(folder.parent_id) : targetFolderId;
      if (destinationFolder !== 0 && !(await Gallery.getFolder(ownerId, destinationFolder))) {
        if (targetFolderId === null) {
          return res.status(409).json({
            success: false,
            code: 'RESTORE_DESTINATION_REQUIRED',
            message: 'The original folder is no longer available. Choose a destination folder.',
          });
        }
        throw httpError(404, 'The selected destination folder was not found.');
      }
      const name = await uniqueName(ownerId, destinationFolder, folder.name, reserved, true);
      operations.push({
        kind: 'folder', groupId, id: folderId, destinationFolder, name,
      });
      restoredGroups.add(groupId);
    }

    for (const operation of operations) {
      if (operation.kind === 'file') {
        await Gallery.restoreGroup(
          ownerId, operation.groupId, 0, 0, '',
          operation.id, operation.destinationFolder, operation.name
        );
      } else {
        await Gallery.restoreGroup(
          ownerId, operation.groupId, operation.id,
          operation.destinationFolder, operation.name
        );
      }
    }

    res.json({
      success: true,
      message: 'Selected items restored.',
    });
  } catch (err) {
    next(err);
  }
});

router.delete('/permanent', async (req, res, next) => {
  try {
    const ownerId = Number(req.user.userId);
    const body = req.body || {};
    const fileIds = idArray(body.fileIds, 'file IDs');
    const folderIds = idArray(body.folderIds, 'folder IDs');
    await ensureStorageReady();
    const groups = new Set();

    if (body.all === true) {
      for (const groupId of await Gallery.listTrashGroups(ownerId)) groups.add(groupId);
    } else {
      if (!fileIds.length && !folderIds.length) throw httpError(400, 'Select at least one item to delete permanently.');
      for (const fileId of fileIds) {
        const file = await Gallery.getFile(ownerId, fileId, { includeDeleted: true });
        if (!file || !file.deleted_at || !file.deletion_root) throw httpError(404, 'One or more deleted files were not found.');
        groups.add(file.deletion_group);
      }
      for (const folderId of folderIds) {
        const folder = await Gallery.getFolder(ownerId, folderId, { includeDeleted: true });
        if (!folder || !folder.deleted_at || !folder.deletion_root) throw httpError(404, 'One or more deleted folders were not found.');
        groups.add(folder.deletion_group);
      }
    }

    for (const groupId of groups) await purgeGroup(ownerId, groupId);
    res.json({
      success: true,
      message: 'Selected items were permanently deleted and cannot be restored.',
      count: groups.size,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/files/:id/content', async (req, res, next) => {
  try {
    const ownerId = Number(req.user.userId);
    const fileId = positiveId(req.params.id, 'file id');
    await ensureStorageReady();
    const includeDeleted = req.query.deleted === '1';
    const file = await Gallery.getFile(ownerId, fileId, { includeDeleted });
    if (!file) throw httpError(404, 'File not found.');
    if (includeDeleted && (
      !file.deleted_at || new Date(file.delete_expires_at).getTime() <= Date.now()
    )) {
      throw httpError(404, 'File not found.');
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    const inlineTypes = new Set([
      'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif',
      'video/mp4', 'video/webm', 'video/ogg', 'application/pdf',
      'text/plain', 'text/csv',
    ]);
    const stored = await getStorageObject(file.storage_key);
    if (!stored) throw httpError(404, 'File content is missing.');
    if (req.query.inline === '1' && inlineTypes.has(file.mime_type)) {
      res.setHeader('Content-Disposition', 'inline');
      res.type(stored.contentType || (file.mime_type === 'text/csv' ? 'text/plain' : file.mime_type));
      if (Number.isFinite(stored.size)) res.setHeader('Content-Length', stored.size);
      stored.stream.on('error', next);
      return stored.stream.pipe(res);
    }
    res.attachment(file.name);
    res.type(stored.contentType || file.mime_type);
    if (Number.isFinite(stored.size)) res.setHeader('Content-Length', stored.size);
    stored.stream.on('error', next);
    return stored.stream.pipe(res);
  } catch (err) {
    next(err);
  }
});

function uploadErrorHandler(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({
      success: false,
      message: err.code === 'LIMIT_FILE_SIZE'
        ? 'Each file must be 25 MB or smaller.'
        : 'Upload could not be processed. Select up to 10 files at a time.',
    });
  }
  if (err.code === 'GALLERY_STORAGE_UNAVAILABLE') {
    return res.status(503).json({ success: false, message: err.message, code: err.code });
  }
  if (err.code === 'GALLERY_STORAGE_MISCONFIGURED') {
    console.error('Gallery storage configuration error:', err.message);
    return res.status(503).json({ success: false, message: err.message, code: err.code });
  }
  if (err.status) {
    return res.status(err.status).json({ success: false, message: err.message, code: err.code });
  }
  return next(err);
}

router.use(uploadErrorHandler);

module.exports = { router, startGalleryCleanup, cleanupExpiredItems };

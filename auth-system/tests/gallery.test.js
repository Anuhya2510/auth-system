const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const testRoot = path.join(os.tmpdir(), `auth-gallery-${crypto.randomUUID()}`);
process.env.DB_PATH = path.join(testRoot, 'auth.db');
process.env.FILE_STORAGE_PATH = path.join(testRoot, 'files');
process.env.JWT_SECRET = 'gallery-test-secret-that-is-not-used-outside-tests';
process.env.NODE_ENV = 'test';
process.env.TURSO_DATABASE_URL = 'file::memory:';
process.env.TURSO_DB_URL = '';
process.env.TURSO_AUTH_TOKEN = '';
process.env.TURSO_DB_AUTH_TOKEN = '';

const app = require('../server');
const { db, initDb } = require('../config/db');
const Gallery = require('../models/Gallery');
const { signToken } = require('../utils/jwt');
const { cleanupExpiredItems } = require('../routes/gallery');

let server;
let origin;
let ownerId;
let otherUserId;
let ownerToken;
let otherToken;

async function request(url, token, options = {}) {
  const headers = new Headers(options.headers || {});
  if (token) headers.set('Cookie', `auth_token=${token}`);
  return fetch(`${origin}${url}`, { ...options, headers });
}

async function upload(name, text, token = ownerToken, folderId = 0) {
  const body = new FormData();
  body.append('folderId', String(folderId));
  body.append('files', new Blob([text], { type: 'text/plain' }), name);
  const response = await request('/api/gallery/upload', token, { method: 'POST', body });
  return { response, data: await response.json() };
}

async function createFolder(name, parentId = 0, token = ownerToken) {
  const response = await request('/api/gallery/folders', token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, parentId }),
  });
  return { response, data: await response.json() };
}

async function itemExistsInDatabase(id) {
  const result = await db.execute({
    sql: 'SELECT id FROM gallery_files WHERE id = ?',
    args: [id],
  });
  return result.rows.length > 0;
}

test('Gallery enforces ownership and supports recovery, conflicts, and expiry', async (t) => {
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await db.close();
    await fs.rm(testRoot, { recursive: true, force: true });
  });
  await fs.mkdir(testRoot, { recursive: true });
  await initDb();
  const owner = await db.execute({
    sql: `INSERT INTO users (username, email, mobile, password_hash, is_email_verified)
      VALUES ('gallery_owner', 'gallery-owner@example.com', '', 'test-hash', 1) RETURNING id`,
  });
  const other = await db.execute({
    sql: `INSERT INTO users (username, email, mobile, password_hash, is_email_verified)
      VALUES ('gallery_other', 'gallery-other@example.com', '', 'test-hash', 1) RETURNING id`,
  });
  ownerId = Number(owner.rows[0].id);
  otherUserId = Number(other.rows[0].id);
  ownerToken = signToken({ userId: ownerId, email: 'gallery-owner@example.com' });
  otherToken = signToken({ userId: otherUserId, email: 'gallery-other@example.com' });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  origin = `http://127.0.0.1:${server.address().port}`;

  const noSession = await request('/api/gallery/items');
  assert.equal(noSession.status, 401);

  const firstUpload = await upload('notes.txt', 'original content');
  assert.equal(firstUpload.response.status, 201);
  const original = firstUpload.data.items[0];
  const pagedResponse = await request('/api/gallery/items?limit=1&offset=0&sort=size', ownerToken);
  assert.equal(pagedResponse.status, 200);
  const paged = await pagedResponse.json();
  assert.equal(paged.total, 1);
  assert.equal(paged.items.length, 1);

  const otherRead = await request(`/api/gallery/files/${original.id}/content`, otherToken);
  assert.equal(otherRead.status, 404);
  const otherTrash = await request('/api/gallery/trash', otherToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileIds: [original.id] }),
  });
  assert.equal(otherTrash.status, 404);

  const trashed = await request('/api/gallery/trash', ownerToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileIds: [original.id] }),
  });
  assert.equal(trashed.status, 200);
  assert.ok(await Gallery.getFile(ownerId, original.id, { includeDeleted: true }));
  const trashListingResponse = await request('/api/gallery/trash?search=notes&category=documents', ownerToken);
  assert.equal(trashListingResponse.status, 200);
  const trashListing = await trashListingResponse.json();
  assert.equal(trashListing.total, 1);
  assert.equal(trashListing.items[0].original_location, 'Gallery');
  const privateTrashPreview = await request(
    `/api/gallery/files/${original.id}/content?inline=1&deleted=1`, ownerToken
  );
  assert.equal(privateTrashPreview.status, 200);
  const otherTrashPreview = await request(
    `/api/gallery/files/${original.id}/content?inline=1&deleted=1`, otherToken
  );
  assert.equal(otherTrashPreview.status, 404);

  const replacement = await upload('notes.txt', 'replacement content');
  assert.equal(replacement.response.status, 201);
  const restored = await request('/api/gallery/restore', ownerToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileIds: [original.id] }),
  });
  assert.equal(restored.status, 200);
  const rootItems = await Gallery.list(ownerId, 0, 'all', '');
  assert.ok(rootItems.items.some((item) => item.name === 'notes (restored 1).txt'));
  const content = await request(`/api/gallery/files/${original.id}/content`, ownerToken);
  assert.equal(content.status, 200);
  assert.equal(await content.text(), 'original content');
  assert.equal(Number(replacement.data.items[0].id) !== original.id, true);

  const folder = await createFolder('Trip photos');
  assert.equal(folder.response.status, 201);
  const nested = await createFolder('Day one', Number(folder.data.folder.id));
  assert.equal(nested.response.status, 201);
  const nestedUpload = await upload('photo.txt', 'private photo', ownerToken, Number(nested.data.folder.id));
  assert.equal(nestedUpload.response.status, 201);
  const folderTrash = await request('/api/gallery/trash', ownerToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderIds: [folder.data.folder.id] }),
  });
  assert.equal(folderTrash.status, 200);
  const trashedFolders = await request('/api/gallery/trash', ownerToken);
  const trashItems = (await trashedFolders.json()).items;
  assert.ok(trashItems.some((item) => item.kind === 'folder' && item.id === folder.data.folder.id));
  const folderRestore = await request('/api/gallery/restore', ownerToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderIds: [folder.data.folder.id] }),
  });
  assert.equal(folderRestore.status, 200);
  const restoredNested = await Gallery.list(ownerId, Number(nested.data.folder.id), 'all', '');
  assert.ok(restoredNested.items.some((item) => item.name === 'photo.txt'));

  const disappearingFolder = await createFolder('Old location');
  const movedFile = await upload('recover.txt', 'recover me', ownerToken, Number(disappearingFolder.data.folder.id));
  const movedFileId = movedFile.data.items[0].id;
  await request('/api/gallery/trash', ownerToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileIds: [movedFileId] }),
  });
  await request('/api/gallery/trash', ownerToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderIds: [disappearingFolder.data.folder.id] }),
  });
  const missingDestination = await request('/api/gallery/restore', ownerToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileIds: [movedFileId] }),
  });
  assert.equal(missingDestination.status, 409);
  assert.equal((await missingDestination.json()).code, 'RESTORE_DESTINATION_REQUIRED');
  const destination = await createFolder('Recovered files');
  const restoredElsewhere = await request('/api/gallery/restore', ownerToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileIds: [movedFileId], targetFolderId: destination.data.folder.id }),
  });
  assert.equal(restoredElsewhere.status, 200);
  assert.ok((await Gallery.list(ownerId, Number(destination.data.folder.id), 'all', ''))
    .items.some((item) => item.name === 'recover.txt'));

  const expiring = await upload('expired.txt', 'discard me');
  const expiringId = expiring.data.items[0].id;
  const storageKey = (await Gallery.getFile(ownerId, expiringId)).storage_key;
  await request('/api/gallery/trash', ownerToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileIds: [expiringId] }),
  });
  await db.execute({
    sql: 'UPDATE gallery_files SET delete_expires_at = ? WHERE id = ?',
    args: [new Date(Date.now() - 1000).toISOString(), expiringId],
  });
  const expiredRestore = await request('/api/gallery/restore', ownerToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileIds: [expiringId] }),
  });
  assert.equal(expiredRestore.status, 410);
  await cleanupExpiredItems();
  assert.equal(await itemExistsInDatabase(expiringId), false);
  await assert.rejects(fs.access(path.join(testRoot, 'files', storageKey)));

  const permanent = await upload('permanent.txt', 'remove me');
  const permanentId = permanent.data.items[0].id;
  const permanentKey = (await Gallery.getFile(ownerId, permanentId)).storage_key;
  await request('/api/gallery/trash', ownerToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileIds: [permanentId] }),
  });
  const permanentResult = await request('/api/gallery/permanent', ownerToken, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileIds: [permanentId] }),
  });
  assert.equal(permanentResult.status, 200);
  assert.equal(await itemExistsInDatabase(permanentId), false);
  await assert.rejects(fs.access(path.join(testRoot, 'files', permanentKey)));

  const restoreOne = await upload('bulk-one.txt', 'one');
  const restoreTwo = await upload('bulk-two.txt', 'two');
  await request('/api/gallery/trash', ownerToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileIds: [restoreOne.data.items[0].id, restoreTwo.data.items[0].id] }),
  });
  const restoreAll = await request('/api/gallery/restore', ownerToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ all: true }),
  });
  assert.equal(restoreAll.status, 200);
  const restoredAllItems = await Gallery.list(ownerId, 0, 'all', '');
  assert.ok(restoredAllItems.items.some((item) => item.name === 'bulk-one.txt'));
  assert.ok(restoredAllItems.items.some((item) => item.name === 'bulk-two.txt'));

  const brokenRestore = await upload('missing-content.txt', 'will be removed');
  const brokenId = brokenRestore.data.items[0].id;
  const brokenStorageKey = (await Gallery.getFile(ownerId, brokenId)).storage_key;
  await request('/api/gallery/trash', ownerToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileIds: [brokenId] }),
  });
  await fs.unlink(path.join(testRoot, 'files', brokenStorageKey));
  const brokenRestoreResponse = await request('/api/gallery/restore', ownerToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileIds: [brokenId] }),
  });
  assert.equal(brokenRestoreResponse.status, 409);
  assert.equal((await Gallery.getFile(ownerId, brokenId, { includeDeleted: true })).deleted_at !== null, true);

  const renameUpload = await upload('rename-source.txt', 'rename me');
  const renameId = renameUpload.data.items[0].id;
  const renameResponse = await request(`/api/gallery/files/${renameId}`, ownerToken, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'renamed-file.txt' }),
  });
  assert.equal(renameResponse.status, 200);
  assert.equal((await Gallery.getFile(ownerId, renameId)).name, 'renamed-file.txt');
  const unauthorizedRename = await request(`/api/gallery/files/${renameId}`, otherToken, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'stolen-name.txt' }),
  });
  assert.equal(unauthorizedRename.status, 404);
  const conflictingRename = await request(`/api/gallery/files/${renameId}`, ownerToken, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'bulk-one.txt' }),
  });
  assert.equal(conflictingRename.status, 409);

  const favoriteFile = await upload('favorite.txt', 'favorite content');
  const favoriteFolder = await createFolder('Favorite folder');
  const setFavorites = await request('/api/gallery/favorites', ownerToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fileIds: [favoriteFile.data.items[0].id],
      folderIds: [favoriteFolder.data.folder.id],
      isFavorite: true,
    }),
  });
  assert.equal(setFavorites.status, 200);
  const favoritesSortResponse = await request('/api/gallery/items?sort=favorites', ownerToken);
  const favoritesSort = await favoritesSortResponse.json();
  assert.equal(favoritesSortResponse.status, 200);
  assert.equal(Number(favoritesSort.items[0].is_favorite), 1);
  assert.equal(Number(favoritesSort.items[1].is_favorite), 1);
  const unauthorizedFavorite = await request('/api/gallery/favorites', otherToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fileIds: [favoriteFile.data.items[0].id],
      isFavorite: true,
    }),
  });
  assert.equal(unauthorizedFavorite.status, 404);
  const removeFavorites = await request('/api/gallery/favorites', ownerToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fileIds: [favoriteFile.data.items[0].id],
      folderIds: [favoriteFolder.data.folder.id],
      isFavorite: false,
    }),
  });
  assert.equal(removeFavorites.status, 200);
  assert.equal(Number((await Gallery.getFile(ownerId, favoriteFile.data.items[0].id)).is_favorite), 0);
  assert.equal(Number((await Gallery.getFolder(ownerId, favoriteFolder.data.folder.id)).is_favorite), 0);
});

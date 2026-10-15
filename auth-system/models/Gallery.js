const { db } = require('../config/db');

function placeholders(values) {
  return values.map(() => '?').join(', ');
}

const Gallery = {
  async list(ownerId, folderId, category, search, { limit = 100, offset = 0, sort = 'name' } = {}) {
    const favoritesOnly = sort === 'favorites' ? ' AND is_favorite = 1' : '';
    const includeFolders = category === 'all' || category === 'folders';
    const includeFiles = category !== 'folders';
    const fileCategory = {
      photos: "mime_type LIKE 'image/%'",
      videos: "mime_type LIKE 'video/%'",
      documents: "(mime_type LIKE 'text/%' OR mime_type IN ('application/pdf', 'application/rtf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'))",
    }[category];
    const folderQuery = `SELECT id, name, parent_id AS folder_id, created_at, is_favorite,
      'folder' AS kind, NULL AS mime_type, 0 AS size
      FROM gallery_folders
      WHERE owner_id = ? AND parent_id = ? AND deleted_at IS NULL
        AND instr(lower(name), lower(?)) > 0${favoritesOnly}`;
    const fileQuery = `SELECT id, name, folder_id, created_at, is_favorite, 'file' AS kind, mime_type, size
      FROM gallery_files
      WHERE owner_id = ? AND folder_id = ? AND deleted_at IS NULL
        AND ${fileCategory || '1 = 1'} AND instr(lower(name), lower(?)) > 0${favoritesOnly}`;
    const queries = [];
    const args = [];
    if (includeFolders) {
      queries.push(folderQuery);
      args.push(ownerId, folderId, search);
    }
    if (includeFiles) {
      queries.push(fileQuery);
      args.push(ownerId, folderId, search);
    }
    const where = `FROM (${queries.join(' UNION ALL ')})`;
    const totalResult = await db.execute({
      sql: `SELECT COUNT(*) AS total ${where}`,
      args,
    });
    const orderColumn = {
      name: 'lower(name)',
      date: 'created_at',
      favorites: 'is_favorite',
      size: 'size',
      type: 'coalesce(mime_type, kind)',
    }[sort] || 'lower(name)';
    const direction = sort === 'name' || sort === 'type' ? 'ASC' : 'DESC';
    const tieBreaker = sort === 'favorites' ? ', created_at DESC' : '';
    const paginated = sort !== 'name';
    const result = await db.execute({
      sql: `SELECT * ${where} ORDER BY ${orderColumn} ${direction}${tieBreaker}, lower(name) ASC${paginated ? ' LIMIT ? OFFSET ?' : ''}`,
      args: paginated ? [...args, limit, offset] : args,
    });
    let resultItems = result.rows;
    if (sort === 'name') {
      const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
      resultItems = [...resultItems]
        .sort((a, b) => collator.compare(a.name, b.name))
        .slice(offset, offset + limit);
    }
    return { items: resultItems, total: Number(totalResult.rows[0].total) };
  },

  async listTrash(ownerId, { limit = 100, offset = 0, search = '', category = 'all', sort = 'date' } = {}) {
    const query = `WITH trash AS (
      SELECT id, name, parent_id AS folder_id, created_at, deleted_at,
        delete_expires_at, deletion_group, 'folder' AS kind, NULL AS mime_type, 0 AS size
      FROM gallery_folders
      WHERE owner_id = ? AND deleted_at IS NOT NULL AND deletion_root = 1
        AND julianday(delete_expires_at) > julianday('now')
      UNION ALL
      SELECT id, name, folder_id, created_at, deleted_at,
        delete_expires_at, deletion_group, 'file' AS kind, mime_type, size
      FROM gallery_files
      WHERE owner_id = ? AND deleted_at IS NOT NULL AND deletion_root = 1
        AND julianday(delete_expires_at) > julianday('now')
    )
    SELECT * FROM trash
    WHERE instr(lower(name), lower(?)) > 0
      AND (? = 'all' OR kind = 'folder' AND ? = 'folders'
        OR kind = 'file' AND ? != 'folders'
          AND (? = 'all'
            OR ? = 'photos' AND mime_type LIKE 'image/%'
            OR ? = 'videos' AND mime_type LIKE 'video/%'
            OR ? = 'documents' AND (mime_type LIKE 'text/%' OR mime_type IN (
              'application/pdf', 'application/rtf', 'application/msword',
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              'application/vnd.ms-excel',
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              'application/vnd.ms-powerpoint',
              'application/vnd.openxmlformats-officedocument.presentationml.presentation'
            ))))
    `;
    const args = [ownerId, ownerId, search, category, category, category, category, category, category, category];
    const count = await db.execute({
      sql: `SELECT COUNT(*) AS total FROM (${query})`,
      args,
    });
    const orderColumn = {
      name: 'lower(name)',
      date: 'deleted_at',
      size: 'size',
      type: 'coalesce(mime_type, kind)',
    }[sort] || 'deleted_at';
    const direction = sort === 'name' || sort === 'type' ? 'ASC' : 'DESC';
    const result = await db.execute({
      sql: `${query} ORDER BY ${orderColumn} ${direction}, lower(name) ASC LIMIT ? OFFSET ?`,
      args: [...args, limit, offset],
    });

    const folderResult = await db.execute({
      sql: 'SELECT id, name, parent_id FROM gallery_folders WHERE owner_id = ?',
      args: [ownerId],
    });
    const folderMap = new Map(folderResult.rows.map((folder) => [Number(folder.id), folder]));
    const locationFor = (folderId) => {
      const pathParts = [];
      let currentId = Number(folderId);
      const seen = new Set();
      while (currentId !== 0 && !seen.has(currentId)) {
        seen.add(currentId);
        const folder = folderMap.get(currentId);
        if (!folder) return pathParts.length ? `Gallery / ${pathParts.reverse().join(' / ')} / (missing folder)` : 'Gallery / (missing folder)';
        pathParts.push(folder.name);
        currentId = Number(folder.parent_id);
      }
      return pathParts.length ? `Gallery / ${pathParts.reverse().join(' / ')}` : 'Gallery';
    };

    const rootFolderGroups = result.rows
      .filter((item) => item.kind === 'folder')
      .map((item) => item.deletion_group);
    const uniqueGroupIds = [...new Set(rootFolderGroups.filter(Boolean))];
    const folderSizes = new Map();
    for (const groupId of uniqueGroupIds) {
      const contents = await db.execute({
        sql: `SELECT coalesce(sum(size), 0) AS size FROM gallery_files
          WHERE owner_id = ? AND deletion_group = ? AND deleted_at IS NOT NULL`,
        args: [ownerId, groupId],
      });
      folderSizes.set(groupId, Number(contents.rows[0].size));
    }

    return {
      items: result.rows.map((item) => ({
        ...item,
        size: item.kind === 'folder' ? (folderSizes.get(item.deletion_group) || 0) : item.size,
        original_location: locationFor(item.folder_id),
      })),
      total: Number(count.rows[0].total),
    };
  },

  async listRestorableTrash(ownerId) {
    const result = await db.execute({
      sql: `SELECT id, 'file' AS kind, deletion_group FROM gallery_files
        WHERE owner_id = ? AND deleted_at IS NOT NULL AND deletion_root = 1
          AND julianday(delete_expires_at) > julianday('now')
        UNION ALL
        SELECT id, 'folder' AS kind, deletion_group FROM gallery_folders
        WHERE owner_id = ? AND deleted_at IS NOT NULL AND deletion_root = 1
          AND julianday(delete_expires_at) > julianday('now')`,
      args: [ownerId, ownerId],
    });
    return result.rows;
  },

  async getFolder(ownerId, folderId, { includeDeleted = false } = {}) {
    const result = await db.execute({
      sql: `SELECT * FROM gallery_folders
        WHERE id = ? AND owner_id = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}`,
      args: [folderId, ownerId],
    });
    return result.rows[0] || null;
  },

  async getFile(ownerId, fileId, { includeDeleted = false } = {}) {
    const result = await db.execute({
      sql: `SELECT * FROM gallery_files
        WHERE id = ? AND owner_id = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}`,
      args: [fileId, ownerId],
    });
    return result.rows[0] || null;
  },

  async createFolder(ownerId, name, parentId) {
    const result = await db.execute({
      sql: `INSERT INTO gallery_folders (owner_id, name, parent_id)
        VALUES (?, ?, ?) RETURNING id, name, parent_id, created_at`,
      args: [ownerId, name, parentId],
    });
    return result.rows[0];
  },

  async nameExists(ownerId, folderId, name) {
    const result = await db.execute({
      sql: `SELECT 1 FROM gallery_folders
        WHERE owner_id = ? AND parent_id = ? AND deleted_at IS NULL AND lower(name) = lower(?)
        UNION ALL
        SELECT 1 FROM gallery_files
        WHERE owner_id = ? AND folder_id = ? AND deleted_at IS NULL AND lower(name) = lower(?)
        LIMIT 1`,
      args: [ownerId, folderId, name, ownerId, folderId, name],
    });
    return result.rows.length > 0;
  },

  async renameFolder(ownerId, folderId, name) {
    await db.execute({
      sql: 'UPDATE gallery_folders SET name = ? WHERE id = ? AND owner_id = ? AND deleted_at IS NULL',
      args: [name, folderId, ownerId],
    });
  },

  async renameFile(ownerId, fileId, name) {
    await db.execute({
      sql: 'UPDATE gallery_files SET name = ? WHERE id = ? AND owner_id = ? AND deleted_at IS NULL',
      args: [name, fileId, ownerId],
    });
  },

  async setFavorites(ownerId, fileIds, folderIds, isFavorite) {
    const statements = [];
    if (fileIds.length) {
      statements.push({
        sql: `UPDATE gallery_files SET is_favorite = ?
          WHERE owner_id = ? AND deleted_at IS NULL AND id IN (${placeholders(fileIds)})`,
        args: [isFavorite ? 1 : 0, ownerId, ...fileIds],
      });
    }
    if (folderIds.length) {
      statements.push({
        sql: `UPDATE gallery_folders SET is_favorite = ?
          WHERE owner_id = ? AND deleted_at IS NULL AND id IN (${placeholders(folderIds)})`,
        args: [isFavorite ? 1 : 0, ownerId, ...folderIds],
      });
    }
    if (statements.length) await db.batch(statements, 'write');
  },

  async createFile(ownerId, file) {
    const result = await db.execute({
      sql: `INSERT INTO gallery_files (owner_id, folder_id, name, storage_key, mime_type, size)
        VALUES (?, ?, ?, ?, ?, ?)
        RETURNING id, name, folder_id, mime_type, size, created_at`,
      args: [ownerId, file.folderId, file.name, file.storageKey, file.mimeType, file.size],
    });
    return result.rows[0];
  },

  async getActiveFolderChildren(ownerId, parentIds) {
    if (!parentIds.length) return [];
    const result = await db.execute({
      sql: `SELECT id, parent_id FROM gallery_folders
        WHERE owner_id = ? AND deleted_at IS NULL AND parent_id IN (${placeholders(parentIds)})`,
      args: [ownerId, ...parentIds],
    });
    return result.rows;
  },

  async getFolderContents(ownerId, folderIds) {
    if (!folderIds.length) return [];
    const result = await db.execute({
      sql: `SELECT id, storage_key, deletion_group FROM gallery_files
        WHERE owner_id = ? AND deleted_at IS NULL AND folder_id IN (${placeholders(folderIds)})`,
      args: [ownerId, ...folderIds],
    });
    return result.rows;
  },

  async trashGroup(ownerId, groupId, folderIds, fileIds, deletedAt, expiresAt, rootFolderIds, rootFileIds) {
    const statements = [];
    if (folderIds.length) {
      statements.push({
        sql: `UPDATE gallery_folders SET deleted_at = ?, delete_expires_at = ?,
          deletion_group = ?, deletion_root = CASE WHEN id IN (${placeholders(rootFolderIds)}) THEN 1 ELSE 0 END
          WHERE owner_id = ? AND id IN (${placeholders(folderIds)}) AND deleted_at IS NULL`,
        args: [deletedAt, expiresAt, groupId, ...rootFolderIds, ownerId, ...folderIds],
      });
    }
    if (folderIds.length) {
      statements.push({
        sql: `UPDATE gallery_files SET deleted_at = ?, delete_expires_at = ?,
          deletion_group = ?, deletion_root = 0
          WHERE owner_id = ? AND folder_id IN (${placeholders(folderIds)}) AND deleted_at IS NULL`,
        args: [deletedAt, expiresAt, groupId, ownerId, ...folderIds],
      });
    }
    if (fileIds.length) {
      statements.push({
        sql: `UPDATE gallery_files SET deleted_at = ?, delete_expires_at = ?,
          deletion_group = ?, deletion_root = CASE WHEN id IN (${placeholders(rootFileIds)}) THEN 1 ELSE 0 END
          WHERE owner_id = ? AND id IN (${placeholders(fileIds)}) AND deleted_at IS NULL`,
        args: [deletedAt, expiresAt, groupId, ...rootFileIds, ownerId, ...fileIds],
      });
    }
    if (statements.length) await db.batch(statements, 'write');
  },

  async getGroup(ownerId, groupId) {
    const result = await db.execute({
      sql: `SELECT id, name, parent_id, deletion_root FROM gallery_folders
        WHERE owner_id = ? AND deletion_group = ? AND deleted_at IS NOT NULL
        UNION ALL
        SELECT id, name, folder_id AS parent_id, deletion_root FROM gallery_files
        WHERE owner_id = ? AND deletion_group = ? AND deleted_at IS NOT NULL`,
      args: [ownerId, groupId, ownerId, groupId],
    });
    return result.rows;
  },

  async getGroupFiles(ownerId, groupId) {
    const result = await db.execute({
      sql: `SELECT * FROM gallery_files
        WHERE owner_id = ? AND deletion_group = ? AND deleted_at IS NOT NULL`,
      args: [ownerId, groupId],
    });
    return result.rows;
  },

  async getGroupFolders(ownerId, groupId) {
    const result = await db.execute({
      sql: `SELECT * FROM gallery_folders
        WHERE owner_id = ? AND deletion_group = ? AND deleted_at IS NOT NULL`,
      args: [ownerId, groupId],
    });
    return result.rows;
  },

  async restoreGroup(
    ownerId, groupId, rootFolderId, targetFolderId, rootFolderName,
    rootFileId = 0, rootFileFolderId = 0, rootFileName = ''
  ) {
    const statements = [
      {
        sql: `UPDATE gallery_folders SET deleted_at = NULL, delete_expires_at = NULL,
          deletion_group = NULL, deletion_root = 0,
          parent_id = CASE WHEN id = ? THEN ? ELSE parent_id END,
          name = CASE WHEN id = ? THEN ? ELSE name END
          WHERE owner_id = ? AND deletion_group = ? AND deleted_at IS NOT NULL`,
        args: [rootFolderId, targetFolderId, rootFolderId, rootFolderName, ownerId, groupId],
      },
      {
        sql: `UPDATE gallery_files SET deleted_at = NULL, delete_expires_at = NULL,
          deletion_group = NULL, deletion_root = 0,
          folder_id = CASE WHEN id = ? THEN ? ELSE folder_id END,
          name = CASE WHEN id = ? THEN ? ELSE name END
          WHERE owner_id = ? AND deletion_group = ? AND deleted_at IS NOT NULL`,
        args: [rootFileId, rootFileFolderId, rootFileId, rootFileName, ownerId, groupId],
      },
    ];
    await db.batch(statements, 'write');
  },

  async deleteGroupMetadata(ownerId, groupId) {
    await db.batch([
      { sql: 'DELETE FROM gallery_files WHERE owner_id = ? AND deletion_group = ?', args: [ownerId, groupId] },
      { sql: 'DELETE FROM gallery_folders WHERE owner_id = ? AND deletion_group = ?', args: [ownerId, groupId] },
    ], 'write');
  },

  async getExpiredGroups() {
    const result = await db.execute({
      sql: `SELECT DISTINCT owner_id, deletion_group FROM gallery_files
        WHERE deleted_at IS NOT NULL AND julianday(delete_expires_at) <= julianday('now')
        UNION
        SELECT DISTINCT owner_id, deletion_group FROM gallery_folders
        WHERE deleted_at IS NOT NULL AND julianday(delete_expires_at) <= julianday('now')`,
    });
    return result.rows;
  },

  async getStorageKeyExists(storageKey) {
    const result = await db.execute({
      sql: 'SELECT 1 FROM gallery_files WHERE storage_key = ? LIMIT 1',
      args: [storageKey],
    });
    return result.rows.length > 0;
  },

  async deleteUploadedFiles(ownerId, storageKeys) {
    if (!storageKeys.length) return;
    await db.execute({
      sql: `DELETE FROM gallery_files
        WHERE owner_id = ? AND storage_key IN (${placeholders(storageKeys)}) AND deleted_at IS NULL`,
      args: [ownerId, ...storageKeys],
    });
  },

  async deleteEmptyFolders(ownerId, folderIds) {
    for (const folderId of folderIds) {
      await db.execute({
        sql: `DELETE FROM gallery_folders
          WHERE owner_id = ? AND id = ? AND deleted_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM gallery_files WHERE folder_id = gallery_folders.id)
            AND NOT EXISTS (SELECT 1 FROM gallery_folders child WHERE child.parent_id = gallery_folders.id)`,
        args: [ownerId, folderId],
      });
    }
  },

  async listTrashGroups(ownerId) {
    const result = await db.execute({
      sql: `SELECT DISTINCT deletion_group FROM gallery_files
        WHERE owner_id = ? AND deleted_at IS NOT NULL
        UNION
        SELECT DISTINCT deletion_group FROM gallery_folders
        WHERE owner_id = ? AND deleted_at IS NOT NULL`,
      args: [ownerId, ownerId],
    });
    return result.rows.map((row) => row.deletion_group).filter(Boolean);
  },
};

module.exports = Gallery;

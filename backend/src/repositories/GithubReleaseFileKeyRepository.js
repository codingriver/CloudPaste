import { BaseRepository } from "./BaseRepository.js";
import { DbTables } from "../constants/index.js";

export class GithubReleaseFileKeyRepository extends BaseRepository {
  async upsertKey({ storageConfigId, fileId, encryptionKey, createdBy = null, deleted = 0 }) {
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `
        INSERT INTO ${DbTables.GITHUB_RELEASE_FILE_KEYS}
          (storage_config_id, file_id, encryption_key, created_by, deleted, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(storage_config_id, file_id) DO UPDATE SET
          encryption_key = excluded.encryption_key,
          created_by = COALESCE(excluded.created_by, ${DbTables.GITHUB_RELEASE_FILE_KEYS}.created_by),
          deleted = excluded.deleted,
          updated_at = excluded.updated_at
      `,
      )
      .bind(storageConfigId, fileId, encryptionKey, createdBy, deleted ? 1 : 0, now, now)
      .run();
    return this.findKey(storageConfigId, fileId, { includeDeleted: true });
  }

  async findKey(storageConfigId, fileId, { includeDeleted = false } = {}) {
    let sql = `SELECT * FROM ${DbTables.GITHUB_RELEASE_FILE_KEYS} WHERE storage_config_id = ? AND file_id = ?`;
    if (!includeDeleted) {
      sql += " AND deleted = 0";
    }
    return this.queryFirst(sql, [storageConfigId, fileId]);
  }

  async softDeleteKey(storageConfigId, fileId) {
    return this.execute(
      `
      UPDATE ${DbTables.GITHUB_RELEASE_FILE_KEYS}
      SET deleted = 1, updated_at = ?
      WHERE storage_config_id = ? AND file_id = ?
    `,
      [new Date().toISOString(), storageConfigId, fileId],
    );
  }

  async hardDeleteKey(storageConfigId, fileId) {
    return this.deleteWhere(DbTables.GITHUB_RELEASE_FILE_KEYS, {
      storage_config_id: storageConfigId,
      file_id: fileId,
    });
  }

  async deleteByStorageConfigId(storageConfigId) {
    return this.deleteWhere(DbTables.GITHUB_RELEASE_FILE_KEYS, {
      storage_config_id: storageConfigId,
    });
  }
}

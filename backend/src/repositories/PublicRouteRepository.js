import { BaseRepository } from "./BaseRepository.js";
import { DbTables } from "../constants/index.js";

export class PublicRouteRepository extends BaseRepository {
  async findById(id) {
    return await super.findById(DbTables.PUBLIC_ROUTES, id);
  }

  async findByPublicPath(publicPath) {
    return await this.findOne(DbTables.PUBLIC_ROUTES, { public_path: publicPath });
  }

  async findByTarget(targetFsPath, targetType = null) {
    const conditions = { target_fs_path: targetFsPath };
    if (targetType) conditions.target_type = targetType;
    return await this.findOne(DbTables.PUBLIC_ROUTES, conditions);
  }

  async findByTargets(targetFsPaths) {
    const paths = [...new Set((targetFsPaths || []).filter(Boolean))];
    if (paths.length === 0) return [];
    const placeholders = paths.map(() => "?").join(",");
    const result = await this.query(
      `SELECT * FROM ${DbTables.PUBLIC_ROUTES} WHERE target_fs_path IN (${placeholders}) ORDER BY target_fs_path ASC`,
      paths,
    );
    return result.results || [];
  }

  async findAll({ search = "", enabled = null } = {}) {
    const conditions = [];
    const params = [];
    if (search) {
      conditions.push("(public_path LIKE ? OR target_fs_path LIKE ?)");
      const term = `%${search}%`;
      params.push(term, term);
    }
    if (enabled !== null && enabled !== undefined) {
      conditions.push("enabled = ?");
      params.push(enabled ? 1 : 0);
    }
    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    const result = await this.query(
      `SELECT * FROM ${DbTables.PUBLIC_ROUTES}${where} ORDER BY public_path ASC`,
      params,
    );
    return result.results || [];
  }

  async findEnabledCandidates(requestPath) {
    const result = await this.query(
      `SELECT * FROM ${DbTables.PUBLIC_ROUTES}
       WHERE enabled = 1
         AND (public_path = ? OR target_type = 'directory')
       ORDER BY LENGTH(public_path) DESC`,
      [requestPath],
    );
    return result.results || [];
  }

  async create(data) {
    const now = new Date().toISOString();
    await super.create(DbTables.PUBLIC_ROUTES, {
      id: data.id,
      public_path: data.publicPath,
      target_fs_path: data.targetFsPath,
      target_type: data.targetType,
      enabled: data.enabled === false ? 0 : 1,
      created_by: data.createdBy || null,
      created_at: now,
      updated_at: now,
    });
    return await this.findById(data.id);
  }

  async update(id, data) {
    const updates = { updated_at: new Date().toISOString() };
    if (data.publicPath !== undefined) updates.public_path = data.publicPath;
    if (data.targetFsPath !== undefined) updates.target_fs_path = data.targetFsPath;
    if (data.targetType !== undefined) updates.target_type = data.targetType;
    if (data.enabled !== undefined) updates.enabled = data.enabled ? 1 : 0;
    await super.update(DbTables.PUBLIC_ROUTES, id, updates);
    return await this.findById(id);
  }

  async delete(id) {
    return await super.delete(DbTables.PUBLIC_ROUTES, id);
  }

  async bulkSetEnabled(ids, enabled) {
    const values = [...new Set((ids || []).filter(Boolean))];
    if (values.length === 0) return { changes: 0 };
    const placeholders = values.map(() => "?").join(",");
    return await this.execute(
      `UPDATE ${DbTables.PUBLIC_ROUTES}
       SET enabled = ?, updated_at = ?
       WHERE id IN (${placeholders})`,
      [enabled ? 1 : 0, new Date().toISOString(), ...values],
    );
  }

  async bulkDelete(ids) {
    const values = [...new Set((ids || []).filter(Boolean))];
    if (values.length === 0) return { changes: 0 };
    const placeholders = values.map(() => "?").join(",");
    return await this.execute(
      `DELETE FROM ${DbTables.PUBLIC_ROUTES} WHERE id IN (${placeholders})`,
      values,
    );
  }
}

import Database from "better-sqlite3";
import { DbTables } from "../../../constants/index.js";
import { taskRegistry } from "./TaskRegistry.js";
import { TaskStatus } from "./types.js";
class SQLiteTaskOrchestrator {
  constructor(fileSystem, dbPath = "./data/database.db", concurrency = 10) {
    this.dbPath = dbPath;
    this.concurrency = concurrency;
    this.fileSystem = fileSystem;
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = 1");
    this.db.pragma("busy_timeout = 5000");
    this.recoverJobs();
    this.startWorkers();
    console.log(
      `[SQLiteTaskOrchestrator] \u5DF2\u542F\u52A8 (\u5E76\u53D1\u6570: ${concurrency}, \u6570\u636E\u5E93: ${dbPath})`
    );
  }
  db;
  workers = [];
  running = false;
  fileSystem;
  /**
   * 更新 FileSystem 实例引用（单例模式下每次请求可能传入不同实例）
   */
  updateFileSystem(fileSystem) {
    this.fileSystem = fileSystem;
  }
  /**
   * 创建任意类型的作业
   */
  async createJob(params) {
    const {
      taskType,
      payload,
      userId,
      userType,
      triggerType: triggerTypeRaw,
      triggerRef: triggerRefRaw
    } = params;
    const triggerType = triggerTypeRaw ?? "manual";
    const triggerRef = triggerRefRaw ?? null;
    const handler = taskRegistry.getHandler(taskType);
    await handler.validate(payload);
    const jobId = this.generateJobId(taskType);
    const now = Date.now();
    const stats = handler.createStatsTemplate(payload);
    this.db.prepare(`
      INSERT INTO ${DbTables.TASKS} (
        task_id, task_type, status, payload, stats,
        user_id, user_type,
        trigger_type, trigger_ref,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      jobId,
      taskType,
      // 动态任务类型
      "pending",
      JSON.stringify(payload),
      JSON.stringify(stats),
      userId,
      userType,
      triggerType,
      triggerRef,
      now,
      now
    );
    console.log(
      `[SQLiteTaskOrchestrator] \u5DF2\u521B\u5EFA\u4F5C\u4E1A ${jobId} (\u4EFB\u52A1\u7C7B\u578B: ${taskType})`
    );
    return {
      jobId,
      taskType,
      status: TaskStatus.PENDING,
      stats,
      createdAt: new Date(now),
      updatedAt: new Date(now),
      triggerType,
      triggerRef
    };
  }
  /**
   * 获取作业状态
   */
  async getJobStatus(jobId) {
    const row = this.db.prepare(`
      SELECT 
        t.*,
        ak.name as key_name
      FROM ${DbTables.TASKS} t
      LEFT JOIN ${DbTables.API_KEYS} ak ON t.user_id = ak.id
      WHERE t.task_id = ?
    `).get(jobId);
    if (!row) {
      throw new Error(`\u4F5C\u4E1A ${jobId} \u4E0D\u5B58\u5728`);
    }
    const payload = JSON.parse(row.payload);
    return {
      jobId: row.task_id,
      taskType: row.task_type,
      status: row.status,
      stats: JSON.parse(row.stats),
      createdAt: new Date(row.created_at),
      startedAt: row.started_at ? new Date(row.started_at) : void 0,
      finishedAt: row.finished_at ? new Date(row.finished_at) : void 0,
      updatedAt: new Date(row.updated_at),
      // 新增: 最后更新时间
      errorMessage: row.error_message || void 0,
      payload,
      userId: row.user_id,
      keyName: row.key_name || null,
      // API 密钥名称
      triggerType: row.trigger_type || "manual",
      triggerRef: row.trigger_ref ?? null
    };
  }
  /**
   * 取消作业
   */
  async cancelJob(jobId) {
    const result = this.db.prepare(`
      UPDATE ${DbTables.TASKS}
      SET status = ?, updated_at = ?
      WHERE task_id = ? AND status IN ('pending', 'running')
    `).run(
      TaskStatus.CANCELLED,
      Date.now(),
      jobId
    );
    if (result.changes === 0) {
      throw new Error("\u4F5C\u4E1A\u4E0D\u5B58\u5728\u6216\u5DF2\u5B8C\u6210,\u65E0\u6CD5\u53D6\u6D88");
    }
    console.log(`[SQLiteTaskOrchestrator] \u5DF2\u53D6\u6D88\u4F5C\u4E1A ${jobId}`);
  }
  /**
   * 列出作业 (支持任务类型过滤)
   */
  async listJobs(filter) {
    let whereClause = "WHERE 1=1";
    const baseParams = [];
    if (filter?.taskType) {
      whereClause += " AND t.task_type = ?";
      baseParams.push(filter.taskType);
    } else if (filter?.taskTypes && filter.taskTypes.length > 0) {
      const placeholders = filter.taskTypes.map(() => "?").join(", ");
      whereClause += ` AND t.task_type IN (${placeholders})`;
      baseParams.push(...filter.taskTypes);
    }
    if (filter?.status) {
      whereClause += " AND t.status = ?";
      baseParams.push(filter.status);
    }
    if (filter?.userId) {
      whereClause += " AND t.user_id = ?";
      baseParams.push(filter.userId);
    }
    const countQuery = `
      SELECT COUNT(1) as total
      FROM ${DbTables.TASKS} t
      ${whereClause}
    `;
    const countRow = this.db.prepare(countQuery).get(...baseParams);
    const total = Number(countRow?.total || 0);
    let query = `
      SELECT 
        t.*,
        ak.name as key_name
      FROM ${DbTables.TASKS} t
      LEFT JOIN ${DbTables.API_KEYS} ak ON t.user_id = ak.id
      ${whereClause}
      ORDER BY t.created_at DESC
    `;
    const params = [...baseParams];
    if (filter?.limit) {
      query += " LIMIT ?";
      params.push(filter.limit);
      if (filter?.offset) {
        query += " OFFSET ?";
        params.push(filter.offset);
      }
    }
    const results = this.db.prepare(query).all(...params);
    const jobs = results.map((row) => ({
      jobId: row.task_id,
      taskType: row.task_type,
      status: row.status,
      stats: JSON.parse(row.stats),
      createdAt: new Date(row.created_at),
      startedAt: row.started_at ? new Date(row.started_at) : void 0,
      finishedAt: row.finished_at ? new Date(row.finished_at) : void 0,
      updatedAt: new Date(row.updated_at),
      // 新增: 最后更新时间
      payload: JSON.parse(row.payload),
      userId: row.user_id,
      keyName: row.key_name || null,
      // API 密钥名称
      triggerType: row.trigger_type || "manual",
      triggerRef: row.trigger_ref ?? null
    }));
    return { jobs, total };
  }
  /**
   * 删除作业
   */
  async deleteJob(jobId) {
    const row = this.db.prepare(`
      SELECT status FROM ${DbTables.TASKS} WHERE task_id = ?
    `).get(jobId);
    if (!row) {
      throw new Error(`\u4F5C\u4E1A ${jobId} \u4E0D\u5B58\u5728`);
    }
    if (row.status === TaskStatus.PENDING || row.status === TaskStatus.RUNNING) {
      throw new Error(`\u4E0D\u80FD\u5220\u9664\u8FD0\u884C\u4E2D\u7684\u4F5C\u4E1A ${jobId},\u8BF7\u5148\u53D6\u6D88`);
    }
    this.db.prepare(`
      DELETE FROM ${DbTables.TASKS} WHERE task_id = ?
    `).run(jobId);
    console.log(`[SQLiteTaskOrchestrator] \u5DF2\u5220\u9664\u4F5C\u4E1A ${jobId}`);
  }
  // ==================== 内部方法 ====================
  /**
   * 启动内存 Worker Pool
   */
  startWorkers() {
    this.running = true;
    for (let i = 0; i < this.concurrency; i++) {
      this.workers.push(this.workerLoop());
    }
    console.log(`[SQLiteTaskOrchestrator] \u5DF2\u542F\u52A8 ${this.concurrency} \u4E2A Worker`);
  }
  /**
   * Worker 循环 (持续运行直到 orchestrator 停止)
   * 使用指数退避策略优化空闲轮询：初始 500ms，每次空闲翻倍，最大 8 秒
   */
  async workerLoop() {
    const MIN_POLL_INTERVAL = 500;
    const MAX_POLL_INTERVAL = 8e3;
    let currentInterval = MIN_POLL_INTERVAL;
    while (this.running) {
      const job = this.getNextJob();
      if (job) {
        currentInterval = MIN_POLL_INTERVAL;
        await this.processJob(job);
      } else {
        await new Promise((resolve) => setTimeout(resolve, currentInterval));
        currentInterval = Math.min(currentInterval * 2, MAX_POLL_INTERVAL);
      }
    }
  }
  /**
   * 原子获取下一个待执行作业并标记为 running
   *
   * 使用 BEGIN IMMEDIATE TRANSACTION (而非 BEGIN TRANSACTION) 防止死锁
   */
  getNextJob() {
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const row = this.db.prepare(`
        SELECT * FROM ${DbTables.TASKS}
        WHERE status = 'pending'
        ORDER BY created_at
        LIMIT 1
      `).get();
      if (row) {
        const now = Date.now();
        this.db.prepare(`
          UPDATE ${DbTables.TASKS}
          SET status = ?, started_at = ?, updated_at = ?
          WHERE task_id = ?
        `).run(
          TaskStatus.RUNNING,
          now,
          now,
          row.task_id
        );
        this.db.exec("COMMIT");
        const payload = JSON.parse(row.payload);
        const stats = JSON.parse(row.stats);
        return {
          jobId: row.task_id,
          taskType: row.task_type,
          // 从数据库读取
          payload,
          userId: row.user_id,
          userType: row.user_type,
          stats,
          createdAt: new Date(row.created_at)
        };
      }
      this.db.exec("ROLLBACK");
      return null;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  /**
   * 处理作业 (使用 TaskHandler 执行)
   */
  async processJob(job) {
    console.log(
      `[SQLiteTaskOrchestrator] \u5F00\u59CB\u5904\u7406\u4F5C\u4E1A ${job.jobId} (\u4EFB\u52A1\u7C7B\u578B: ${job.taskType})`
    );
    let errorMessage;
    try {
      const handler = taskRegistry.getHandler(job.taskType);
      const context = {
        isCancelled: async (jobId) => {
          const row = this.db.prepare(`
            SELECT status FROM ${DbTables.TASKS} WHERE task_id = ?
          `).get(jobId);
          return row?.status === TaskStatus.CANCELLED;
        },
        updateProgress: async (jobId, stats) => {
          const currentRow = this.db.prepare(`
            SELECT stats FROM ${DbTables.TASKS} WHERE task_id = ?
          `).get(jobId);
          const currentStats = JSON.parse(currentRow.stats);
          const updatedStats = { ...currentStats, ...stats };
          this.db.prepare(`
            UPDATE ${DbTables.TASKS}
            SET stats = ?, updated_at = ?
            WHERE task_id = ?
          `).run(
            JSON.stringify(updatedStats),
            Date.now(),
            jobId
          );
        },
        getStats: async (jobId) => {
          const row = this.db.prepare(`
            SELECT stats FROM ${DbTables.TASKS} WHERE task_id = ?
          `).get(jobId);
          return JSON.parse(row?.stats || "{}");
        },
        getFileSystem: () => this.fileSystem,
        getEnv: () => ({ db: this.db })
      };
      await handler.execute(job, context);
    } catch (error) {
      errorMessage = error.message || String(error);
      console.error(
        `[SQLiteTaskOrchestrator] \u4F5C\u4E1A ${job.jobId} \u6267\u884C\u5931\u8D25:`,
        error
      );
    }
    const finalRow = this.db.prepare(`
      SELECT status, stats FROM ${DbTables.TASKS} WHERE task_id = ?
    `).get(job.jobId);
    if (finalRow.status === TaskStatus.CANCELLED) {
      console.log(
        `[SQLiteTaskOrchestrator] \u4F5C\u4E1A ${job.jobId} \u5DF2\u88AB\u7528\u6237\u53D6\u6D88,\u4FDD\u6301 cancelled \u72B6\u6001`
      );
      return;
    }
    const finalStats = JSON.parse(finalRow.stats);
    const hasCompletedWork = (finalStats.successCount || 0) > 0 || (finalStats.skippedCount || 0) > 0;
    const finalStatus = errorMessage ? TaskStatus.FAILED : finalStats.failedCount === 0 ? TaskStatus.COMPLETED : !hasCompletedWork ? TaskStatus.FAILED : TaskStatus.PARTIAL;
    this.db.prepare(`
      UPDATE ${DbTables.TASKS}
      SET status = ?, finished_at = ?, updated_at = ?, error_message = ?
      WHERE task_id = ?
    `).run(
      finalStatus,
      Date.now(),
      Date.now(),
      errorMessage || null,
      job.jobId
    );
    console.log(
      `[SQLiteTaskOrchestrator] \u4F5C\u4E1A ${job.jobId} \u6267\u884C\u5B8C\u6210 (\u6700\u7EC8\u72B6\u6001: ${finalStatus})`
    );
  }
  /**
   * 崩溃恢复: 启动时恢复 pending/running 作业
   */
  recoverJobs() {
    const rows = this.db.prepare(`
      SELECT task_id, task_type FROM ${DbTables.TASKS}
      WHERE status IN ('pending', 'running')
      ORDER BY created_at
    `).all();
    for (const row of rows) {
      this.db.prepare(`
        UPDATE ${DbTables.TASKS}
        SET status = ?, updated_at = ?
        WHERE task_id = ?
      `).run(
        "pending",
        Date.now(),
        row.task_id
      );
    }
    if (rows.length > 0) {
      console.log(
        `[SQLiteTaskOrchestrator] \u5DF2\u6062\u590D ${rows.length} \u4E2A\u5F85\u5904\u7406\u4F5C\u4E1A (\u4EFB\u52A1\u7C7B\u578B: ${[...new Set(rows.map((r) => r.task_type))].join(", ")})`
      );
    }
  }
  /**
   * 生成唯一作业 ID (格式: taskType-YYMMDDHHMM-random6)
   * 示例: copy-2512011430-a3f5g7
   */
  generateJobId(taskType) {
    const now = /* @__PURE__ */ new Date();
    const year = now.getFullYear().toString().slice(-2);
    const month = (now.getMonth() + 1).toString().padStart(2, "0");
    const day = now.getDate().toString().padStart(2, "0");
    const hour = now.getHours().toString().padStart(2, "0");
    const minute = now.getMinutes().toString().padStart(2, "0");
    const timeStr = `${year}${month}${day}${hour}${minute}`;
    const random = Math.random().toString(36).substring(2, 8);
    return `${taskType}-${timeStr}-${random}`;
  }
  /**
   * 优雅关闭 orchestrator (停止 Worker,关闭数据库)
   */
  async shutdown() {
    console.log("[SQLiteTaskOrchestrator] \u6B63\u5728\u5173\u95ED...");
    this.running = false;
    await Promise.all(this.workers);
    this.db.close();
    console.log("[SQLiteTaskOrchestrator] \u5DF2\u5173\u95ED");
  }
}
export {
  SQLiteTaskOrchestrator
};

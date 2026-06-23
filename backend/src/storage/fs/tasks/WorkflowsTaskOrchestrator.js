import { DbTables } from "../../../constants/index.js";
import { taskRegistry } from "./TaskRegistry.js";
import { TaskStatus } from "./types.js";
class WorkflowsTaskOrchestrator {
  constructor(env, fileSystem) {
    this.env = env;
    this.fileSystem = fileSystem;
  }
  /** 创建作业 - 验证任务类型 → 生成 ID → 创建 Workflow 实例 → 插入数据库 */
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
    const workflowInstance = await this.env.JOB_WORKFLOW.create({
      id: jobId,
      params: {
        jobId,
        taskType,
        payload,
        userId,
        userType,
        triggerType,
        triggerRef
      }
    });
    await this.env.DB.prepare(`
      INSERT INTO ${DbTables.TASKS} (
        task_id, task_type, status, payload, stats,
        user_id, user_type, workflow_instance_id,
        trigger_type, trigger_ref,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      jobId,
      taskType,
      "pending",
      JSON.stringify(payload),
      JSON.stringify(stats),
      userId,
      userType,
      jobId,
      triggerType,
      triggerRef,
      now,
      now
    ).run();
    console.log(
      `[WorkflowsTaskOrchestrator] \u5DF2\u521B\u5EFA\u4F5C\u4E1A ${jobId} (\u4EFB\u52A1\u7C7B\u578B: ${taskType})`
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
  /** 获取作业状态 - 数据库静态数据 + Workflow 实时进度 */
  async getJobStatus(jobId) {
    const taskRecord = await this.env.DB.prepare(`
      SELECT
        t.*,
        ak.name as key_name
      FROM ${DbTables.TASKS} t
      LEFT JOIN ${DbTables.API_KEYS} ak ON t.user_id = ak.id
      WHERE t.task_id = ?
    `).bind(jobId).first();
    if (!taskRecord) {
      throw new Error(`\u4F5C\u4E1A ${jobId} \u4E0D\u5B58\u5728`);
    }
    const payload = JSON.parse(taskRecord.payload);
    const dbStats = JSON.parse(taskRecord.stats);
    const workflowInstanceId = taskRecord.workflow_instance_id || jobId;
    let workflowStatus = null;
    try {
      const instance = await this.env.JOB_WORKFLOW.get(workflowInstanceId);
      workflowStatus = await instance.status();
    } catch (error) {
      console.log(`Workflow ${workflowInstanceId} \u4E0D\u53EF\u7528\uFF0C\u4F7F\u7528\u6570\u636E\u5E93\u72B6\u6001:`, error);
    }
    let dbStatus = taskRecord.status;
    if (workflowStatus) {
      const hasContinuationScheduled = workflowStatus.output?.continuationScheduled === true;
      let mappedStatus = hasContinuationScheduled ? TaskStatus.RUNNING : this.mapWorkflowStatus(workflowStatus.status);
      const hasStarted = dbStatus === TaskStatus.RUNNING || !!taskRecord.started_at;
      if (hasStarted && mappedStatus === TaskStatus.PENDING) {
        mappedStatus = TaskStatus.RUNNING;
      }
      const isDbRunning = dbStatus === TaskStatus.PENDING || dbStatus === TaskStatus.RUNNING;
      const isFinalStatus = mappedStatus === TaskStatus.COMPLETED || mappedStatus === TaskStatus.FAILED || mappedStatus === TaskStatus.CANCELLED || mappedStatus === TaskStatus.PARTIAL;
      const isLatestWorkflowInstance = workflowStatus.id === workflowInstanceId;
      if (isDbRunning && isFinalStatus && isLatestWorkflowInstance) {
        try {
          const finishedAtMs = workflowStatus.output?.finishedAt ? new Date(workflowStatus.output.finishedAt).getTime() : Date.now();
          const updatedAtMs = Date.now();
          await this.env.DB.prepare(`
            UPDATE ${DbTables.TASKS}
            SET status = ?, finished_at = ?, updated_at = ?
            WHERE task_id = ?
          `).bind(mappedStatus, finishedAtMs, updatedAtMs, jobId).run();
          dbStatus = mappedStatus;
        } catch (error) {
          console.warn(
            `[WorkflowsTaskOrchestrator] \u540C\u6B65\u4F5C\u4E1A ${jobId} \u72B6\u6001\u5230 D1 \u5931\u8D25\uFF0C\u5C06\u7EE7\u7EED\u4F7F\u7528\u5185\u5B58\u72B6\u6001:`,
            error
          );
        }
      }
      const isDbFinalStatus = dbStatus === TaskStatus.COMPLETED || dbStatus === TaskStatus.FAILED || dbStatus === TaskStatus.CANCELLED || dbStatus === TaskStatus.PARTIAL;
      const effectiveStatus = isDbFinalStatus ? dbStatus : mappedStatus;
      return {
        jobId: taskRecord.task_id,
        taskType: taskRecord.task_type,
        status: effectiveStatus,
        stats: {
          ...dbStats,
          totalItems: workflowStatus.output?.totalItems ?? dbStats.totalItems,
          processedItems: workflowStatus.output?.processedItems ?? dbStats.processedItems,
          successCount: workflowStatus.output?.successCount ?? dbStats.successCount,
          failedCount: workflowStatus.output?.failedCount ?? dbStats.failedCount,
          skippedCount: workflowStatus.output?.skippedCount ?? dbStats.skippedCount
        },
        createdAt: new Date(taskRecord.created_at),
        startedAt: taskRecord.started_at ? new Date(taskRecord.started_at) : void 0,
        finishedAt: workflowStatus.output?.finishedAt ? new Date(workflowStatus.output.finishedAt) : taskRecord.finished_at ? new Date(taskRecord.finished_at) : void 0,
        updatedAt: new Date(taskRecord.updated_at),
        errorMessage: taskRecord.error_message,
        payload,
        userId: taskRecord.user_id,
        keyName: taskRecord.key_name,
        triggerType: taskRecord.trigger_type,
        triggerRef: taskRecord.trigger_ref ?? null
      };
    }
    return {
      jobId: taskRecord.task_id,
      taskType: taskRecord.task_type,
      status: taskRecord.status,
      stats: dbStats,
      createdAt: new Date(taskRecord.created_at),
      startedAt: taskRecord.started_at ? new Date(taskRecord.started_at) : void 0,
      finishedAt: taskRecord.finished_at ? new Date(taskRecord.finished_at) : void 0,
      updatedAt: new Date(taskRecord.updated_at),
      errorMessage: taskRecord.error_message,
      payload,
      userId: taskRecord.user_id,
      keyName: taskRecord.key_name,
      triggerType: taskRecord.trigger_type,
      triggerRef: taskRecord.trigger_ref ?? null
    };
  }
  /** 取消作业 - 终止 Workflow 实例 + 更新数据库状态 */
  async cancelJob(jobId) {
    try {
      const row = await this.env.DB.prepare(`
        SELECT workflow_instance_id FROM ${DbTables.TASKS} WHERE task_id = ?
      `).bind(jobId).first();
      const workflowInstanceId = row?.workflow_instance_id || jobId;
      const instance = await this.env.JOB_WORKFLOW.get(workflowInstanceId);
      await instance.terminate();
    } catch (error) {
      console.log(`\u7EC8\u6B62 Workflow ${jobId} \u5931\u8D25:`, error);
    }
    await this.env.DB.prepare(`
      UPDATE ${DbTables.TASKS}
      SET status = ?, updated_at = ?
      WHERE task_id = ?
    `).bind(
      "cancelled",
      Date.now(),
      jobId
    ).run();
    console.log(`[WorkflowsTaskOrchestrator] \u5DF2\u53D6\u6D88\u4F5C\u4E1A ${jobId}`);
  }
  /** 列出作业 - 支持任务类型、状态、用户过滤 + 分页 */
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
    const countResult = await this.env.DB.prepare(countQuery).bind(...baseParams).first();
    const total = Number(countResult?.total || 0);
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
      if (filter.offset) {
        query += " OFFSET ?";
        params.push(filter.offset);
      }
    }
    const results = await this.env.DB.prepare(query).bind(...params).all();
    const jobs = results.results.map((row) => ({
      jobId: row.task_id,
      taskType: row.task_type,
      status: row.status,
      stats: JSON.parse(row.stats),
      createdAt: new Date(row.created_at),
      startedAt: row.started_at ? new Date(row.started_at) : void 0,
      finishedAt: row.finished_at ? new Date(row.finished_at) : void 0,
      updatedAt: new Date(row.updated_at),
      payload: JSON.parse(row.payload),
      userId: row.user_id,
      keyName: row.key_name || null,
      triggerType: row.trigger_type || "manual",
      triggerRef: row.trigger_ref ?? null
    }));
    return { jobs, total };
  }
  /** 删除作业 - 仅终态作业，运行中需先取消 */
  async deleteJob(jobId) {
    const taskRecord = await this.env.DB.prepare(`
      SELECT status FROM ${DbTables.TASKS} WHERE task_id = ?
    `).bind(jobId).first();
    if (!taskRecord) {
      throw new Error(`\u4F5C\u4E1A ${jobId} \u4E0D\u5B58\u5728`);
    }
    const status = taskRecord.status;
    if (status === "pending" || status === "running") {
      throw new Error(`\u4E0D\u80FD\u5220\u9664\u8FD0\u884C\u4E2D\u7684\u4F5C\u4E1A ${jobId},\u8BF7\u5148\u53D6\u6D88`);
    }
    await this.env.DB.prepare(`
      DELETE FROM ${DbTables.TASKS} WHERE task_id = ?
    `).bind(jobId).run();
    console.log(`[WorkflowsTaskOrchestrator] \u5DF2\u5220\u9664\u4F5C\u4E1A ${jobId}`);
  }
  parseWorkflowStatus(status) {
    return {
      jobId: status.id,
      taskType: "",
      // 占位符,实际使用时从数据库获取
      status: this.mapWorkflowStatus(status.status),
      stats: {
        totalItems: status.output?.totalItems || 0,
        processedItems: status.output?.processedItems || 0,
        successCount: status.output?.successCount || 0,
        failedCount: status.output?.failedCount || 0,
        skippedCount: status.output?.skippedCount || 0,
        bytesTransferred: 0
      },
      createdAt: new Date(status.created),
      finishedAt: status.output?.finishedAt ? new Date(status.output.finishedAt) : void 0,
      payload: {}
    };
  }
  mapWorkflowStatus(workflowStatus) {
    switch (workflowStatus) {
      case "queued":
        return TaskStatus.PENDING;
      case "running":
        return TaskStatus.RUNNING;
      // Workflows 的 status() 可能返回更多“非终态”状态：
      // - waiting: 休眠/等待事件（不消耗 CPU，但实例仍在生命周期中）
      // - paused: 显式暂停
      // - waitingForPause: 正在收尾以进入 paused
      // - unknown: 平台无法判定（文档列出该值）
      //
      // 本项目内部 TaskStatus 仅建模 pending/running/...，没有 paused/waiting。
      // 因此这里做“语义折叠”：
      // - waiting/paused/unknown → pending（非终态、非执行态）
      // - waitingForPause → running（仍可能在执行当前工作单元）
      //
      // 注意：是否允许“取消/终止”不应依赖 UI 文案，而应以终态判定为准；
      // 这里的映射主要用于：列表展示 + allowedActions 的粗粒度判断。
      case "waiting":
      case "paused":
      case "unknown":
        return TaskStatus.PENDING;
      case "waitingForPause":
        return TaskStatus.RUNNING;
      case "complete":
        return TaskStatus.COMPLETED;
      case "errored":
        return TaskStatus.FAILED;
      case "terminated":
        return TaskStatus.CANCELLED;
      default:
        return TaskStatus.PENDING;
    }
  }
  /** 生成作业 ID - 格式: taskType-YYMMDDHHMM-random6 */
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
}
export {
  WorkflowsTaskOrchestrator
};

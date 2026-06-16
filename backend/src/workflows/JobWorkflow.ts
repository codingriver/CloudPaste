/**
 * Cloudflare Workflows 通用作业入口点
 * - 支持任意任务类型,通过 TaskRegistry 动态分发
 * - 持久化执行 + 步骤级重试
 * - 双层数据: Workflow 实例 (3-7天) + D1 tasks 表 (永久)
 */

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";

// @ts-ignore - JS modules lack type declarations
import { MountManager } from "../storage/managers/MountManager.js";
// @ts-ignore - JS modules lack type declarations
import { FileSystem } from "../storage/fs/FileSystem.js";
// @ts-ignore - JS modules lack type declarations
import { ensureRepositoryFactory } from "../utils/repositories.js";
import { DbTables } from "../constants/index.js";
import { taskRegistry } from "../storage/fs/tasks/TaskRegistry.js";
import type { ExecutionContext, InternalJob } from "../storage/fs/tasks/TaskHandler.js";
import { TaskStatus } from "../storage/fs/tasks/types.js";
import type { TaskStats } from "../storage/fs/tasks/types.js";

/** Workflow 参数 */
export interface JobWorkflowParams {
  jobId: string;
  taskType: string;
  payload: any;
  userId: string;
  userType: string;
}

/** Workers 环境绑定 */
interface Env {
  DB: D1Database;
  ENCRYPTION_SECRET: string;
  JOB_WORKFLOW: WorkflowNamespace;
}

interface WorkflowNamespace {
  create(params: { id: string; params: unknown }): Promise<{ id: string }>;
}

function isWorkerInvocationLimitError(error: unknown): boolean {
  const message = String((error as any)?.message || (error as any)?.details?.cause || (error as any)?.cause?.message || error || "").toUpperCase();
  return (
    message.includes("TOO MANY SUBREQUESTS BY SINGLE WORKER INVOCATION") ||
    message.includes("TOO MANY API REQUESTS BY SINGLE WORKER INVOCATION") ||
    message.includes("SUBREQUESTS BY SINGLE WORKER INVOCATION")
  );
}

/** 通用作业 Workflow - 持久化执行 + 自动重试 */
export class JobWorkflow extends WorkflowEntrypoint<Env, JobWorkflowParams> {
  async run(event: WorkflowEvent<JobWorkflowParams>, step: WorkflowStep) {
    const { jobId, taskType, payload, userId, userType } = event.payload;

    console.log(`[JobWorkflow] 启动作业 ${jobId}, 任务类型: ${taskType}`);

    // 获取任务处理器
    let handler;
    try {
      handler = taskRegistry.getHandler(taskType);
    } catch (error: any) {
      console.error(`[JobWorkflow] 未知任务类型 ${taskType}:`, error);

      await step.do('record-invalid-task-type', async () => {
        await this.env.DB.prepare(`
          UPDATE ${DbTables.TASKS}
          SET status = ?, error_message = ?, updated_at = ?, finished_at = ?
          WHERE task_id = ?
        `).bind(
          'failed',
          `未知任务类型: ${taskType}`,
          Date.now(),
          Date.now(),
          jobId
        ).run();
        return { error: 'invalid_task_type' };
      });

      throw error;
    }

    // 标记为 running
    await step.do('mark-running', async () => {
      await this.env.DB.prepare(`
        UPDATE ${DbTables.TASKS}
        SET status = ?, started_at = ?, updated_at = ?
        WHERE task_id = ?
      `).bind(
        'running',
        Date.now(),
        Date.now(),
        jobId
      ).run();
      return { success: true };
    });

    // 执行任务
    let taskSuccess = true;
    let taskError: Error | null = null;
    let continuationScheduled = false;
    let lastProgressWriteAtMs = 0;
    let pendingProgressPatch: Partial<TaskStats> | null = null;

    const context: ExecutionContext = {
      isCancelled: async (jobId: string) => {
        const row = await this.env.DB.prepare(`
          SELECT status FROM ${DbTables.TASKS} WHERE task_id = ?
        `).bind(jobId).first();
        return row?.status === 'cancelled';
      },

      updateProgress: async (jobId: string, stats: Partial<TaskStats>) => {
        const nowMs = Date.now();
        pendingProgressPatch = { ...(pendingProgressPatch || {}), ...(stats || {}) };

        const forceWrite =
          stats?.processedItems !== undefined ||
          stats?.totalItems !== undefined ||
          stats?.successCount !== undefined ||
          stats?.failedCount !== undefined ||
          stats?.skippedCount !== undefined;

        if (!forceWrite && nowMs - lastProgressWriteAtMs < 2000) {
          return;
        }
        lastProgressWriteAtMs = nowMs;

        const currentRow = await this.env.DB.prepare(`
          SELECT stats FROM ${DbTables.TASKS} WHERE task_id = ?
        `).bind(jobId).first();

        if (!currentRow) {
          console.error(`[JobWorkflow] 作业 ${jobId} 未找到,无法更新进度`);
          return;
        }

        const currentStats = JSON.parse(currentRow.stats as string);
        const updatedStats = {
          ...currentStats,
          ...(pendingProgressPatch || {}),
          heartbeatAtMs: nowMs,
        };
        pendingProgressPatch = null;

        await this.env.DB.prepare(`
          UPDATE ${DbTables.TASKS}
          SET stats = ?, updated_at = ?
          WHERE task_id = ?
        `).bind(
          JSON.stringify(updatedStats),
          Date.now(),
          jobId
        ).run();
      },

      getStats: async (jobId: string) => {
        const row = await this.env.DB.prepare(`
          SELECT stats FROM ${DbTables.TASKS} WHERE task_id = ?
        `).bind(jobId).first();
        return JSON.parse(row?.stats as string || '{}') as TaskStats;
      },

      getFileSystem: () => {
        const repositoryFactory = ensureRepositoryFactory(this.env.DB);
        const mountManager = new MountManager(
          this.env.DB,
          this.env.ENCRYPTION_SECRET,
          repositoryFactory,
          { env: this.env as any },
        );
        return new FileSystem(mountManager, this.env);
      },

      getEnv: () => this.env,
    };

    const scheduleContinuation = async (stepName: string, chunkIndex = 0) => {
      const continuationId = `${jobId}-cont-${Date.now()}-${chunkIndex + 1}`;
      await step.do(stepName, async () => {
        await this.env.JOB_WORKFLOW.create({
          id: continuationId,
          params: {
            ...event.payload,
            jobId,
            taskType,
            payload,
            userId,
            userType,
          },
        });

        await this.env.DB.prepare(`
          UPDATE ${DbTables.TASKS}
          SET workflow_instance_id = ?, status = ?, updated_at = ?
          WHERE task_id = ? AND status IN ('pending', 'running')
        `).bind(
          continuationId,
          'running',
          Date.now(),
          jobId,
        ).run();

        return { continuationId };
      });
      continuationScheduled = true;
      console.log(`[JobWorkflow] 作业 ${jobId} 已调度接力 Workflow: ${continuationId}`);
      return continuationId;
    };

    const job: InternalJob = {
      jobId,
      taskType,
      payload,
      userId,
      userType,
      stats: {
        totalItems: 0,
        processedItems: 0,
        successCount: 0,
        failedCount: 0,
        skippedCount: 0,
      },
      createdAt: new Date(),
    };

    try {
      console.log(`[JobWorkflow] 执行任务 ${jobId} (类型: ${taskType})`);

      if (typeof handler.executeChunk === 'function') {
        const maxChunks = 10000;
        // 目录批量任务的单个实处理 chunk 会叠加 D1 + S3/R2 子请求。
        // 线上复现：copy_directory_chunk_size=20 时，同一 Workflow run 连续处理第 2 个
        // 实处理 chunk 会在 44 个对象附近耗尽 invocation 预算，导致连“调度接力 Workflow”
        // 本身也可能无法可靠完成。这里改为每个 Workflow run 最多跑 1 个 chunk，
        // 用更多 Workflow 实例换稳定续跑。
        const workflowChunkedTaskTypes = new Set(['copy', 'delete', 'move']);
        const maxChunksPerWorkflowRun = workflowChunkedTaskTypes.has(taskType) ? 1 : maxChunks;
        for (let chunkIndex = 0; chunkIndex < maxChunks; chunkIndex++) {
          if (await context.isCancelled(jobId)) {
            console.log(`[JobWorkflow] 作业 ${jobId} 已取消，停止分块执行`);
            break;
          }

          const chunkResult = await step.do(
            `execute-task-chunk-${chunkIndex + 1}`,
            {
              retries: {
                limit: 3,
                delay: 5000,
                backoff: "exponential" as const,
              },
              timeout: 120000,
            },
            async () => handler.executeChunk!(job, context)
          );

          if (chunkResult?.done) {
            console.log(`[JobWorkflow] ✓ 任务 ${jobId} 分块执行完成: ${chunkResult?.message || ''}`);
            break;
          }

          if (chunkIndex === maxChunks - 1) {
            throw new Error(`任务分块数量超过上限 ${maxChunks}`);
          }

          const shouldScheduleContinuation =
            chunkIndex + 1 >= maxChunksPerWorkflowRun ||
            Boolean(chunkResult?.invocationLimitReached);

          if (shouldScheduleContinuation) {
            await scheduleContinuation(`schedule-continuation-workflow-${chunkIndex + 1}`, chunkIndex);
            break;
          }

          const waitDuration = chunkResult?.invocationLimitReached === true ? "10 seconds" : "1 second";
          await step.sleep(`wait-before-task-chunk-${chunkIndex + 2}`, waitDuration);
        }
      } else {
        await step.do(
          'execute-task',
          {
            retries: {
              limit: 3,
              delay: 10000,
              backoff: "exponential" as const,
            },
            timeout: 600000,
          },
          async () => {
            await handler.execute(job, context);
          }
        );
      }

      console.log(`[JobWorkflow] ✓ 任务 ${jobId} 执行成功`);
    } catch (error: any) {
      if (isWorkerInvocationLimitError(error) && typeof handler.executeChunk === 'function') {
        console.warn(`[JobWorkflow] 任务 ${jobId} 命中 Worker invocation 限制，尝试调度接力 Workflow 后继续`, error?.message || error);
        try {
          await scheduleContinuation('schedule-continuation-after-invocation-limit', 0);
        } catch (scheduleError: any) {
          taskSuccess = false;
          taskError = error;
          console.error(`[JobWorkflow] ✗ 任务 ${jobId} 命中 invocation 限制且接力调度失败:`, scheduleError);
        }
      } else {
        taskSuccess = false;
        taskError = error;
        console.error(`[JobWorkflow] ✗ 任务 ${jobId} 执行失败:`, error);
      }
    }

    if (continuationScheduled) {
      const currentRow = await this.env.DB.prepare(`
        SELECT stats FROM ${DbTables.TASKS} WHERE task_id = ?
      `).bind(jobId).first();
      const currentStats = currentRow ? JSON.parse(currentRow.stats as string) as TaskStats : {
        totalItems: 0,
        processedItems: 0,
        successCount: 0,
        failedCount: 0,
        skippedCount: 0,
      };

      return {
        ...currentStats,
        continuationScheduled: true,
        finishedAt: undefined,
      };
    }

    // 最终化状态
    await step.do('finalize-task-record', async () => {
      console.log(`[JobWorkflow] 最终化作业记录 ${jobId}`);

      const finalRow = await this.env.DB.prepare(`
        SELECT status, stats FROM ${DbTables.TASKS} WHERE task_id = ?
      `).bind(jobId).first();

      if (finalRow?.status === 'cancelled') {
        console.log(`[JobWorkflow] 作业 ${jobId} 已被用户取消,保持 cancelled 状态`);
        return { cancelled: true };
      }

      const finalStats = JSON.parse(finalRow?.stats as string || '{}') as TaskStats;
      let finalStatus: TaskStatus;

      if (!taskSuccess && taskError) {
        finalStatus = TaskStatus.FAILED;
      } else {
        const hasCompletedWork = (finalStats.successCount || 0) > 0 || (finalStats.skippedCount || 0) > 0;
        finalStatus =
          finalStats.failedCount === 0 ? TaskStatus.COMPLETED :
          !hasCompletedWork ? TaskStatus.FAILED :
          TaskStatus.PARTIAL;
      }

      const errorMessage =
        finalRow?.status === 'cancelled' ? '任务已被用户取消' :
        taskError ? taskError.message || String(taskError) :
        finalStats.failedCount > 0 ? `部分项目失败 (${finalStats.failedCount}/${finalStats.totalItems})` :
        null;

      await this.env.DB.prepare(`
        UPDATE ${DbTables.TASKS}
        SET status = ?, stats = ?, finished_at = ?, updated_at = ?, error_message = ?
        WHERE task_id = ?
      `).bind(
        finalStatus,
        JSON.stringify(finalStats),
        Date.now(),
        Date.now(),
        errorMessage,
        jobId
      ).run();

      console.log(`[JobWorkflow] ✓ 作业记录已最终化,状态: ${finalStatus}`);
      return { status: finalStatus };
    });

    const finalRow = await this.env.DB.prepare(`
      SELECT stats FROM ${DbTables.TASKS} WHERE task_id = ?
    `).bind(jobId).first();

    const finalStats = finalRow ? JSON.parse(finalRow.stats as string) as TaskStats : {
      totalItems: 0,
      processedItems: 0,
      successCount: 0,
      failedCount: 0,
      skippedCount: 0,
    };

    return {
      ...finalStats,
      finishedAt: new Date().toISOString(),
    };
  }
}

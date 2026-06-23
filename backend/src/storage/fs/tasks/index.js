import { WorkflowsTaskOrchestrator } from "./WorkflowsTaskOrchestrator.js";
import { SQLiteTaskOrchestrator } from "./SQLiteTaskOrchestrator.js";
import { TaskStatus } from "./types.js";
function getWorkerPoolSize(envSize) {
  const size = envSize ?? 2;
  return Math.max(1, Math.min(10, size));
}
let globalSQLiteOrchestrator = null;
function createTaskOrchestrator(fileSystem, env) {
  if (env.JOB_WORKFLOW && env.DB) {
    console.log("[TaskOrchestrator] \u2713 Using WorkflowsTaskOrchestrator (Workers)");
    return new WorkflowsTaskOrchestrator(
      env,
      fileSystem
    );
  }
  if (globalSQLiteOrchestrator) {
    globalSQLiteOrchestrator.updateFileSystem(fileSystem);
    return globalSQLiteOrchestrator;
  }
  console.log("[TaskOrchestrator] Runtime detection:", {
    hasJobWorkflow: !!env.JOB_WORKFLOW,
    hasDB: !!env.DB,
    hasTaskDatabasePath: !!env.TASK_DATABASE_PATH
  });
  console.log("[TaskOrchestrator] \u2713 Creating SQLiteTaskOrchestrator singleton (Node.js)");
  if (!env.TASK_DATABASE_PATH) {
    console.warn("[TaskOrchestrator] WARNING: TASK_DATABASE_PATH not set, using fallback");
  }
  const poolSize = getWorkerPoolSize(env.TASK_WORKER_POOL_SIZE);
  globalSQLiteOrchestrator = new SQLiteTaskOrchestrator(
    fileSystem,
    env.TASK_DATABASE_PATH || "./data/database.db",
    poolSize
  );
  return globalSQLiteOrchestrator;
}
export {
  TaskStatus,
  createTaskOrchestrator
};

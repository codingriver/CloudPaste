class TaskRegistry {
  static instance;
  handlers = /* @__PURE__ */ new Map();
  constructor() {
  }
  static getInstance() {
    if (!TaskRegistry.instance) {
      TaskRegistry.instance = new TaskRegistry();
    }
    return TaskRegistry.instance;
  }
  /** 注册任务处理器 */
  register(handler) {
    if (this.handlers.has(handler.taskType)) {
      throw new Error(`\u4EFB\u52A1\u7C7B\u578B "${handler.taskType}" \u5DF2\u6CE8\u518C,\u4E0D\u5141\u8BB8\u91CD\u590D\u6CE8\u518C`);
    }
    this.handlers.set(handler.taskType, handler);
    console.log(`[TaskRegistry] \u5DF2\u6CE8\u518C\u4EFB\u52A1\u7C7B\u578B: ${handler.taskType}`);
  }
  /** 获取任务处理器 */
  getHandler(taskType) {
    const handler = this.handlers.get(taskType);
    if (!handler) {
      throw new Error(
        `\u672A\u77E5\u4EFB\u52A1\u7C7B\u578B: "${taskType}"
\u652F\u6301\u7684\u4EFB\u52A1\u7C7B\u578B: ${this.getSupportedTypes().join(", ")}`
      );
    }
    return handler;
  }
  /** 获取所有支持的任务类型 */
  getSupportedTypes() {
    return Array.from(this.handlers.keys());
  }
  /** 检查任务类型是否已注册 */
  hasType(taskType) {
    return this.handlers.has(taskType);
  }
  /** 获取已注册的任务处理器数量 */
  getHandlerCount() {
    return this.handlers.size;
  }
}
const taskRegistry = TaskRegistry.getInstance();
export {
  taskRegistry
};

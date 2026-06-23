import { PermissionChecker, Permission } from "../../../constants/permissions.js";
import { UserType } from "../../../constants/index.js";
class JobTypeCatalog {
  static instance;
  defs = /* @__PURE__ */ new Map();
  constructor() {
  }
  static getInstance() {
    if (!JobTypeCatalog.instance) {
      JobTypeCatalog.instance = new JobTypeCatalog();
    }
    return JobTypeCatalog.instance;
  }
  register(def) {
    if (!def?.taskType || typeof def.taskType !== "string") {
      throw new Error("[JobTypeCatalog] taskType \u5FC5\u987B\u662F\u975E\u7A7A\u5B57\u7B26\u4E32");
    }
    if (this.defs.has(def.taskType)) {
      throw new Error(`[JobTypeCatalog] taskType "${def.taskType}" \u5DF2\u6CE8\u518C\uFF0C\u4E0D\u5141\u8BB8\u91CD\u590D\u6CE8\u518C`);
    }
    this.defs.set(def.taskType, def);
    console.log(`[JobTypeCatalog] \u5DF2\u6CE8\u518C\u4EFB\u52A1\u7C7B\u578B\u5B9A\u4E49: ${def.taskType}`);
  }
  get(taskType) {
    const def = this.defs.get(taskType);
    if (!def) {
      throw new Error(
        `[JobTypeCatalog] \u672A\u77E5\u4EFB\u52A1\u7C7B\u578B\u5B9A\u4E49: "${taskType}"
\u5DF2\u6CE8\u518C: ${Array.from(this.defs.keys()).join(", ")}`
      );
    }
    return def;
  }
  tryGet(taskType) {
    return this.defs.get(taskType) || null;
  }
  listAll() {
    return Array.from(this.defs.values());
  }
  isVisibleToPrincipal(taskType, principal) {
    const def = this.tryGet(taskType);
    if (!def) return false;
    if (principal.userType === UserType.ADMIN) return true;
    if (def.visibility?.mode === "admin-only") return false;
    if (def.visibility?.mode === "owner-only") {
      const required = def.visibility.permission;
      if (!required) return true;
      const perms = principal.permissions;
      if (typeof perms !== "number") return false;
      return PermissionChecker.hasPermission(perms, required);
    }
    return false;
  }
  listVisibleTypes(principal) {
    if (principal.userType === UserType.ADMIN) {
      return this.listAll();
    }
    return this.listAll().filter((d) => this.isVisibleToPrincipal(d.taskType, principal));
  }
  /**
   * 启动时做一致性校验：
   * - definition 必须能找到 handler
   * - handler 也应该有 definition（否则 UI/权限规则会缺失）
   */
  validateAgainstHandlers(handlers) {
    const handlerTypes = new Set(handlers.map((h) => h.taskType));
    const defTypes = new Set(Array.from(this.defs.keys()));
    const missingHandler = Array.from(defTypes).filter((t) => !handlerTypes.has(t));
    const missingDef = Array.from(handlerTypes).filter((t) => !defTypes.has(t));
    if (missingHandler.length > 0) {
      throw new Error(
        `[JobTypeCatalog] \u5B58\u5728\u672A\u5B9E\u73B0 handler \u7684 taskType: ${missingHandler.join(", ")}`
      );
    }
    if (missingDef.length > 0) {
      throw new Error(
        `[JobTypeCatalog] \u5B58\u5728\u672A\u6CE8\u518C definition \u7684 taskType: ${missingDef.join(", ")}`
      );
    }
  }
  /**
   * 根据 definition 判断是否允许“重试按钮”
   */
  isRetryable(taskType) {
    const def = this.tryGet(taskType);
    if (!def) return false;
    return (def.capabilities?.retry || "none") === "copy-retry";
  }
}
const jobTypeCatalog = JobTypeCatalog.getInstance();
function buildBuiltinJobTypeDefinitions() {
  return [
    {
      taskType: "copy",
      i18nKey: "admin.tasks.taskType.copy",
      category: "fs",
      visibility: { mode: "owner-only", permission: Permission.MOUNT_COPY },
      createPolicy: { policy: "fs.copy", pathCheck: true },
      capabilities: { retry: "copy-retry" }
    },
    {
      taskType: "delete",
      i18nKey: "admin.tasks.taskType.delete",
      category: "fs",
      visibility: { mode: "owner-only", permission: Permission.MOUNT_DELETE },
      createPolicy: { policy: "fs.delete", pathCheck: true },
      capabilities: { retry: "none" }
    },
    {
      taskType: "move",
      i18nKey: "admin.tasks.taskType.move",
      category: "fs",
      visibility: { mode: "owner-only", permission: Permission.MOUNT_RENAME },
      createPolicy: { policy: "fs.rename", pathCheck: true },
      capabilities: { retry: "none" }
    },
    {
      taskType: "fs_index_rebuild",
      i18nKey: "admin.tasks.taskType.fs_index_rebuild",
      category: "index",
      visibility: { mode: "admin-only" },
      createPolicy: { policy: "admin.all", pathCheck: false },
      capabilities: { retry: "none" }
    },
    {
      taskType: "fs_index_apply_dirty",
      i18nKey: "admin.tasks.taskType.fs_index_apply_dirty",
      category: "index",
      visibility: { mode: "admin-only" },
      createPolicy: { policy: "admin.all", pathCheck: false },
      capabilities: { retry: "none" }
    }
  ];
}
export {
  buildBuiltinJobTypeDefinitions,
  jobTypeCatalog
};

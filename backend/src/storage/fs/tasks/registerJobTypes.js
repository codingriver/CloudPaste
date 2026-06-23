import { jobTypeCatalog, buildBuiltinJobTypeDefinitions } from "./JobTypeCatalog.js";
import { taskRegistry } from "./TaskRegistry.js";
function registerJobTypes() {
  console.log("[JobTypeCatalog] \u5F00\u59CB\u6CE8\u518C\u4EFB\u52A1\u7C7B\u578B\u5B9A\u4E49...");
  const defs = buildBuiltinJobTypeDefinitions();
  for (const def of defs) {
    jobTypeCatalog.register(def);
  }
  console.log(
    `[JobTypeCatalog] \u6CE8\u518C\u5B8C\u6210! \u5171\u6CE8\u518C ${defs.length} \u4E2A\u4EFB\u52A1\u7C7B\u578B\u5B9A\u4E49: ${defs.map((d) => d.taskType).join(", ")}`
  );
}
function validateJobTypesConsistency() {
  const supported = taskRegistry.getSupportedTypes();
  const handlers = supported.map((t) => taskRegistry.getHandler(t));
  jobTypeCatalog.validateAgainstHandlers(handlers);
  console.log("[JobTypeCatalog] \u4E00\u81F4\u6027\u6821\u9A8C\u901A\u8FC7\uFF08definitions <-> handlers\uFF09");
}
export {
  registerJobTypes,
  validateJobTypesConsistency
};

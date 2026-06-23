import { taskRegistry } from "./TaskRegistry.js";
import { CopyTaskHandler } from "./handlers/CopyTaskHandler.js";
import { DeleteTaskHandler } from "./handlers/DeleteTaskHandler.js";
import { MoveTaskHandler } from "./handlers/MoveTaskHandler.js";
import { FsIndexRebuildTaskHandler } from "./handlers/FsIndexRebuildTaskHandler.js";
import { FsIndexApplyDirtyTaskHandler } from "./handlers/FsIndexApplyDirtyTaskHandler.js";
function registerTaskHandlers() {
  console.log("[TaskRegistry] \u5F00\u59CB\u6CE8\u518C\u4EFB\u52A1\u5904\u7406\u5668...");
  taskRegistry.register(new CopyTaskHandler());
  taskRegistry.register(new DeleteTaskHandler());
  taskRegistry.register(new MoveTaskHandler());
  taskRegistry.register(new FsIndexRebuildTaskHandler());
  taskRegistry.register(new FsIndexApplyDirtyTaskHandler());
  const supportedTypes = taskRegistry.getSupportedTypes();
  console.log(
    `[TaskRegistry] \u6CE8\u518C\u5B8C\u6210! \u5171\u6CE8\u518C ${supportedTypes.length} \u4E2A\u4EFB\u52A1\u7C7B\u578B: ${supportedTypes.join(", ")}`
  );
}
export {
  registerTaskHandlers
};

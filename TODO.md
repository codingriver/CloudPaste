# TODO

## 批量移动 / 大目录移动

- 将批量移动实现为后台任务，而不是同步 `rename` / `copy + delete`。
- 大目录移动必须拆为阶段执行：
  - 复制源目录到目标目录。
  - 校验目标目录对象数量与关键路径是否完整。
  - 复制确认完成后再删除源目录。
- S3/R2 同挂载目录移动当前依赖 `copyDirectoryRecursive()` 后 `deleteDirectoryRecursive()`，后续应避免在复制部分成功时删除源目录。
- WebDAV MOVE 当前也是 `copyItem()` 后 `batchRemoveItems()`，后续应在复制结果为 `partial/failed` 时阻止删除源。
- 超大目录移动应保存分页游标和阶段状态，支持 Workflow 分批续跑。

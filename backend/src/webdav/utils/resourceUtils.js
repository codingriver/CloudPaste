/**
 * 解析 Depth: 0 请求的当前资源。
 *
 * 目录尾斜杠只是一种 URI 形状，不能作为资源存在或资源类型的证据。
 * 默认通过 getFileInfo 获取真实 stat；若个别驱动无法可靠 stat 目录，只有在
 * exists 明确确认资源存在后，才允许使用 listDirectory 作为兼容回退。
 *
 * @param {Object} fileSystem - 文件系统实例
 * @param {string} path - 请求路径
 * @param {string|Object} userIdOrInfo - 用户ID或信息
 * @param {string} actualUserType - 实际用户类型
 * @returns {Promise<Object>} 当前资源信息
 */
export async function resolveDepthZeroResource(fileSystem, path, userIdOrInfo, actualUserType) {
  try {
    const fileInfo = await fileSystem.getFileInfo(path, userIdOrInfo, actualUserType);
    return {
      ...fileInfo,
      path,
      items: [],
    };
  } catch (statError) {
    if (!path.endsWith("/")) {
      throw statError;
    }

    const exists = await fileSystem.exists(path, userIdOrInfo, actualUserType);
    if (!exists) {
      throw statError;
    }

    const directoryInfo = await fileSystem.listDirectory(path, userIdOrInfo, actualUserType);
    return {
      ...directoryInfo,
      path,
      type: "directory",
      isDirectory: true,
      name: directoryInfo.name || path.split("/").filter(Boolean).pop() || "",
      size: null,
      items: [],
    };
  }
}

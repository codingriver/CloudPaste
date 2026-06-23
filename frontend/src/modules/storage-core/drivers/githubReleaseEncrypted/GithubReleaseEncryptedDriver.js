import { createCapabilities } from "../types.js";

export class GithubReleaseEncryptedDriver {
  constructor(config = {}) {
    this.config = config;
    this.capabilities = createCapabilities({
      share: {
        backendStream: false,
        backendForm: false,
        presigned: false,
        url: false,
      },
      fs: {
        backendStream: false,
        backendForm: false,
        presignedSingle: false,
        multipart: false,
      },
    });

    const directOnlyError = () => {
      throw new Error("GitHub Release 加密存储库使用专用前端直连流程，不支持现有后端上传管线");
    };

    this.share = {
      applyShareUploader: directOnlyError,
      applyDirectShareUploader: directOnlyError,
      applyUrlUploader: directOnlyError,
    };

    this.fs = {
      applyFsUploader: directOnlyError,
    };
  }

  get storageConfigId() {
    return this.config?.id ?? null;
  }
}

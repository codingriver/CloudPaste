import { BaseDriver } from "../../interfaces/capabilities/BaseDriver.js";
import { DriverError } from "../../../http/errors.js";
import { ApiStatus } from "../../../constants/index.js";

export class GithubReleaseEncryptedStorageDriver extends BaseDriver {
  constructor(config, encryptionSecret) {
    super(config);
    this.type = "GITHUB_RELEASE_ENCRYPTED";
    this.encryptionSecret = encryptionSecret;
    this.capabilities = ["ControlPlaneCapable"];
  }

  async initialize() {
    this.initialized = true;
  }

  async stat() {
    throw new DriverError("GitHub Release 加密存储库不支持后端文件系统访问，请使用前端直连 GitHub Release", {
      status: ApiStatus.NOT_IMPLEMENTED,
      code: "DRIVER_ERROR.GITHUB_RELEASE_ENCRYPTED_CONTROL_PLANE_ONLY",
      expose: true,
    });
  }

  async exists() {
    return false;
  }
}

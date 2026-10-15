export const releaseAPI =
  "https://api.github.com/repos/cynicalight/reader/releases/latest";
export const day = 24 * 60 * 60 * 1000;
export const retryDelay = 60 * 60 * 1000;

export interface UpdateState {
  lastChecked?: number;
  lastAttempt?: number;
}
export interface ReleaseUpdate {
  version: string;
  installer: string;
  downloadURL: string;
  checksumURL: string;
  // macOS app archive for Squirrel.Mac in-place updates. Older releases lack it.
  archive?: { installer: string; downloadURL: string };
}
export type UpdateResult =
  | { status: "current" }
  | { status: "pending" }
  | { status: "available"; update: ReleaseUpdate };

function versionParts(value: string): bigint[] {
  const match =
    /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
      value,
    );
  if (!match) throw new Error("版本号格式无效");
  return match.slice(1, 4).map(BigInt);
}
export function newerRelease(candidate: string, installed: string): boolean {
  const next = versionParts(candidate);
  const current = versionParts(installed);
  for (let i = 0; i < 3; i++) {
    if (next[i] !== current[i]) return next[i] > current[i];
  }
  // Only stable releases are offered. A stable version supersedes its prerelease.
  return installed.includes("-") && !candidate.includes("-");
}
export function checkDue(state: UpdateState, now: number): boolean {
  const elapsed = (timestamp: number | undefined, interval: number) =>
    timestamp === undefined || now < timestamp || now - timestamp >= interval;
  return (
    elapsed(state.lastChecked, day) && elapsed(state.lastAttempt, retryDelay)
  );
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("GitHub 返回了无效的更新信息");
  return value as Record<string, unknown>;
}
const installerTargets: Record<string, string> = {
  "darwin/arm64": "mac-arm64.dmg",
  "darwin/x64": "mac-intel-x64.dmg",
  "win32/x64": "win-x64.exe",
};
export function selectRelease(
  value: unknown,
  installed: string,
  platform: string,
  arch: string,
): UpdateResult {
  const release = record(value);
  if (release.draft !== false || release.prerelease !== false)
    throw new Error("更新信息不是正式发布版本");
  if (typeof release.tag_name !== "string") throw new Error("缺少发布版本号");
  const tag = release.tag_name;
  // Stable channel; never offer pre-releases even if incorrectly marked on GitHub.
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error("发布版本号格式无效");
  if (!newerRelease(tag, installed)) return { status: "current" };
  const target = installerTargets[`${platform}/${arch}`];
  if (!target) throw new Error("当前平台没有官方更新安装包");
  const version = tag.slice(1);
  const installer = `Reader-${version}-${target}`;
  if (!Array.isArray(release.assets)) throw new Error("缺少发布文件列表");
  const assets = release.assets.map(record);
  const assetURL = (name: string) => {
    const asset = assets.find(
      (item) => item.name === name && item.state === "uploaded",
    );
    if (!asset) return undefined;
    const expected = `https://github.com/cynicalight/reader/releases/download/${tag}/${name}`;
    if (asset.browser_download_url !== expected)
      throw new Error("更新文件地址与官方仓库不符");
    return expected;
  };
  const downloadURL = assetURL(installer);
  const checksumURL = assetURL("SHA256SUMS.txt");
  // Release is published before CI attaches the installers. Retry later.
  if (!downloadURL || !checksumURL) return { status: "pending" };
  const update: ReleaseUpdate = {
    version,
    installer,
    downloadURL,
    checksumURL,
  };
  if (platform === "darwin") {
    const archive = `Reader-${version}-${target.replace(/\.dmg$/, ".zip")}`;
    const archiveURL = assetURL(archive);
    if (archiveURL)
      update.archive = { installer: archive, downloadURL: archiveURL };
  }
  return { status: "available", update };
}

export function installerChecksum(text: string, filename: string): string {
  const matches = text.split(/\r?\n/).flatMap((line) => {
    const match = /^([a-fA-F0-9]{64}) {2}(.+)$/.exec(line);
    return match?.[2] === filename ? [match[1].toLowerCase()] : [];
  });
  if (matches.length !== 1) throw new Error("安装包校验值缺失或重复");
  return matches[0];
}

// Keep response bodies out of user-facing errors: proxies may return HTML,
// and GitHub's rate-limit message can contain the user's public IP address.
async function updateCheckError(
  response: Response,
  now: number,
): Promise<Error> {
  const status = response.status;
  const retryAfter = response.headers.get("retry-after")?.trim();
  const remaining = response.headers.get("x-ratelimit-remaining");
  let retryAt = retryAfter
    ? /^\d+$/.test(retryAfter)
      ? now + Number(retryAfter) * 1000
      : Date.parse(retryAfter)
    : NaN;
  if (!Number.isFinite(retryAt) && remaining === "0") {
    const reset = response.headers.get("x-ratelimit-reset")?.trim();
    retryAt = reset && /^\d+$/.test(reset) ? Number(reset) * 1000 : NaN;
  }
  let limited = status === 429;
  if (status === 403) {
    limited = remaining === "0" || Number.isFinite(retryAt);
    if (!limited) {
      const body = await response.json().catch(() => null);
      limited =
        typeof body?.message === "string" && /rate limit/i.test(body.message);
    }
  }
  if (limited) {
    const wait =
      Number.isFinite(retryAt) && retryAt > now
        ? `请等待约 ${Math.ceil((retryAt - now) / 60_000)} 分钟后重试。`
        : "请稍后重试，避免连续检查。";
    return new Error(
      `GitHub 更新检查已被限流 (${status})。${wait}也可打开发布页手动下载安装包。`,
    );
  }
  if (status === 403)
    return new Error(
      "GitHub 拒绝访问更新信息 (403)。请检查网络或代理的访问限制，也可打开发布页手动下载。",
    );
  if (status >= 500)
    return new Error(
      `GitHub 服务暂时不可用 (${status})。请稍后重试，也可打开发布页查看。`,
    );
  return new Error(`GitHub 更新检查失败 (${status})`);
}

export class DailyUpdateChecker {
  private running?: Promise<UpdateResult>;
  constructor(
    private readonly options: {
      version: string;
      platform: string;
      arch: string;
      state: UpdateState;
      fetch: (url: string, init: RequestInit) => Promise<Response>;
      save: (state: UpdateState) => Promise<void>;
      now?: () => number;
    },
  ) {}
  isDue(): boolean {
    return checkDue(this.options.state, this.options.now?.() ?? Date.now());
  }
  check(): Promise<UpdateResult> {
    if (this.running) return this.running;
    this.running = this.perform().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  private async perform(): Promise<UpdateResult> {
    const { state, fetch: request, save } = this.options;
    const now = this.options.now?.() ?? Date.now();
    state.lastAttempt = now;
    await save({ ...state });
    const response = await request(releaseAPI, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(20_000),
      redirect: "error",
      credentials: "omit",
    });
    let result: UpdateResult;
    if (response.status === 404) result = { status: "current" };
    else {
      if (!response.ok)
        throw await updateCheckError(
          response,
          this.options.now?.() ?? Date.now(),
        );
      result = selectRelease(
        await response.json(),
        this.options.version,
        this.options.platform,
        this.options.arch,
      );
    }
    if (result.status !== "pending") {
      state.lastChecked = now;
      await save({ ...state });
    }
    return result;
  }
}

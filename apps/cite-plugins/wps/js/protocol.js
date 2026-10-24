// Runs one Reader citation command: Reader answers each request with the next
// document operation until it sends Document.complete. Shared by the WPS
// add-in and the protocol tests; plain script, no modules.
(function (root) {
  "use strict";

  const UNREACHABLE = "无法连接 Reader。请先启动 Reader 桌面版，再重试。";

  function createTransport(credential, base) {
    return async function post(path, body) {
      let response;
      try {
        response = await fetch((base || "") + path, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + credential,
          },
          body: JSON.stringify(body),
        });
      } catch (e) {
        throw new Error(UNREACHABLE);
      }
      const data = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(data.error || "Reader 返回错误 " + response.status);
      return data;
    };
  }

  /**
   * @param {{command: string, documentId: string, client: string,
   *   document: {execute(op: object): unknown, activate(): void},
   *   post(path: string, body: object): Promise<any>}} options
   * @returns {Promise<string>} An error message from Reader, or "".
   */
  async function runCommand(options) {
    let op = await options.post("/v1/cite/execCommand", {
      command: options.command,
      documentId: options.documentId,
      client: options.client,
    });
    while (op && op.op !== "Document.complete") {
      // Reader is waiting for the user; ask again for the next operation.
      if (op.op === "Document.wait") {
        op = await options.post("/v1/cite/next", {
          transaction: op.transaction,
        });
        continue;
      }
      const reply = { transaction: op.transaction };
      try {
        reply.result = options.document.execute(op);
        if (reply.result === undefined) reply.result = {};
      } catch (e) {
        reply.error = String((e && e.message) || e || "文档操作失败");
      }
      op = await options.post("/v1/cite/respond", reply);
    }
    if (op && op.activate) {
      try {
        options.document.activate();
      } catch (e) {
        /* Focus is a convenience. */
      }
    }
    return (op && op.error) || "";
  }

  async function bootstrap(pathname) {
    const match = /^\/wps\/([a-f0-9]{64})\//.exec(String(pathname || ""));
    const key = match ? match[1] : "";
    if (!/^[a-f0-9]{64}$/.test(key))
      throw new Error("请在 NeoRead 设置中重新安装 WPS 插件");
    const reply = await createTransport(key)("/v1/cite/bootstrap", {});
    if (!/^[a-f0-9]{64}$/.test(reply.credential || ""))
      throw new Error("WPS 插件认证失败，请重启 NeoRead");
    return createTransport(reply.credential);
  }

  const api = { createTransport, runCommand, bootstrap, UNREACHABLE };
  root.ReaderCiteProtocol = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis === "object" ? globalThis : this);

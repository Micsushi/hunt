"use strict";

const http = require("node:http");

function httpJson(port, requestPath) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: requestPath }, (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(
              new Error(`Invalid JSON from ${requestPath}: ${error.message}`),
            );
          }
        });
      })
      .on("error", reject);
  });
}

function httpText(port, requestPath, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: requestPath, method },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve(body));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

class CdpClient {
  constructor(webSocketDebuggerUrl) {
    this.webSocketDebuggerUrl = webSocketDebuggerUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.ws = null;
  }

  async connect() {
    this.ws = new WebSocket(this.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("CDP connect timeout")),
        10000,
      );
      this.ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.addEventListener("error", (event) => {
        clearTimeout(timer);
        reject(event.error || new Error("CDP websocket error"));
      });
    });
    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject, timer } = this.pending.get(message.id);
        clearTimeout(timer);
        this.pending.delete(message.id);
        if (message.error) {
          reject(
            new Error(message.error.message || JSON.stringify(message.error)),
          );
        } else {
          resolve(message.result);
        }
      }
    });
    const rejectPending = (reason) => {
      for (const [id, pending] of this.pending.entries()) {
        clearTimeout(pending.timer);
        const error = new Error(reason);
        error.cdpMethod = pending.method || "";
        error.cdpLabel = pending.label || pending.method || "";
        error.reason = "cdp_connection_closed";
        pending.reject(error);
        this.pending.delete(id);
      }
    };
    this.ws.addEventListener("close", () => {
      rejectPending("CDP connection closed before command completed");
    });
    this.ws.addEventListener("error", (event) => {
      rejectPending(
        event.error?.message || "CDP websocket error before command completed",
      );
    });
    return this;
  }

  send(method, params = {}, timeoutMs = 60000, label = method) {
    const id = this.nextId;
    this.nextId += 1;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`CDP timeout: ${label || method}`);
        error.cdpMethod = method;
        error.cdpLabel = label || method;
        error.timeoutMs = timeoutMs;
        reject(error);
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method, label });
      this.ws.send(payload);
    });
  }

  async evaluate(expression, timeoutMs = 60000, label = "Runtime.evaluate") {
    const result = await this.send(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      },
      timeoutMs,
      label,
    );
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.text ||
          result.exceptionDetails.exception?.description ||
          "Runtime.evaluate failed",
      );
    }
    return result.result?.value;
  }

  close() {
    if (this.ws) {
      this.ws.close();
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function js(value) {
  return JSON.stringify(value);
}

module.exports = {
  CdpClient,
  httpJson,
  httpText,
  js,
  sleep,
};

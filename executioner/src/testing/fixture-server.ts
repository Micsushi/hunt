import { createHash } from "node:crypto";
import { globSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { types as utilTypes } from "node:util";

import {
  parseFixtureManifest,
  providerError,
  type FixtureManifest,
  type FixtureFaultRequest,
  type FixtureResetRequest,
  type FixtureResetResult,
  type FixtureRuntime,
  type FixtureStartRequest,
  type FixtureStartResult,
  type PortResult,
  type CancellationError,
  type FixtureRuntimeError,
} from "../contracts/index.ts";
import { FixtureState } from "./fixture-state.ts";

const pages = [
  { id: "fixture-account", path: "/account" },
  { id: "fixture-profile", path: "/profile" },
  { id: "fixture-questionnaire", path: "/questionnaire" },
  { id: "fixture-review", path: "/review" },
] as const;
const csp = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'";

function exactDataRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    utilTypes.isProxy(value)
  ) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  ) return undefined;
  const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) return undefined;
    record[key] = descriptor.value;
  }
  return record;
}

function validRunId(value: unknown): boolean {
  return typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}

function validRunRequest(value: unknown): value is FixtureStartRequest | FixtureResetRequest {
  const request = exactDataRecord(value, ["fixtureRunId"]);
  return request !== undefined && validRunId(request.fixtureRunId);
}

function validFaultRequest(value: unknown): value is FixtureFaultRequest {
  const request = exactDataRecord(value, ["fixtureRunId", "fault"]);
  return request !== undefined &&
    validRunId(request.fixtureRunId) &&
    (request.fault === null || request.fault === "component_failure");
}

export type FixtureValidationCode =
  | "fixture_manifest_invalid"
  | "fixture_asset_missing"
  | "fixture_asset_extra";

export class FixtureValidationError extends Error {
  readonly code: FixtureValidationCode;

  constructor(code: FixtureValidationCode) {
    super(code);
    this.code = code;
  }
}

function assetHash(asset: Buffer): string {
  return `sha256.${createHash("sha256")
    .update(
      asset.toString("utf8").replaceAll(
        "\r\n",
        "\n",
      ),
    )
    .digest("hex")}`;
}

function loadFixtureSet(root: string): {
  readonly manifest: FixtureManifest;
  readonly assets: ReadonlyMap<string, Buffer>;
} {
  let manifest: FixtureManifest;
  try {
    manifest = parseFixtureManifest(
      JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")),
    );
  } catch {
    throw new FixtureValidationError("fixture_manifest_invalid");
  }
  const expected = new Set(["manifest.json", ...pages.map(({ path }) => path.slice(1))]);
  const actual = new Set(globSync("**/*", { cwd: root })
    .filter((path) => statSync(join(root, path)).isFile())
    .map((path) => path.replaceAll("\\", "/")));
  if ([...expected].some((path) => !actual.has(path))) {
    throw new FixtureValidationError("fixture_asset_missing");
  }
  if ([...actual].some((path) => !expected.has(path))) {
    throw new FixtureValidationError("fixture_asset_extra");
  }
  const assets = new Map<string, Buffer>();
  if (
    manifest.pages.length !== pages.length ||
    manifest.pages.some((page, index) => {
      const expectedPage = pages[index];
      if (
        expectedPage === undefined ||
        page.id !== expectedPage.id ||
        page.path !== expectedPage.path
      ) return true;
      const asset = readFileSync(join(root, page.path.slice(1)));
      assets.set(page.path, asset);
      return page.semanticHash !== assetHash(asset);
    })
  ) throw new FixtureValidationError("fixture_manifest_invalid");
  return { manifest, assets };
}

export function loadFixtureManifest(root: string): FixtureManifest {
  return loadFixtureSet(root).manifest;
}

type StartResult = PortResult<FixtureStartResult, FixtureRuntimeError | CancellationError>;

export interface FixtureServerOptions {
  readonly bind?: (server: Server, onListening: () => void) => void;
  readonly listenTimeoutMs?: number;
}

export class FixtureServer implements FixtureRuntime {
  readonly #assets: ReadonlyMap<string, Buffer>;
  readonly #bind: (server: Server, onListening: () => void) => void;
  readonly #listenTimeoutMs: number;
  readonly #state = new FixtureState();
  #listening: Promise<void> | undefined;
  #origin: string | undefined;
  #pendingStarts = 0;
  #server: Server | undefined;

  constructor(root: string, options: FixtureServerOptions = {}) {
    const fixture = loadFixtureSet(root);
    this.#assets = fixture.assets;
    const listenTimeoutMs = options.listenTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(listenTimeoutMs) || listenTimeoutMs <= 0 || listenTimeoutMs > 30_000) {
      throw new RangeError("fixture listen timeout is out of bounds");
    }
    this.#listenTimeoutMs = listenTimeoutMs;
    this.#bind = options.bind ?? ((server, onListening) => {
      server.listen(0, "127.0.0.1", onListening);
    });
  }

  async start(request: FixtureStartRequest, signal: AbortSignal): Promise<StartResult> {
    if (signal.aborted) return { ok: false, error: providerError("operation_cancelled") };
    if (!validRunRequest(request)) {
      return { ok: false, error: providerError("fixture_not_found") };
    }
    this.#pendingStarts += 1;
    try {
      try {
        await this.#listen();
      } catch {
        return { ok: false, error: providerError("fixture_timeout") };
      }
      if (signal.aborted) {
        return { ok: false, error: providerError("operation_cancelled") };
      }
      return this.#state.start(request.fixtureRunId, this.#origin!, signal);
    } finally {
      this.#pendingStarts -= 1;
      if (
        signal.aborted &&
        this.#pendingStarts === 0 &&
        this.#state.snapshot === undefined
      ) await this.close();
    }
  }

  async reset(
    request: FixtureResetRequest,
    signal: AbortSignal,
  ): Promise<PortResult<FixtureResetResult, FixtureRuntimeError | CancellationError>> {
    if (signal.aborted) {
      return { ok: false, error: providerError("operation_cancelled") };
    }
    if (!validRunRequest(request)) {
      return { ok: false, error: providerError("fixture_not_found") };
    }
    return this.#state.reset(request.fixtureRunId, signal);
  }

  async setFault(
    request: FixtureFaultRequest,
    signal: AbortSignal,
  ): Promise<PortResult<void, FixtureRuntimeError | CancellationError>> {
    if (signal.aborted) {
      return { ok: false, error: providerError("operation_cancelled") };
    }
    if (!validFaultRequest(request)) {
      return { ok: false, error: providerError("fixture_not_found") };
    }
    return this.#state.setFault(request.fixtureRunId, request.fault, signal);
  }

  async close(): Promise<void> {
    if (this.#server === undefined && this.#listening !== undefined) {
      await this.#listening.catch(() => undefined);
    }
    const server = this.#server;
    this.#server = undefined;
    this.#listening = undefined;
    this.#origin = undefined;
    this.#state.clear();
    if (server === undefined) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    });
  }

  async #listen(): Promise<void> {
    if (this.#server !== undefined) return;
    if (this.#listening !== undefined) return this.#listening;
    this.#listening = this.#open();
    try {
      await this.#listening;
    } catch (error) {
      this.#listening = undefined;
      throw error;
    }
  }

  async #open(): Promise<void> {
    const server = createServer((request, response) => {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { allow: "GET, HEAD" }).end();
        return;
      }
      const path = new URL(request.url ?? "/", "http://fixture.invalid").pathname;
      const asset = this.#assets.get(path);
      if (asset === undefined) {
        response.writeHead(404).end();
        return;
      }
      if (this.#state.fault === "component_failure") {
        response.writeHead(503, {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": csp,
          "x-content-type-options": "nosniff",
        });
        response.end(request.method === "HEAD"
          ? undefined
          : "<!doctype html><html lang=\"en\" data-fixture-fault=\"component_failure\"><body><main><h1>Synthetic fixture fault</h1></main></body></html>");
        return;
      }
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": csp,
        "x-content-type-options": "nosniff",
      });
      response.end(request.method === "HEAD" ? undefined : asset);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cleanup = () => {
          if (timer !== undefined) clearTimeout(timer);
          server.off("error", fail);
        };
        const fail = (error: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };
        const ready = () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        };
        server.once("error", fail);
        timer = setTimeout(
          () => fail(new Error("fixture listen timed out")),
          this.#listenTimeoutMs,
        );
        try {
          this.#bind(server, ready);
        } catch (error) {
          fail(error);
        }
      });
    } catch (error) {
      server.once("error", () => undefined);
      if (server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      } else {
        server.once("listening", () => server.close());
      }
      throw error;
    }
    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      throw new Error("fixture server did not bind a TCP port");
    }
    this.#server = server;
    this.#origin = `http://127.0.0.1:${address.port}`;
  }
}

export function createFixtureRuntimeProviderFactory(root: string) {
  return Object.freeze({
    name: "FixtureRuntime" as const,
    create() {
      const provider = new FixtureServer(root);
      let cleaned = false;
      return {
        provider,
        calls: [],
        get cleaned() {
          return cleaned;
        },
        async cleanup() {
          if (cleaned) return;
          cleaned = true;
          await provider.close();
        },
      };
    },
  });
}

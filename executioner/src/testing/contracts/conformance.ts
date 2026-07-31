import { isDeepStrictEqual } from "node:util";

import { contractOperationCases } from "./operation-cases.ts";
import type {
  ContractPortMap,
  ContractPortName,
} from "./types.ts";

export const contractPortOperations = Object.fromEntries(
  Object.entries(contractOperationCases).map(([name, cases]) => [
    name,
    Object.keys(cases),
  ]),
) as unknown as {
  readonly [N in ContractPortName]: readonly (keyof ContractPortMap[N] & string)[];
};

export async function assertProviderConformance<N extends ContractPortName>(
  name: N,
  provider: ContractPortMap[N],
): Promise<void> {
  const dynamicProvider = provider as unknown as Record<
    string,
    (request: unknown, signal: AbortSignal) => Promise<unknown>
  >;
  const cases = contractOperationCases[name] as Record<
    string,
    {
      readonly request:
        | unknown
        | ((results: Readonly<Record<string, unknown>>) => unknown);
      readonly expected?: unknown;
      readonly assert?: (value: unknown, request: unknown) => boolean;
    }
  >;
  const results: Record<string, unknown> = {};

  for (const [operation, operationCase] of Object.entries(cases)) {
    const invoke = dynamicProvider[operation];
    const coordinate = `${name}.${operation}`;
    if (typeof invoke !== "function") {
      throw new TypeError(`${coordinate} must be a function`);
    }

    const request =
      typeof operationCase.request === "function"
        ? operationCase.request(results)
        : operationCase.request;
    const result = await invoke.call(
      provider,
      request,
      new AbortController().signal,
    );
    assertLiveResult(
      coordinate,
      result,
      request,
      operationCase,
    );
    results[operation] = result.value;

    const cancelledResult = await invoke.call(
      provider,
      request,
      AbortSignal.abort(),
    );
    assertCancelledResult(coordinate, cancelledResult);
  }
}

function assertLiveResult(
  coordinate: string,
  value: unknown,
  request: unknown,
  operationCase: {
    readonly expected?: unknown;
    readonly assert?: (value: unknown, request: unknown) => boolean;
  },
): asserts value is { readonly ok: true; readonly value: unknown } {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    throw new TypeError(`${coordinate} must return a PortResult object`);
  }

  if (value.ok === true) {
    if (
      !Object.hasOwn(value, "value") ||
      Object.hasOwn(value, "error") ||
      Object.keys(value).some((key) => key !== "ok" && key !== "value")
    ) {
      throw new TypeError(
        `${coordinate} success must contain only ok and value`,
      );
    }
    const success = (value as unknown as { readonly value: unknown }).value;
    if (operationCase.assert !== undefined) {
      if (!operationCase.assert(success, request)) {
        throw new TypeError(
          `${coordinate} did not satisfy its success invariant`,
        );
      }
    } else if (!isDeepStrictEqual(success, operationCase.expected)) {
      throw new TypeError(
        `${coordinate} did not return the expected success fixture`,
      );
    }
    return;
  }

  if (
    value.ok !== false ||
    !Object.hasOwn(value, "error") ||
    Object.hasOwn(value, "value") ||
    Object.keys(value).some((key) => key !== "ok" && key !== "error")
  ) {
    throw new TypeError(
      `${coordinate} failure must contain only ok and error`,
    );
  }

  const error = (value as unknown as { readonly error: unknown }).error;
  if (
    typeof error !== "object" ||
    error === null ||
    typeof (error as { code?: unknown }).code !== "string" ||
    typeof (error as { retryable?: unknown }).retryable !== "boolean"
  ) {
    throw new TypeError(
      `${coordinate} error must contain code and retryable`,
    );
  }
  if (
    Object.keys(error).some(
      (key) => key !== "code" && key !== "retryable",
    )
  ) {
    throw new TypeError(
      `${coordinate} error must contain only code and retryable`,
    );
  }

  const code = (error as { readonly code: string }).code;
  if (code === "operation_cancelled") {
    throw new TypeError(
      `${coordinate} live signal returned operation_cancelled`,
    );
  }
  throw new TypeError(
    `${coordinate} live synthetic case must return success, received ${code}`,
  );
}

function assertCancelledResult(
  coordinate: string,
  value: unknown,
): void {
  if (
    !(
      typeof value === "object" &&
      value !== null &&
      Object.keys(value).length === 2 &&
      (value as { readonly ok?: unknown }).ok === false &&
      Object.hasOwn(value, "error")
    )
  ) {
    throw new TypeError(
      `${coordinate} aborted signal must return operation_cancelled`,
    );
  }
  const error = (value as { readonly error: unknown }).error;
  if (
    !(
      typeof error === "object" &&
      error !== null &&
      Object.keys(error).length === 2 &&
      (error as { readonly code?: unknown }).code ===
        "operation_cancelled" &&
      (error as { readonly retryable?: unknown }).retryable === false
    )
  ) {
    throw new TypeError(
      `${coordinate} aborted signal must return operation_cancelled`,
    );
  }
}

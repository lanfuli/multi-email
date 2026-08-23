import { AsyncLocalStorage } from "node:async_hooks";
import { MultiEmailError } from "./errors.mjs";

export const MCP_OPERATION_TIMEOUT_MS = 108_000;

const operationDeadline = new AsyncLocalStorage();

function deadlineExceeded() {
  return new MultiEmailError(
    "The MCP operation deadline expired.",
    "OPERATION_DEADLINE_EXCEEDED",
  );
}

export async function runWithOperationDeadline(
  action,
  { timeoutMs = MCP_OPERATION_TIMEOUT_MS } = {},
) {
  if (operationDeadline.getStore()) return action();
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw deadlineExceeded();

  const controller = new AbortController();
  const context = {
    deadlineAt: Date.now() + Math.floor(timeoutMs),
    signal: controller.signal,
  };
  const timer = setTimeout(() => controller.abort(deadlineExceeded()), timeoutMs);
  try {
    return await operationDeadline.run(context, () =>
      raceWithOperationDeadline(Promise.resolve().then(action)),
    );
  } finally {
    clearTimeout(timer);
  }
}

export function raceWithOperationDeadline(promise) {
  const operation = Promise.resolve(promise);
  const context = operationDeadline.getStore();
  if (!context) return operation;
  if (context.signal.aborted) {
    // The caller still owns an already-started promise. Observe a later
    // rejection even though the public result must fail immediately.
    operation.catch(() => {});
    return Promise.reject(deadlineExceeded());
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      context.signal.removeEventListener("abort", onAbort);
      reject(deadlineExceeded());
    };
    context.signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        context.signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        context.signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function operationDeadlineSignal() {
  return operationDeadline.getStore()?.signal;
}

export function remainingOperationTimeMs({ fallbackMs, reserveMs = 0 }) {
  if (!Number.isFinite(fallbackMs) || fallbackMs <= 0) {
    throw new TypeError("fallbackMs must be a positive finite number.");
  }
  if (!Number.isFinite(reserveMs) || reserveMs < 0) {
    throw new TypeError("reserveMs must be a non-negative finite number.");
  }

  const context = operationDeadline.getStore();
  if (!context) return Math.floor(fallbackMs);
  if (context.signal.aborted) throw deadlineExceeded();

  const remainingMs = Math.floor(context.deadlineAt - Date.now() - reserveMs);
  if (remainingMs <= 0) throw deadlineExceeded();
  return Math.min(Math.floor(fallbackMs), remainingMs);
}

export function operationRequestBudget({ fallbackMs, reserveMs = 250 }) {
  const timeout = remainingOperationTimeMs({ fallbackMs, reserveMs });
  const signal = operationDeadlineSignal();
  return {
    timeout,
    ...(signal ? { signal } : {}),
  };
}

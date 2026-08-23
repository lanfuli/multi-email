import assert from "node:assert/strict";
import test from "node:test";
import {
  operationDeadlineSignal,
  operationRequestBudget,
  raceWithOperationDeadline,
  remainingOperationTimeMs,
  runWithOperationDeadline,
} from "../src/operation-deadline.mjs";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("provider deadline helpers use a safe fallback outside an MCP operation", () => {
  assert.equal(operationDeadlineSignal(), undefined);
  assert.equal(remainingOperationTimeMs({ fallbackMs: 90_000 }), 90_000);
  assert.deepEqual(operationRequestBudget({ fallbackMs: 90_000 }), {
    timeout: 90_000,
  });
});

test("one absolute deadline bounds the whole operation and exposes a shared signal", async () => {
  const startedAt = Date.now();
  await assert.rejects(
    runWithOperationDeadline(
      async () => {
        const first = operationRequestBudget({ fallbackMs: 90_000, reserveMs: 0 });
        assert.ok(first.timeout > 0 && first.timeout <= 30);
        assert.equal(first.signal, operationDeadlineSignal());
        await raceWithOperationDeadline(new Promise(() => {}));
      },
      { timeoutMs: 30 },
    ),
    { code: "OPERATION_DEADLINE_EXCEEDED" },
  );
  assert.ok(Date.now() - startedAt < 1_000);
});

test("an expired operation refuses to start another provider request", async () => {
  let requestsStarted = 0;
  await assert.rejects(
    runWithOperationDeadline(
      async () => {
        await delay(15);
        const options = operationRequestBudget({ fallbackMs: 90_000 });
        requestsStarted += 1;
        return options;
      },
      { timeoutMs: 10 },
    ),
    { code: "OPERATION_DEADLINE_EXCEEDED" },
  );
  assert.equal(requestsStarted, 0);
});

test("completed deadline races remove their abort listeners", async () => {
  await runWithOperationDeadline(async () => {
    const signal = operationDeadlineSignal();
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    let activeListeners = 0;
    signal.addEventListener = (...args) => {
      activeListeners += 1;
      return add(...args);
    };
    signal.removeEventListener = (...args) => {
      activeListeners -= 1;
      return remove(...args);
    };

    for (let index = 0; index < 20; index += 1) {
      assert.equal(await raceWithOperationDeadline(Promise.resolve(index)), index);
      assert.equal(activeListeners, 0);
    }
  });
});

test("an expired race still observes a late inner rejection", async () => {
  let rejectInner;
  const inner = new Promise((_, reject) => {
    rejectInner = reject;
  });
  let finishExercise;
  const exercise = new Promise((resolve) => {
    finishExercise = resolve;
  });

  await assert.rejects(
    runWithOperationDeadline(
      async () => {
        await delay(20);
        try {
          await assert.rejects(raceWithOperationDeadline(inner), {
            code: "OPERATION_DEADLINE_EXCEEDED",
          });
          rejectInner(new Error("late inner rejection"));
          await delay(20);
          finishExercise(null);
        } catch (error) {
          finishExercise(error);
        }
      },
      { timeoutMs: 10 },
    ),
    { code: "OPERATION_DEADLINE_EXCEEDED" },
  );

  const exerciseError = await exercise;
  if (exerciseError) throw exerciseError;
});

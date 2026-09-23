import { describe, expect, it } from "vitest";
import { openUrlWith } from "../../src/tools/setup.js";

describe("opening a browser", () => {
  it("reports failure instead of crashing when the opener is not installed", async () => {
    // The case this exists for: a headless Linux box with no xdg-open. `spawn`
    // does not throw for a missing binary — it emits an async `error` event,
    // and an unhandled one on a ChildProcess takes the whole process down. A
    // try/catch around spawn() catches nothing here.
    await expect(
      openUrlWith("definitely-not-a-real-opener-xyz", ["http://127.0.0.1:1/"])
    ).resolves.toBe(false);
  });

  it("reports success when the command does exist", async () => {
    // Something guaranteed present on every platform this ships to, invoked so
    // it exits immediately without opening anything.
    const [command, args] =
      process.platform === "win32"
        ? (["cmd", ["/c", "exit"]] as const)
        : (["true", []] as const);

    await expect(openUrlWith(command, [...args])).resolves.toBe(true);
  });

  it("does not leave an unhandled error event behind", async () => {
    // Belt and braces: if the rejection path ever regressed to an unhandled
    // 'error', this would surface as an unhandledRejection or a hard exit
    // rather than a clean false.
    const results = await Promise.all([
      openUrlWith("nope-not-here-1", ["x"]),
      openUrlWith("nope-not-here-2", ["x"]),
      openUrlWith("nope-not-here-3", ["x"]),
    ]);
    expect(results).toEqual([false, false, false]);
  });
});

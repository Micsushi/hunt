import { PlaywrightPersistentContextLauncher } from "../../src/browser/playwright-live/private/playwright-launcher.ts";

const profilePath = process.argv[2];
if (typeof profilePath !== "string") throw new TypeError("probe profile missing");
const launcher = new PlaywrightPersistentContextLauncher();
const context = await launcher.launchPersistentContext(profilePath, { headless: false });
try {
  const page = context.pages()[0] ?? await context.newPage();
  const session = await (context as never as {
    newCDPSession(page: unknown): Promise<{
      send(method: string, parameters?: unknown): Promise<unknown>;
      detach(): Promise<void>;
    }>;
  }).newCDPSession(page);
  try {
    const { windowId } = await session.send("Browser.getWindowForTarget") as {
      readonly windowId: number;
    };
    const { bounds } = await session.send("Browser.getWindowBounds", { windowId }) as {
      readonly bounds: Readonly<Record<string, unknown>>;
    };
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    process.stdout.write(`${JSON.stringify({ kind: "isolated_browser_probe", bounds })}\n`);
  } finally {
    await session.detach();
  }
} finally {
  await context.close();
}

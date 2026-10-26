import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { boundedNetworkBuffers } from "../../src/product/extension-bridge.ts";

test("bounded Network retention preserves stricter limits, events, navigation and file upload", async () => {
  assert.deepEqual(boundedNetworkBuffers({ maxTotalBufferSize: 1024, maxResourceBufferSize: 0, maxPostDataSize: 512 }),
    { maxTotalBufferSize: 1024, maxResourceBufferSize: 0, maxPostDataSize: 512 });
  assert.equal(boundedNetworkBuffers({ maxTotalBufferSize: 200_000_000 }).maxTotalBufferSize, 4 * 1024 * 1024);
  const server = createServer((req, res) => {
    if (req.url === "/upload") {
      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.on("end", () => { res.end(body.includes("fixture-content") ? "uploaded" : "missing"); });
    } else {
      res.setHeader("Content-Type", "text/html");
      res.end('<input type="file">');
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const browser = await chromium.launch({ headless: true,
    ...(process.env.HUNT_C3_CHROMIUM ? { executablePath: process.env.HUNT_C3_CHROMIUM } : {}) });
  try {
    const page = await browser.newPage();
    const session = await page.context().newCDPSession(page);
    await session.send("Network.enable", boundedNetworkBuffers({}));
    let completed = 0;
    session.on("Network.loadingFinished", () => { completed++; });
    const url = `http://127.0.0.1:${address.port}`;
    await page.goto(url);
    await page.locator("input").setInputFiles({ name: "fixture.txt", mimeType: "text/plain", buffer: Buffer.from("fixture-content") });
    const result = await page.evaluate(async () => {
      const data = new FormData();
      data.append("file", document.querySelector("input")!.files![0]!);
      return (await fetch("/upload", { method: "POST", body: data })).text();
    });
    assert.equal(result, "uploaded");
    await page.goto(`${url}/next`);
    assert.equal(page.url(), `${url}/next`);
    assert.ok(completed >= 3);
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

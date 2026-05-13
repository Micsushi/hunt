export const WORKDAY_RUNTIME_ERROR_REASON = "workday_runtime_error";

function normalizeText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function isWorkdayRuntimeErrorText(value) {
  const text = normalizeText(value);
  return (
    text.includes("something went wrong") &&
    text.includes("please refresh the page and then try again")
  );
}

export async function detectWorkdayRuntimeErrorForTab(tabId) {
  if (!tabId) {
    return { found: false, reason: "missing_tab" };
  }
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        function compact(value) {
          return String(value || "")
            .replace(/\s+/g, " ")
            .trim();
        }

        const bodyText = compact(document.body?.innerText || "");
        const lower = bodyText.toLowerCase();
        const found =
          lower.includes("something went wrong") &&
          lower.includes("please refresh the page and then try again");
        if (!found) {
          return {
            found: false,
            href: window.location.href,
          };
        }
        const stepLabel =
          Array.from(
            document.querySelectorAll(
              '[aria-current="step"], [data-automation-id*="progress"], [data-automation-id*="step"]',
            ),
          )
            .map((element) => compact(element.innerText || element.textContent))
            .find(Boolean) || "";
        return {
          found: true,
          href: window.location.href,
          title: compact(document.title),
          stepLabel,
          message: bodyText.slice(0, 500),
        };
      },
    });
    const found = results.find((entry) => entry.result?.found);
    if (!found) {
      return {
        found: false,
        framesChecked: results.length,
      };
    }
    return {
      ...found.result,
      frameId: found.frameId,
      framesChecked: results.length,
    };
  } catch (error) {
    return {
      found: false,
      reason: "runtime_error_detection_failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function waitForTabReloadComplete(tabId, timeoutMs = 12000) {
  if (!tabId) {
    return { ok: false, reason: "missing_tab" };
  }
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve({ ok: false, reason: "reload_timeout" });
    }, timeoutMs);
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") {
        return;
      }
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve({ ok: true });
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

export async function recoverWorkdayRuntimeErrorForTab(
  tabId,
  { reason = WORKDAY_RUNTIME_ERROR_REASON, settleMs = 1500 } = {},
) {
  const before = await detectWorkdayRuntimeErrorForTab(tabId);
  if (!before.found) {
    return {
      attempted: false,
      ok: true,
      reason: before.reason || "not_present",
      before,
    };
  }
  await chrome.tabs.reload(tabId);
  const reload = await waitForTabReloadComplete(tabId);
  if (!reload.ok) {
    return {
      attempted: true,
      ok: false,
      reason: reload.reason || "reload_failed",
      before,
      reload,
    };
  }
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  const after = await detectWorkdayRuntimeErrorForTab(tabId);
  return {
    attempted: true,
    ok: !after.found,
    reason,
    before,
    reload,
    after,
  };
}

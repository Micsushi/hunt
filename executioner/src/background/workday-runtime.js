export const WORKDAY_RUNTIME_ERROR_REASON = "workday_runtime_error";
export const WORKDAY_EMPTY_APPLICATION_SHELL_REASON =
  "workday_application_shell_empty";

function normalizeText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function isWorkdayRuntimeErrorText(value) {
  const text = normalizeText(value);
  return (
    (text.includes("something went wrong") &&
      (text.includes("please refresh the page and then try again") ||
        text.includes("plea e refre h the page and then try again") ||
        (text.includes("refre") && text.includes("try again")))) ||
    (text.includes("error-page error") && text.includes("error code:")) ||
    /\berror code:\s*vps\|/i.test(value || "") ||
    /\bvps\|[0-9a-f-]{20,}/i.test(value || "")
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
          (lower.includes("something went wrong") &&
            (lower.includes("please refresh the page and then try again") ||
              lower.includes("plea e refre h the page and then try again") ||
              (lower.includes("refre") && lower.includes("try again")))) ||
          (lower.includes("error-page error") &&
            lower.includes("error code:")) ||
          /\berror code:\s*vps\|/i.test(bodyText) ||
          /\bvps\|[0-9a-f-]{20,}/i.test(bodyText);
        const href = window.location.href;
        if (!found) {
          const applyUrl =
            /myworkdayjobs\.com/i.test(href) && /\/apply\//i.test(href);
          const signedInShell = /settings/.test(lower) && /@/.test(lower);
          const hasApplicationContent =
            /current step|create account\/sign in|my information|my experience|application questions|voluntary disclosures|review|save and continue|next/.test(
              lower,
            );
          if (applyUrl && signedInShell && !hasApplicationContent) {
            return {
              found: true,
              reason: "workday_application_shell_empty",
              href,
              title: compact(document.title),
              stepLabel: "",
              message: bodyText.slice(0, 500),
            };
          }
          return {
            found: false,
            href,
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
          reason: "workday_runtime_error",
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
      maxRuntimeRefreshRetries: 1,
      before,
      reload,
    };
  }
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  const after = await detectWorkdayRuntimeErrorForTab(tabId);
  return {
    attempted: true,
    ok: !after.found,
    reason: after.reason || before.reason || reason,
    maxRuntimeRefreshRetries: 1,
    before,
    reload,
    after,
  };
}

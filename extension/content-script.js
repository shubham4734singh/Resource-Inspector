const interestingExtensionPattern = /\.(pdf|pptx?|docx?|xlsx?|csv|txt|zip|png|jpe?g|gif|webp|svg)(\?|#|$)/i;
const seenUrls = new Set();
const runtimeApi = globalThis.chrome?.runtime;

function absoluteUrl(value) {
  if (!value) return "";
  try {
    return new URL(value, window.location.href).toString();
  } catch {
    return "";
  }
}

function sendHint(url, detectedBy) {
  const normalizedUrl = absoluteUrl(url);
  if (!normalizedUrl || seenUrls.has(normalizedUrl) || !interestingExtensionPattern.test(normalizedUrl)) return;
  seenUrls.add(normalizedUrl);
  if (!runtimeApi?.sendMessage) return;

  try {
    const maybePromise = runtimeApi.sendMessage({
      type: "RESOURCE_HINT",
      resource: {
        url: normalizedUrl,
        mimeType: "",
        size: 0,
        detectedBy
      }
    });
    if (typeof maybePromise?.catch === "function") {
      maybePromise.catch(() => {});
    }
  } catch {
    // Ignore messaging errors from transient frames or pages tearing down.
  }
}

function scanElement(element) {
  if (!(element instanceof Element)) return;
  for (const attribute of ["src", "href", "data"]) {
    sendHint(element.getAttribute(attribute), `dom:${attribute}`);
  }

  if (element instanceof HTMLIFrameElement) {
    sendHint(element.src, "iframe");
  }
}

function scanDocument() {
  document.querySelectorAll("a[href], iframe[src], embed[src], object[data], img[src], source[src]").forEach(scanElement);
}

function watchPerformanceEntries() {
  performance.getEntriesByType("resource").forEach((entry) => sendHint(entry.name, entry.initiatorType || "performance"));

  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      sendHint(entry.name, entry.initiatorType || "performance");
    }
  });

  try {
    observer.observe({ type: "resource", buffered: true });
  } catch {
    observer.observe({ entryTypes: ["resource"] });
  }
}

scanDocument();
watchPerformanceEntries();

const mutationObserver = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    mutation.addedNodes.forEach(scanElement);
    if (mutation.type === "attributes") scanElement(mutation.target);
  }
});

function startMutationObserver() {
  if (!document.documentElement) return false;
  mutationObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "href", "data"]
  });
  return true;
}

if (!startMutationObserver()) {
  document.addEventListener(
    "DOMContentLoaded",
    () => {
      scanDocument();
      startMutationObserver();
    },
    { once: true }
  );
}

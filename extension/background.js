const DOWNLOADABLE_MIME_PATTERNS = [
  /^application\/pdf$/i,
  /^application\/vnd\.ms-powerpoint$/i,
  /^application\/vnd\.openxmlformats-officedocument\.presentationml\.presentation$/i,
  /^application\/msword$/i,
  /^application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document$/i,
  /^application\/vnd\.ms-excel$/i,
  /^application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet$/i,
  /^application\/zip$/i,
  /^application\/x-zip-compressed$/i,
  /^image\//i,
  /^text\/csv$/i,
  /^text\/plain$/i
];

const EXTENSION_TYPE_MAP = new Map([
  ["pdf", "PDF"],
  ["ppt", "PowerPoint"],
  ["pptx", "PowerPoint"],
  ["doc", "Word"],
  ["docx", "Word"],
  ["xls", "Excel"],
  ["xlsx", "Excel"],
  ["csv", "CSV"],
  ["txt", "Text"],
  ["zip", "Archive"],
  ["png", "Image"],
  ["jpg", "Image"],
  ["jpeg", "Image"],
  ["gif", "Image"],
  ["webp", "Image"],
  ["svg", "Image"]
]);

const resourcesByTab = new Map();
const queueItems = new Map();
const QUEUE_STORAGE_KEY = "downloadQueueState";
const APP_POPUP_WIDTH = 800;
const APP_POPUP_HEIGHT = 500;
let popupWindowId = null;
let lastActivePageTabId = null;
let queueHydrated = false;

function headerValue(headers = [], name) {
  return headers.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function normalizeMime(contentType) {
  return contentType.split(";")[0].trim().toLowerCase();
}

function fileExtensionFromUrl(url) {
  try {
    const parsed = new URL(url);
    const lastSegment = parsed.pathname.split("/").filter(Boolean).pop() ?? "";
    const extension = lastSegment.includes(".") ? lastSegment.split(".").pop().toLowerCase() : "";
    return extension;
  } catch {
    return "";
  }
}

function inferFileName(url, contentDisposition = "") {
  const fileNameMatch = /filename\*?=(?:UTF-8'')?["']?([^"';]+)["']?/i.exec(contentDisposition);
  if (fileNameMatch) return decodeURIComponent(fileNameMatch[1]);
  try {
    const parsed = new URL(url);
    const lastPart = parsed.pathname.split("/").filter(Boolean).pop();
    return lastPart ? decodeURIComponent(lastPart) : parsed.hostname;
  } catch {
    return "download";
  }
}

function inferType(url, mimeType) {
  const fromMime = {
    "application/pdf": "PDF",
    "application/vnd.ms-powerpoint": "PowerPoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "PowerPoint",
    "application/msword": "Word",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word",
    "application/vnd.ms-excel": "Excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel",
    "application/zip": "Archive",
    "application/x-zip-compressed": "Archive",
    "text/csv": "CSV",
    "text/plain": "Text"
  }[mimeType];
  if (fromMime) return fromMime;
  if (mimeType.startsWith("image/")) return "Image";

  const extension = fileExtensionFromUrl(url);
  return EXTENSION_TYPE_MAP.get(extension) ?? "File";
}

function isDownloadable(url, mimeType, disposition = "") {
  const extension = fileExtensionFromUrl(url);
  const knownExtension = EXTENSION_TYPE_MAP.has(extension);
  const knownMime = DOWNLOADABLE_MIME_PATTERNS.some((pattern) => pattern.test(mimeType));

  if (knownMime) return true;

  if (/attachment/i.test(disposition)) {
    if (!mimeType) return knownExtension;
    if (/^(text\/html|text\/css|application\/javascript|text\/javascript|application\/json)/i.test(mimeType)) return false;
    return true;
  }

  return knownExtension;
}

function resourceId(tabId, url) {
  return `${tabId}:${url}`;
}

function upsertResource(tabId, resource) {
  if (tabId < 0) return;
  const tabResources = resourcesByTab.get(tabId) ?? new Map();
  const existing = tabResources.get(resource.id);
  tabResources.set(resource.id, { ...existing, ...resource, detectedAt: existing?.detectedAt ?? Date.now() });
  resourcesByTab.set(tabId, tabResources);
  chrome.runtime.sendMessage({ type: "RESOURCE_UPDATED", tabId }).catch(() => {});
}

function serializeQueue() {
  return {
    items: [...queueItems.values()].sort((a, b) => a.createdAt - b.createdAt)
  };
}

function emitQueueUpdated() {
  chrome.runtime.sendMessage({ type: "QUEUE_UPDATED", queue: serializeQueue() }).catch(() => {});
}

function persistQueue() {
  chrome.storage.local.set({ [QUEUE_STORAGE_KEY]: serializeQueue() }).catch(() => {});
}

function clearQueueState() {
  queueItems.clear();
  chrome.storage.local.remove(QUEUE_STORAGE_KEY).catch(() => {});
  emitQueueUpdated();
}

function updateQueueState() {
  persistQueue();
  emitQueueUpdated();
}

async function hydrateQueue() {
  if (queueHydrated) return;
  queueHydrated = true;
  try {
    const stored = await chrome.storage.local.get(QUEUE_STORAGE_KEY);
    const savedQueue = stored?.[QUEUE_STORAGE_KEY];
    if (!savedQueue) return;

    for (const item of savedQueue.items ?? []) {
      queueItems.set(item.id, {
        ...item,
        status: item.status === "preparing" ? "queued" : item.status,
        updatedAt: Date.now()
      });
    }
  } catch {
    // Ignore storage hydration failures and continue with an empty queue.
  }
  updateQueueState();
}

function queueItemSummary(item) {
  return {
    id: item.id,
    resource: item.resource,
    status: item.status,
    error: item.error ?? "",
    retryCount: item.retryCount ?? 0,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  };
}

function enqueueResources(resources = []) {
  const added = [];
  const skipped = [];

  for (const resource of resources) {
    const duplicate = [...queueItems.values()].find((item) => item.resource.url === resource.url && item.status !== "cancelled");
    if (duplicate) {
      skipped.push(queueItemSummary(duplicate));
      continue;
    }

    const createdAt = Date.now();
    const item = {
      id: `queue:${resource.id}:${createdAt}`,
      resource,
      status: "queued",
      error: "",
      createdAt,
      updatedAt: createdAt,
      zipPath: sanitizeFileName(resource.fileName || "download")
    };
    queueItems.set(item.id, item);
    added.push(queueItemSummary(item));
  }

  if (added.length) updateQueueState();
  return { added, skipped };
}

async function handleQueueAction(message) {
  if (message.action === "clearCompleted") {
    for (const [itemId, item] of queueItems.entries()) {
      if (item.status === "done" || item.status === "failed") {
        queueItems.delete(itemId);
      }
    }
    updateQueueState();
    return { ok: true };
  }

  const item = queueItems.get(message.itemId);
  if (!item) return { ok: false, error: "Queue item not found" };

  if (message.action === "retry") {
    queueItems.set(item.id, {
      ...item,
      status: "queued",
      error: "",
      updatedAt: Date.now()
    });
    updateQueueState();
    return { ok: true };
  }

  if (message.action === "remove") {
    queueItems.delete(item.id);
    updateQueueState();
    return { ok: true };
  }

  return { ok: false, error: "Unsupported queue action" };
}

function dedupeZipPath(preferredPath, usedPaths) {
  const cleanPath = preferredPath || "download";
  if (!usedPaths.has(cleanPath)) {
    usedPaths.add(cleanPath);
    return cleanPath;
  }

  const extensionIndex = cleanPath.lastIndexOf(".");
  const baseName = extensionIndex > 0 ? cleanPath.slice(0, extensionIndex) : cleanPath;
  const extension = extensionIndex > 0 ? cleanPath.slice(extensionIndex) : "";
  let suffix = 2;
  while (usedPaths.has(`${baseName}-${suffix}${extension}`)) {
    suffix += 1;
  }
  const finalPath = `${baseName}-${suffix}${extension}`;
  usedPaths.add(finalPath);
  return finalPath;
}

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ -1) >>> 0;
}

function dateToDos(date) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((Math.floor(date.getSeconds() / 2)) & 0x1f);
  const dosDate = (((year - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0xf) << 5) | (date.getDate() & 0x1f);
  return { dosDate, dosTime };
}

function uint16(value) {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function uint32(value) {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function createZip(entries) {
  const fileParts = [];
  const centralDirectory = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.name);
    const { dosDate, dosTime } = dateToDos(entry.modifiedAt ?? new Date());
    const localHeader = new Uint8Array([
      0x50, 0x4b, 0x03, 0x04,
      20, 0,
      0, 0,
      0, 0,
      ...uint16(dosTime),
      ...uint16(dosDate),
      ...uint32(entry.crc32),
      ...uint32(entry.bytes.length),
      ...uint32(entry.bytes.length),
      ...uint16(nameBytes.length),
      0, 0
    ]);
    const localPart = new Uint8Array(localHeader.length + nameBytes.length + entry.bytes.length);
    localPart.set(localHeader, 0);
    localPart.set(nameBytes, localHeader.length);
    localPart.set(entry.bytes, localHeader.length + nameBytes.length);
    fileParts.push(localPart);

    const centralHeader = new Uint8Array([
      0x50, 0x4b, 0x01, 0x02,
      20, 0,
      20, 0,
      0, 0,
      0, 0,
      ...uint16(dosTime),
      ...uint16(dosDate),
      ...uint32(entry.crc32),
      ...uint32(entry.bytes.length),
      ...uint32(entry.bytes.length),
      ...uint16(nameBytes.length),
      0, 0,
      0, 0,
      0, 0,
      0, 0,
      0, 0, 0, 0,
      ...uint32(offset)
    ]);
    const centralPart = new Uint8Array(centralHeader.length + nameBytes.length);
    centralPart.set(centralHeader, 0);
    centralPart.set(nameBytes, centralHeader.length);
    centralDirectory.push(centralPart);
    offset += localPart.length;
  }

  const centralSize = centralDirectory.reduce((total, part) => total + part.length, 0);
  const endRecord = new Uint8Array([
    0x50, 0x4b, 0x05, 0x06,
    0, 0,
    0, 0,
    ...uint16(entries.length),
    ...uint16(entries.length),
    ...uint32(centralSize),
    ...uint32(offset),
    0, 0
  ]);

  return new Blob([...fileParts, ...centralDirectory, endRecord], { type: "application/zip" });
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, Math.min(index + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return `data:${blob.type || "application/octet-stream"};base64,${bytesToBase64(bytes)}`;
}

async function fetchResourceBytes(resource) {
  const response = await fetch(resource.url, {
    credentials: "include",
    cache: "no-store"
  });
  if (!response.ok) {
    throw new Error(`Fetch failed (${response.status})`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function downloadQueueAsZip() {
  try {
    const queuedItems = [...queueItems.values()].filter((item) => item.status === "queued");
    if (!queuedItems.length) return { ok: false, error: "Queue is empty" };

    for (const item of queuedItems) {
      queueItems.set(item.id, { ...item, status: "preparing", error: "", updatedAt: Date.now() });
    }
    updateQueueState();

    const usedPaths = new Set();
    const zipEntries = [];

    for (const item of queuedItems) {
      try {
        const bytes = await fetchResourceBytes(item.resource);
        const finalPath = dedupeZipPath(item.zipPath, usedPaths);
        zipEntries.push({
          name: finalPath,
          bytes,
          crc32: crc32(bytes),
          modifiedAt: new Date()
        });
        queueItems.set(item.id, {
          ...queueItems.get(item.id),
          status: "done",
          error: "",
          zipPath: finalPath,
          updatedAt: Date.now()
        });
      } catch (error) {
        queueItems.set(item.id, {
          ...queueItems.get(item.id),
          status: "failed",
          error: error.message || "ZIP preparation failed",
          updatedAt: Date.now()
        });
      }
      updateQueueState();
    }

    if (!zipEntries.length) {
      return { ok: false, error: "Could not fetch any queued files" };
    }

    const zipBlob = createZip(zipEntries);
    const zipUrl = await blobToDataUrl(zipBlob);
    const downloadId = await chrome.downloads.download({
      url: zipUrl,
      filename: `Resource Inspector/resource-bundle-${Date.now()}.zip`,
      conflictAction: "uniquify",
      saveAs: false
    });
    return { ok: true, downloadId, count: zipEntries.length };
  } catch (error) {
    return { ok: false, error: error?.message || "ZIP download failed" };
  }
}

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const mimeType = normalizeMime(headerValue(details.responseHeaders, "content-type"));
    const disposition = headerValue(details.responseHeaders, "content-disposition");
    if (!isDownloadable(details.url, mimeType, disposition)) return;

    const size = Number(headerValue(details.responseHeaders, "content-length")) || 0;
    const fileName = inferFileName(details.url, disposition);
    const domain = new URL(details.url).hostname;
    upsertResource(details.tabId, {
      id: resourceId(details.tabId, details.url),
      fileName,
      fileType: inferType(details.url, mimeType),
      mimeType: mimeType || "unknown",
      size,
      url: details.url,
      domain,
      detectedBy: details.type
    });
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_ACTIVE_PAGE_TAB") {
    sendResponse({ tabId: lastActivePageTabId });
    return true;
  }

  if (message.type === "RESOURCE_HINT" && sender.tab?.id !== undefined) {
    const url = message.resource?.url;
    if (!url) return false;
    const mimeType = normalizeMime(message.resource.mimeType ?? "");
    if (!isDownloadable(url, mimeType)) return false;
    upsertResource(sender.tab.id, {
      id: resourceId(sender.tab.id, url),
      fileName: inferFileName(url),
      fileType: inferType(url, mimeType),
      mimeType: mimeType || "unknown",
      size: message.resource.size ?? 0,
      url,
      domain: new URL(url).hostname,
      detectedBy: message.resource.detectedBy ?? "page"
    });
    return false;
  }

  if (message.type === "GET_RESOURCES") {
    const tabResources = resourcesByTab.get(message.tabId) ?? new Map();
    sendResponse({ resources: [...tabResources.values()].sort((a, b) => b.detectedAt - a.detectedAt) });
    return true;
  }

  if (message.type === "GET_QUEUE") {
    sendResponse({ queue: serializeQueue() });
    return true;
  }

  if (message.type === "CLEAR_RESOURCES") {
    resourcesByTab.delete(message.tabId);
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "DELETE_RESOURCE") {
    const tabResources = resourcesByTab.get(message.tabId);
    if (!tabResources) {
      sendResponse({ ok: false, error: "No resources found for this tab" });
      return true;
    }

    tabResources.delete(message.resourceId);
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "DOWNLOAD_RESOURCE") {
    downloadResource(message.resource).then(sendResponse);
    return true;
  }

  if (message.type === "ENQUEUE_RESOURCES") {
    sendResponse({ ok: true, ...enqueueResources(message.resources ?? []) });
    return true;
  }

  if (message.type === "QUEUE_ACTION") {
    handleQueueAction(message).then(sendResponse);
    return true;
  }

  if (message.type === "DOWNLOAD_QUEUE_ZIP") {
    downloadQueueAsZip().then(sendResponse);
    return true;
  }

  if (message.type === "BULK_DOWNLOAD") {
    const result = enqueueResources(message.resources ?? []);
    sendResponse({ ok: true, count: result.added.length, skipped: result.skipped.length });
    return true;
  }

  return false;
});

async function downloadResource(resource, options = {}) {
  const filename = options.fileNamePrefix
    ? `${sanitizeFileName(options.fileNamePrefix)}/${sanitizeFileName(resource.fileName)}`
    : sanitizeFileName(resource.fileName);
  try {
    const downloadId = await chrome.downloads.download({
      url: resource.url,
      filename,
      conflictAction: options.conflictAction ?? "uniquify",
      saveAs: false
    });
    return { ok: true, downloadId };
  } catch (firstError) {
    try {
      const retryUrl = new URL(resource.url);
      retryUrl.searchParams.set("_resourceInspectorRetry", String(Date.now()));
      const downloadId = await chrome.downloads.download({
        url: retryUrl.toString(),
        filename,
        conflictAction: options.conflictAction ?? "uniquify",
        saveAs: false
      });
      return { ok: true, downloadId, retried: true };
    } catch (retryError) {
      return { ok: false, error: retryError.message || firstError.message };
    }
  }
}

function sanitizeFileName(fileName) {
  return (fileName || "download").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 180);
}

function isTrackablePageTab(tab) {
  return Boolean(
    tab?.id >= 0 &&
    tab.windowId !== popupWindowId &&
    typeof tab.url === "string" &&
    !tab.url.startsWith("chrome-extension://")
  );
}

function rememberTab(tab) {
  if (isTrackablePageTab(tab)) {
    lastActivePageTabId = tab.id;
  }
}

chrome.action.onClicked.addListener(async () => {
  const popupUrl = chrome.runtime.getURL("index.html");

  const [currentTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  rememberTab(currentTab);

  if (popupWindowId !== null) {
    try {
      await chrome.windows.update(popupWindowId, { focused: true });
      return;
    } catch {
      popupWindowId = null;
    }
  }

  const createdWindow = await chrome.windows.create({
    url: popupUrl,
    type: "popup",
    width: APP_POPUP_WIDTH,
    height: APP_POPUP_HEIGHT
  });

  popupWindowId = createdWindow.id ?? null;
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === popupWindowId) {
    popupWindowId = null;
    clearQueueState();
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    rememberTab(tab);
  } catch {
    // Ignore tabs that disappear before we can read them.
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" || changeInfo.url) {
    rememberTab({ ...tab, id: tabId });
  }
});

hydrateQueue();

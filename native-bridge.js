const HOST_ID = "desktop-lyrics";
const MOEKOE_WS_URL = "ws://127.0.0.1:6520";
const THIRD_PARTY_WS_URL = "ws://127.0.0.1:6522";
const RECONNECT_DELAY = 1000;
const REQUEST_TIMEOUT = 5000;
const CONFIG_POLL_INTERVAL = 3000;
const CONFIG_KEY = "desktopLyricsConfig";
const LOCK_KEY = "desktopLyricsLocked";

const BUTTON = {
  fontDown: 1008,
  fontUp: 1009,
  lock: 1012,
  unlock: 1014
};

const port = chrome.runtime.connect({ name: "moekoe-native-host" });

let moekoeSocket = null;
let thirdPartySocket = null;
let moekoeReconnectTimer = null;
let thirdPartyReconnectTimer = null;
let updateTimer = null;
let configPollTimer = null;
let requestId = 0;

const pendingThirdPartyRequests = new Map();

const state = {
  moekoeUrl: MOEKOE_WS_URL,
  thirdPartyUrl: THIRD_PARTY_WS_URL,
  moekoeConnected: false,
  thirdPartyConnected: false,
  thirdPartyReadyState: "closed",
  lyricType: "",
  lyricLineCount: 0,
  lyricLoaded: false,
  lastLoadResult: null,
  lastLyricHash: "",
  isPlaying: false,
  timeMs: 0,
  syncedAt: Date.now(),
  locked: false,
  fontSize: null,
  configSavedAt: "",
  lastError: ""
};

let lastLyricMessage = null;
let lastSavedConfig = "";

port.onMessage.addListener(async (message) => {
  if (!message || typeof message !== "object") {
    return;
  }

  if (message.type === "bridge:get-status") {
    respond(message.requestId, await getStatus());
    return;
  }

  if (message.type === "bridge:reconnect") {
    reconnectAll();
    respond(message.requestId, await getStatus());
    return;
  }

  if (message.type === "bridge:command") {
    try {
      const result = await runCommand(message.action);
      respond(message.requestId, { ok: true, result, status: await getStatus() });
    } catch (error) {
      state.lastError = error.message;
      respond(message.requestId, { ok: false, message: error.message, status: await getStatus() });
    }
  }
});

connectMoeKoe();
connectThirdParty();
startUpdateTimer();

function connectMoeKoe() {
  clearTimeout(moekoeReconnectTimer);

  try {
    moekoeSocket = new WebSocket(MOEKOE_WS_URL);
  } catch (error) {
    state.lastError = error.message;
    scheduleMoeKoeReconnect();
    return;
  }

  moekoeSocket.onopen = () => {
    state.moekoeConnected = true;
    state.lastError = "";
    emitStatus();
  };

  moekoeSocket.onmessage = (event) => {
    handleMoeKoeMessage(event.data);
  };

  moekoeSocket.onerror = () => {
    state.lastError = "MoeKoe WebSocket 连接失败";
    emitStatus();
  };

  moekoeSocket.onclose = () => {
    state.moekoeConnected = false;
    emitStatus();
    scheduleMoeKoeReconnect();
  };
}

function connectThirdParty() {
  clearTimeout(thirdPartyReconnectTimer);
  stopConfigPolling();

  try {
    thirdPartySocket = new WebSocket(THIRD_PARTY_WS_URL);
    state.thirdPartyReadyState = "connecting";
  } catch (error) {
    state.lastError = error.message;
    scheduleThirdPartyReconnect();
    return;
  }

  thirdPartySocket.onopen = async () => {
    state.thirdPartyConnected = true;
    state.thirdPartyReadyState = "open";
    state.lastError = "";
    emitStatus();

    try {
      await restoreDesktopState();
    } catch (error) {
      state.lastError = error.message;
    }

    if (lastLyricMessage) {
      sendToThirdParty(lastLyricMessage);
      sendUpdate(getCurrentTimeMs());
    }

    startConfigPolling();
    emitStatus();
  };

  thirdPartySocket.onmessage = (event) => {
    handleThirdPartyMessage(event.data);
  };

  thirdPartySocket.onerror = () => {
    state.lastError = "第三方桌面歌词 WebSocket 连接失败";
    emitStatus();
  };

  thirdPartySocket.onclose = () => {
    state.thirdPartyConnected = false;
    state.thirdPartyReadyState = "closed";
    rejectPendingThirdPartyRequests("第三方桌面歌词已断开");
    stopConfigPolling();
    emitStatus();
    scheduleThirdPartyReconnect();
  };
}

function reconnectAll() {
  closeSocket(moekoeSocket);
  closeSocket(thirdPartySocket);
  connectMoeKoe();
  connectThirdParty();
}

function scheduleMoeKoeReconnect() {
  clearTimeout(moekoeReconnectTimer);
  moekoeReconnectTimer = setTimeout(connectMoeKoe, RECONNECT_DELAY);
}

function scheduleThirdPartyReconnect() {
  clearTimeout(thirdPartyReconnectTimer);
  thirdPartyReconnectTimer = setTimeout(connectThirdParty, RECONNECT_DELAY);
}

function closeSocket(socket) {
  try {
    if (socket) {
      socket.close();
    }
  } catch {
  }
}

function handleMoeKoeMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }

  if (message?.type === "lyrics") {
    handleLyrics(message.data || {});
    return;
  }

  if (message?.type === "playerState") {
    handlePlayerState(message.data || {});
  }
}

function handleLyrics(data) {
  if (typeof data.lyricsData === "string" && data.lyricsData.trim()) {
    loadLyric(data.lyricsData);
  }

  if (typeof data.currentTime === "number") {
    setCurrentTimeMs(secondsToMs(data.currentTime));
  }
}

function handlePlayerState(data) {
  if (typeof data.isPlaying === "boolean") {
    state.isPlaying = data.isPlaying;
  }

  if (typeof data.currentTime === "number") {
    setCurrentTimeMs(secondsToMs(data.currentTime));
  }

  emitStatus();
}

function loadLyric(lyricText) {
  const hash = hashText(lyricText);
  if (hash === state.lastLyricHash) {
    return;
  }

  state.lastLyricHash = hash;
  state.lyricType = "krc";
  state.lyricLineCount = countKrcLines(lyricText);
  state.lyricLoaded = false;
  state.lastLoadResult = null;

  lastLyricMessage = buildThirdPartyMessage("lyric_desktop_load_lyric", {
    data: lyricText,
    lyric: "krc"
  });

  sendToThirdParty(lastLyricMessage);
  emitStatus();
}

function handleThirdPartyMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }

  if (message?.id) {
    resolvePendingThirdPartyRequest(message);
  }

  if (message?.method === "button-click") {
    handleThirdPartyButton(message.params?.id_str);
  }

  if (message?.id && message.id.startsWith("lyric_desktop_load_lyric-")) {
    const result = readThirdPartyResult(message);
    state.lastLoadResult = result;
    state.lyricLoaded = result === true;
    emitStatus();
  }
}

function handleThirdPartyButton(button) {
  const command = mapButtonToCommand(button);
  if (command) {
    sendMoeKoeControl(command);
    return;
  }

  if (button === "lock") {
    setStoredLock(true);
    return;
  }

  if (button === "unlock") {
    setStoredLock(false);
    return;
  }

  if (button === "font_up" || button === "font_down" || button === "vertical" || button === "horizontal") {
    saveCurrentConfigSoon();
  }
}

function sendMoeKoeControl(command) {
  if (!command || !isOpen(moekoeSocket)) {
    return;
  }

  moekoeSocket.send(JSON.stringify({
    type: "control",
    data: { command }
  }));
}

function mapButtonToCommand(button) {
  if (button === "play" || button === "pause") {
    return "toggle";
  }
  if (button === "next") {
    return "next";
  }
  if (button === "prev") {
    return "prev";
  }
  return "";
}

async function runCommand(action) {
  if (action === "font-up") {
    const result = await callDesktopButton(BUTTON.fontUp);
    saveCurrentConfigSoon();
    return result;
  }

  if (action === "font-down") {
    const result = await callDesktopButton(BUTTON.fontDown);
    saveCurrentConfigSoon();
    return result;
  }

  if (action === "lock") {
    return setLocked(true);
  }

  if (action === "unlock") {
    return setLocked(false);
  }

  if (action === "save-config") {
    return saveCurrentConfig();
  }

  throw new Error("未知操作");
}

async function setLocked(locked) {
  const result = await callDesktopButton(locked ? BUTTON.lock : BUTTON.unlock);
  await setStoredLock(locked);
  return result;
}

async function setStoredLock(locked) {
  state.locked = locked;
  await storageSet({ [LOCK_KEY]: locked });
  emitStatus();
}

async function restoreDesktopState() {
  const stored = await storageGet([CONFIG_KEY, LOCK_KEY]);
  const config = parseStoredConfig(stored[CONFIG_KEY]);

  if (config) {
    await setDesktopConfig(config);
    state.fontSize = getConfigFontSize(config);
    await applyWindowRect();
  }

  if (stored[LOCK_KEY] === true) {
    await setLocked(true);
  } else {
    state.locked = false;
  }

  await saveCurrentConfig();
}

function parseStoredConfig(value) {
  if (typeof value === "string" && value.trim()) {
    return parseConfig(value);
  }

  if (value && typeof value === "object") {
    return { ...value };
  }

  return null;
}

async function setDesktopConfig(config) {
  return sendThirdPartyRequest("lyric_desktop_set_config", {
    config: JSON.stringify(config)
  });
}

async function applyWindowRect() {
  await callDesktopButton(BUTTON.fontUp);
  await callDesktopButton(BUTTON.fontDown);
}

function startConfigPolling() {
  stopConfigPolling();
  configPollTimer = setInterval(() => {
    saveCurrentConfig().catch((error) => {
      state.lastError = error.message;
    });
  }, CONFIG_POLL_INTERVAL);
}

function stopConfigPolling() {
  clearInterval(configPollTimer);
  configPollTimer = null;
}

let saveConfigTimer = null;

function saveCurrentConfigSoon() {
  clearTimeout(saveConfigTimer);
  saveConfigTimer = setTimeout(() => {
    saveCurrentConfig().catch((error) => {
      state.lastError = error.message;
    });
  }, 500);
}

async function saveCurrentConfig() {
  if (!isOpen(thirdPartySocket)) {
    return false;
  }

  const configText = await sendThirdPartyRequest("lyric_desktop_get_config", {});
  if (typeof configText !== "string" || !configText.trim()) {
    return false;
  }

  const config = parseConfig(configText);
  if (!config) {
    return false;
  }

  const normalizedText = JSON.stringify(config);

  if (normalizedText !== lastSavedConfig) {
    lastSavedConfig = normalizedText;
    await storageSet({ [CONFIG_KEY]: normalizedText });
  }

  state.fontSize = getConfigFontSize(config);
  state.configSavedAt = new Date().toISOString();
  emitStatus();
  return true;
}

function getConfigFontSize(config) {
  const size = Number(config?.nFontSize);
  return Number.isFinite(size) ? size : null;
}

function parseConfig(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function callDesktopButton(id) {
  return sendThirdPartyRequest("lyric_desktop_call_event", { id });
}

function startUpdateTimer() {
  clearInterval(updateTimer);
  updateTimer = setInterval(() => {
    if (state.isPlaying) {
      sendUpdate(getCurrentTimeMs());
    }
  }, 10);
}

function setCurrentTimeMs(timeMs) {
  state.timeMs = Math.max(0, Math.round(timeMs));
  state.syncedAt = Date.now();
  sendUpdate(state.timeMs);
}

function getCurrentTimeMs() {
  if (!state.isPlaying) {
    return state.timeMs;
  }

  return state.timeMs + Math.max(0, Date.now() - state.syncedAt);
}

function sendUpdate(timeMs) {
  sendToThirdParty({
    method: "lyric_desktop_update",
    params: {
      time: Math.max(0, Math.round(timeMs))
    }
  });
}

function sendThirdPartyRequest(method, params) {
  if (!isOpen(thirdPartySocket)) {
    return Promise.reject(new Error("第三方桌面歌词未连接"));
  }

  const message = buildThirdPartyMessage(method, params);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingThirdPartyRequests.delete(message.id);
      reject(new Error(`${method} 请求超时`));
    }, REQUEST_TIMEOUT);

    pendingThirdPartyRequests.set(message.id, { resolve, reject, timer });
    sendToThirdParty(message);
  });
}

function resolvePendingThirdPartyRequest(message) {
  const pending = pendingThirdPartyRequests.get(message.id);
  if (!pending) {
    return;
  }

  clearTimeout(pending.timer);
  pendingThirdPartyRequests.delete(message.id);
  pending.resolve(readThirdPartyResult(message));
}

function rejectPendingThirdPartyRequests(message) {
  for (const [id, pending] of pendingThirdPartyRequests) {
    clearTimeout(pending.timer);
    pending.reject(new Error(message));
    pendingThirdPartyRequests.delete(id);
  }
}

function readThirdPartyResult(message) {
  if (message.result && typeof message.result === "object" && "result" in message.result) {
    return message.result.result;
  }

  return message.result;
}

function sendToThirdParty(message) {
  if (!isOpen(thirdPartySocket)) {
    return false;
  }

  thirdPartySocket.send(JSON.stringify(message));
  return true;
}

function buildThirdPartyMessage(method, params) {
  return {
    id: `${method}-${++requestId}`,
    method,
    params
  };
}

function isOpen(socket) {
  return socket && socket.readyState === WebSocket.OPEN;
}

function secondsToMs(seconds) {
  return Math.round(seconds * 1000);
}

function countKrcLines(text) {
  return text.split(/\r?\n/).filter((line) => /^\[\d+,\d+\]/.test(line)).length;
}

function hashText(text) {
  let hash = 0;
  for (let index = 0; index < text.length; index++) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return String(hash);
}

function storageGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, resolve);
  });
}

function storageSet(items) {
  return new Promise((resolve) => {
    chrome.storage.local.set(items, resolve);
  });
}

async function getStatus() {
  let hostStatus = null;
  try {
    hostStatus = await window.electronAPI.nativeHost.getStatus(HOST_ID);
  } catch (error) {
    hostStatus = { success: false, message: error.message };
  }

  return {
    ...state,
    timeMs: getCurrentTimeMs(),
    hostStatus
  };
}

function respond(requestIdValue, result) {
  port.postMessage({
    type: "bridge:response",
    requestId: requestIdValue,
    result
  });
}

async function emitStatus() {
  port.postMessage({
    type: "bridge:status",
    payload: await getStatus()
  });
}

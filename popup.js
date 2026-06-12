const fields = {
  summary: document.getElementById("summary"),
  desktopStatus: document.getElementById("desktopStatus"),
  moekoeStatus: document.getElementById("moekoeStatus"),
  lyricStatus: document.getElementById("lyricStatus"),
  lockStatus: document.getElementById("lockStatus")
};

const buttons = {
  refresh: document.getElementById("refreshBtn"),
  reconnect: document.getElementById("reconnectBtn"),
  fontDown: document.getElementById("fontDownBtn"),
  fontUp: document.getElementById("fontUpBtn"),
  lock: document.getElementById("lockBtn"),
  unlock: document.getElementById("unlockBtn")
};

let busy = false;
let lastRender = null;

buttons.refresh.addEventListener("click", refresh);
buttons.reconnect.addEventListener("click", reconnect);
buttons.fontDown.addEventListener("click", () => runCommand("font-down"));
buttons.fontUp.addEventListener("click", () => runCommand("font-up"));
buttons.lock.addEventListener("click", () => runCommand("lock"));
buttons.unlock.addEventListener("click", () => runCommand("unlock"));

refresh();
setInterval(refresh, 2000);

async function refresh() {
  const status = await chrome.runtime.sendMessage({ type: "desktop-lyrics:get-status" });
  renderStatus(status || {});
}

async function reconnect() {
  await chrome.runtime.sendMessage({ type: "desktop-lyrics:reconnect" });
  setTimeout(refresh, 500);
}

async function runCommand(action) {
  setBusy(true);
  try {
    await chrome.runtime.sendMessage({ type: "desktop-lyrics:command", action });
  } finally {
    setBusy(false);
    await refresh();
  }
}

function renderStatus(result) {
  lastRender = result;
  const adapter = result.lastStatus || {};
  const host = adapter.hostStatus?.host || {};
  const ready = result.bridgeConnected && host.running && adapter.moekoeConnected && adapter.thirdPartyConnected;

  fields.summary.textContent = ready ? "已接入第三方桌面歌词" : "等待连接或授权";
  fields.desktopStatus.textContent = adapter.thirdPartyConnected ? "已连接" : host.running ? "启动中" : host.authorized ? "未启动" : "未授权";
  fields.moekoeStatus.textContent = adapter.moekoeConnected ? "已连接" : "未连接";
  fields.lyricStatus.textContent = getLyricText(adapter);
  fields.lockStatus.textContent = adapter.locked ? "已锁定" : "可拖动";

  const controlsEnabled = Boolean(result.bridgeConnected && adapter.thirdPartyConnected);
  buttons.fontDown.disabled = busy || !controlsEnabled;
  buttons.fontUp.disabled = busy || !controlsEnabled;
  buttons.lock.disabled = busy || !controlsEnabled || adapter.locked;
  buttons.unlock.disabled = busy || !controlsEnabled || !adapter.locked;
  buttons.reconnect.disabled = busy;
}

function getLyricText(adapter) {
  if (adapter.lyricLoaded) {
    return `${adapter.lyricLineCount || 0} 行`;
  }

  if (adapter.lastLoadResult === false) {
    return "加载失败";
  }

  return "等待播放";
}

function setBusy(value) {
  busy = value;
  if (lastRender) {
    renderStatus(lastRender);
  }
}

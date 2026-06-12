# MoeKoe 桌面歌词

一个 MoeKoe Music 第三方桌面歌词插件。

第三方桌面歌词程序来自 [lyric_exe.exe](https://github.com/kuodafu/lyrics) 部分功能未完善,有问题请去压力作者

## 环境要求

- Windows
- MoeKoe Music `1.6.6` 或更高版本
- MoeKoe 设置中开启 API 模式

## 安装

### 方式一：软件内自动安装（推荐）

1. 打开 `设置 -> 插件管理`
2. 切换到 `插件市场`
3. 搜索插件并点击 `安装`
4. 安装完成后刷新插件列表或重启应用

### 方式二：GitHub 手动下载安装

1. 从 GitHub 下载本项目源码（`Code -> Download ZIP`）
2. 安装方式二选一：
   - 复制解压后的文件夹到 MoeKoe 插件目录（`plugins/extensions`），然后在插件管理中刷新
   - 将该下载的 `zip` 文件，在 `设置 -> 插件管理 -> 安装插件` 中选择 zip 安装

## 使用

1. 在 MoeKoe Music 设置中开启 API 模式。
2. 在插件管理页启用并授权 `MoeKoe 桌面歌词`。
3. 播放歌曲后，第三方桌面歌词会自动显示并同步进度。
4. 点击插件弹窗可调整字号、锁定/解锁窗口，或重新连接歌词程序。

## 工作原理

```text
MoeKoe API WebSocket : ws://127.0.0.1:6520
        |
        v
插件隐藏桥接页 native-bridge.html
        |
        v
第三方歌词 WebSocket : ws://127.0.0.1:6522
```

## 配置记忆

第三方桌面歌词程序本身不会持久化窗口位置和字号。插件会定时调用第三方接口读取配置：

```text
lyric_desktop_get_config
```

并保存到 `chrome.storage.local`。下次启动时，插件会通过：

```text
lyric_desktop_set_config
```

恢复上次的窗口位置、字号等配置。

锁定状态也由插件保存，并在下次连接后自动恢复。

## 目录结构

```text
moekoe-lyric-desktop/
  manifest.json          插件清单
  background.js          插件后台消息转发
  native-bridge.html     隐藏桥接页
  native-bridge.js       MoeKoe 与第三方歌词程序的协议转换
  popup.html             插件弹窗
  popup.css              弹窗样式
  popup.js               弹窗交互
  bin/
    lyric_exe.exe
    lyric_desktop.dll
    bass.dll
```

## 常见问题

### 插件显示第三方歌词未连接

确认插件管理页已授权本地程序，并检查 `bin/lyric_exe.exe` 是否存在。

### 歌词不显示

确认 MoeKoe Music 已开启 API 模式，并且当前歌曲有歌词。插件依赖 MoeKoe API 推送 `lyrics` 和 `playerState` 数据。

### 端口冲突

插件默认使用：

- MoeKoe API：`6520`
- 第三方歌词程序：`6522`

如果本机已有程序占用 `6522`，需要修改 `manifest.json` 中的 `--ws-server=6522`，并同步修改 `native-bridge.js` 中的 `THIRD_PARTY_WS_URL`。


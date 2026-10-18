# CS2 录像中心

一个在 **Windows / Linux** 上运行的 CS2 比赛录像管理工具：同步最近比赛、通过分享代码添加比赛、下载 / 删除录像，并一键启动 CS2 播放。提供 **桌面应用、本地网页界面和命令行** 三种用法。

桌面应用内嵌本地服务，只监听 `127.0.0.1`，不会暴露到局域网。登录凭据只在本机保存 Steam 刷新令牌，**不会保存 Steam 密码**。

## 功能

- 独立桌面窗口，支持 Windows 安装包与 Linux AppImage / deb；Windows 安装时自动创建桌面和开始菜单快捷方式，deb 会登记应用菜单启动项
- 系统托盘菜单：打开主界面、刷新、打开录像 / 配置目录、退出
- 从 Steam 同步最近 8 场比赛（需要退出 CS2，避免 GC 会话冲突）
- 通过 CS2 分享代码添加任意可查询的比赛
- 下载、删除比赛录像，自动识别 `.bz2` / `.gz` 压缩格式
- 校验录像文件头（`PBDEMS2` / `HL2DEMO`），避免把损坏文件当成录像
- 一键下载并启动 CS2：`steam -applaunch 730 -insecure +playdemo "<录像绝对路径>"`
- 下载任务队列、进度展示、批量下载、下载全部
- 自动检测 Steam 目录、CS2 安装目录、replays 目录
- 中文响应式界面，桌面窗口和手机浏览器均可使用
- `--mock` 预览模式：不登录 Steam、不下载真实录像、不启动 CS2

## 环境要求

- **源码运行 / 自行打包：Node.js 22.12 或更高版本**（Electron 44 的开发环境要求）
- **使用已打包的安装包：不需要安装 Node.js**（应用自带 Electron 运行时）
- 已安装 Steam 和 CS2（播放功能需要）
- 同步最近比赛 / 查询分享代码时需要 Steam 账号。第一次登录需要扫码，或在界面中使用密码登录（会经过 Steam 官方登录流程）

> 已知限制：Valve 的录像下载链接有时效性。链接过期后重新同步或用分享代码刷新即可。

## 安装与启动

先安装依赖：

```bash
npm install
```

### 桌面应用（推荐）

源码模式下启动独立桌面窗口：

```bash
npm run desktop
```

首次运行时 Electron 会自动下载桌面运行时，需要网络连接；国内网络较慢时可以先设置镜像：

```bash
# Linux / macOS
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run desktop
```

```bat
:: Windows（命令提示符）
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm run desktop
```

预览界面（模拟数据，不连接 Steam / CS2）：

```bash
npm run desktop:mock
```

打包后的桌面应用在 Windows 上会创建桌面快捷方式。关闭主窗口即退出应用；运行期间可以通过系统托盘快速打开界面、录像目录或退出。

### 本地网页界面

```bash
npm start
```

也可以直接运行启动脚本：

- Windows：双击 `start.bat`，或运行 `start.bat`
- Linux / macOS：运行 `./start.sh`

启动后在浏览器打开默认地址：

```text
http://127.0.0.1:3210
```

如果希望启动时自动打开浏览器，可在命令后加 `--open`（支持桌面环境时）。

常用参数：

```bash
node bin/cs2hub.js ui --port 3211     # 指定端口
node bin/cs2hub.js ui --open          # 启动后自动打开浏览器
node bin/cs2hub.js ui --mock          # 预览模式，不需要 Steam / CS2
```

## 打包桌面应用

使用 electron-builder 生成安装包，产物位于 `dist/`：

```bash
npm run dist:win       # Windows NSIS 安装包（x64）
npm run dist:linux     # Linux AppImage + deb（x64）
npm run dist           # 为当前平台打包
```

- Windows 安装包支持选择安装目录，并创建桌面和开始菜单快捷方式。
- Linux 生成 `.AppImage` 与 `.deb`。AppImage 首次运行前需要执行 `chmod +x CS2-Demo-Hub-*.AppImage`，可直接作为单文件启动器运行；`.deb` 安装后会登记应用菜单启动项，并提供 `/usr/bin/cs2-demo-hub` 命令。
- 建议在目标系统上打包。Windows 安装包也可以在 Linux 上交叉打包，但发布前应在 Windows 实机验证。
- 打包后的应用自带 Electron 运行时，使用者无需安装 Node.js。
- 源码开发时如果 Electron 运行时下载失败，可设置 `ELECTRON_MIRROR` 后重新运行 `npm run desktop`。
- 打包工具也会下载 Electron 和 NSIS 等文件；网络受限时可设置 `ELECTRON_MIRROR` 与 `ELECTRON_BUILDER_BINARIES_MIRROR`。
- `package.json` 中的 `homepage` 目前是占位地址；正式对外发布前请替换为项目实际主页。

桌面应用的 Chromium 缓存与窗口位置保存在配置目录下的 `desktop/` 子目录，比赛记录和 Steam 登录信息仍使用原有配置目录。

## 使用流程

1. 启动桌面应用（或本地网页）。
2. 点击右上角账号区域登录 Steam。推荐扫码；也可以使用账号密码登录，遇到 Steam 令牌时输入验证码。
3. 点击「同步最近比赛」获取最近 8 场。
4. 选择比赛下载，或点击「下载全部」。
5. 下载完成后点击「播放」，工具会把录像放进 CS2 的 `game/csgo/replays`，再启动 Steam / CS2 播放。自动播放使用录像的绝对路径，并给本次 CS2 启动加上 `-insecure`；这是 CS2 接受 `+playdemo` 启动参数的必要条件。观看录像不需要 VAC，但如果之后要重新匹配，请退出 CS2 后从 Steam 正常启动。
6. 如果 CS2 已经打开并停留在主菜单，播放按钮会变为「导入并复制命令」：应用只把录像放入 `replays`，并自动复制 `playdemo "replays/<文件>"` 命令；回到 CS2 控制台粘贴执行即可。正在比赛中时无法播放录像，需要先退出比赛回到主菜单。
7. 如果自动检测不到环境，在「设置」中手动指定 CS2 的 `game/csgo` 目录或 Steam 可执行文件。

同步比赛、查询分享代码和删除录像前请先完全退出 CS2，避免 GC 连接冲突或文件被占用。CS2 已打开时仍可下载录像，也可以使用上述「导入并复制命令」流程播放。

### 分享代码

支持从比赛结束界面复制的分享代码，例如：

```text
CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx
```

在界面中点击「分享代码」，粘贴后查询并添加。也可以使用 CLI：

```bash
node bin/cs2hub.js share CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx --download
```

## 命令行

```bash
node bin/cs2hub.js login                 # 扫码登录，或加 --password 使用密码
node bin/cs2hub.js logout                # 退出并删除本地刷新令牌
node bin/cs2hub.js sync                  # 同步最近 8 场
node bin/cs2hub.js sync --download       # 同步并自动下载
node bin/cs2hub.js matches               # 查看比赛列表
node bin/cs2hub.js matches --json        # 机器可读输出
node bin/cs2hub.js download <比赛ID>     # 下载指定比赛（支持 ID 前缀）
node bin/cs2hub.js download --all        # 下载全部未下载录像
node bin/cs2hub.js play <比赛ID>         # 下载（如需要）并启动 CS2
node bin/cs2hub.js delete <比赛ID>       # 删除记录和录像（会请求确认）
node bin/cs2hub.js config                # 查看配置
node bin/cs2hub.js doctor                # 检查环境
```

安装为全局命令后可以直接使用 `cs2hub <命令>`：

```bash
npm install -g .
cs2hub ui
```

## 配置与隐私

默认路径：

| 项目 | Windows | Linux |
| --- | --- | --- |
| 配置/登录凭据 | `%APPDATA%\cs2-demo-hub` | `~/.config/cs2-demo-hub` |
| 录像目录 | `%USERPROFILE%\CS2Demos` | `~/CS2Demos` |

可以用环境变量 `CS2HUB_HOME` 覆盖配置目录，便于测试或便携部署：

```bash
CS2HUB_HOME=/path/to/data node bin/cs2hub.js ui
```

安全说明：

- Steam 密码只用于当前登录请求，不会写入磁盘。
- 登录成功后只保存 `steam-session` 提供的刷新令牌；文件权限在支持 POSIX 的系统上为 `0600`。
- 所有服务只绑定 `127.0.0.1`。
- 删除操作会同时清理比赛记录、下载目录中的录像，以及 CS2 `replays` 目录中对应的文件。

## 预览模式

没有 Steam 账号或只想查看界面时：

```bash
npm run desktop:mock                  # 桌面窗口
node bin/cs2hub.js ui --mock          # 本地网页
```

预览模式会使用模拟比赛和模拟录像文件，不会连接 Steam、不会下载真实录像，也不会启动 CS2。退出登录在预览模式下也是模拟操作，模拟账号会保持登录。

## 测试

```bash
npm test
```

测试使用 Node.js 内置测试运行器，共 38 项。覆盖分享代码、protobuf 字段归一化、配置与录像库、gzip/bz2 下载、真实模式下载目录、Steam 比赛请求、CS2 检测与 staging、CS2 启动参数、CS2 运行时的导入命令、HTTP API、静态资源、CLI 参数解析，以及桌面应用入口、AppImage 环境清理和打包资源。开发运行时、AppImage 与 deb 解包产物已通过 `--mock` 模式下的桌面窗口和 API 冒烟测试；Linux AppImage 已实际验证 Steam 扫码登录、比赛同步、真实录像下载，以及 CS2 运行时的录像导入与播放命令自动复制。CS2 一键启动播放已在打包后的 Linux AppImage 中实际验证：点击「播放」后 CS2 自动进入录像回放界面（绝对路径 + `-insecure`）；Windows 实机安装与启动仍需在对应环境验证。

## 常见问题

**获取登录二维码失败（AggregateError / 连接超时）？**  
检查系统 `hosts` 文件中是否有 Steam++ / Watt Toolkit 等工具写入的 Steam 域名 `127.0.0.1` 记录，例如 `login.steampowered.com`、`api.steampowered.com`。如果启用了这类加速工具，请确保其本地代理正在运行；否则先注释或删除这些记录，再重试扫码登录。

**同步提示 CS2 正在运行？**  
请完全退出 CS2（包括后台进程）后再同步。同步需要使用 Steam Game Coordinator，与游戏同时在线会冲突；查询分享代码和删除录像也建议先退出 CS2，避免文件占用。播放不受此限制：CS2 已打开时会改为「导入并复制命令」。

**找不到 CS2 或 Steam？**  
在「设置」中手动指定路径。CS2 请选择 `Counter-Strike Global Offensive/game/csgo` 目录，Steam 请选择 `steam.exe` / `steam.sh`。

**录像链接失效或下载 404？**  
Valve 下载链接会过期。重新同步比赛，或用分享代码重新获取链接。

**播放没有反应？**  
确认 Steam 已安装并已登录，且 `game/csgo/replays` 可写。

- CS2 未运行：点击「播放」会启动 Steam / CS2 并载入录像。应用使用 `-insecure +playdemo "<录像绝对路径>"`；CS2 只有在绝对路径且本次启动禁用 VAC 时才会接受启动参数中的 `+playdemo`。观看录像结束后如需匹配，请退出 CS2 并从 Steam 正常启动。
- CS2 已打开并停留在主菜单：按钮会变为「导入并复制命令」。点击后应用只把录像放入 `replays`，并自动复制 `playdemo "replays/<文件>"` 命令；到 CS2 控制台粘贴执行即可。需要先在 CS2 设置中启用开发者控制台。
- CS2 正在比赛中：游戏内不能直接播放录像，请先退出比赛回到主菜单，再导入并粘贴命令。
- 任务中心会保留实际命令，点击命令文本可以再次复制。

**Linux 上 AppImage 无法启动？**  
先执行 `chmod +x CS2-Demo-Hub-*.AppImage`。如果系统缺少 FUSE，可安装 FUSE 支持，或改用 `deb` 安装包。

**Linux 托盘图标不显示？**  
托盘依赖桌面环境的 AppIndicator / StatusNotifier 支持。GNOME 默认可能隐藏托盘图标，可安装 AppIndicator 扩展；`deb` 会推荐 `libappindicator3-1`。

**Windows 安装时出现 SmartScreen 提示？**  
当前安装包未配置商业代码签名证书，Windows 可能显示“未知发布者”。请确认文件来自可信位置；正式分发时建议配置代码签名。

**桌面窗口没有出现，或启动后立即退出？**  
从终端运行 `npm run desktop` 查看日志。打包后的应用可以设置环境变量 `CS2HUB_DEVTOOLS=1` 后启动，以便打开开发者工具排查。

**Windows 上双击 `start.bat` 后窗口一闪而过？**  
请确认已安装 Node.js 22.12+ 并加入 `PATH`，然后在终端中运行 `start.bat` 查看错误信息；也可以运行 `npm start`。

## 许可证

[MIT](LICENSE)

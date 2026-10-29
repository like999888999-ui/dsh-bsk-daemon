# dsh-bsk-daemon

[English](README.md) | 简体中文

让 [BrowserSkill](https://github.com/Tencent/BrowserSkill)（`bsk`）的守护进程在 DeepSeek Harness 里**按需唤醒、空闲退出**，并修掉 Windows 上根本起不来的问题。

```sh
dsh plugin --profile desktop add github:like999888999-ui/dsh-bsk-daemon
```

## 它解决什么问题

`browser-skill` 插件驱动一个本地 `bsk` 守护进程。默认情况下这个进程要么常驻（吃内存），要么在需要时由 `bsk` 自己拉起。而后者在 DSH 里是坏的：

```
automatic daemon startup failed: cannot start an independent Windows daemon;
the host may prohibit Job Object breakaway; ...
拒绝访问。 (os error 5)
```

原因是 DSH 宿主进程被包在 Windows Job Object 里，子进程不允许脱离。于是你第一次调用浏览器工具就直接报错，而且看不出该怎么修。

这个插件用一条**计划任务**绕开限制：计划任务由 `taskeng` 派生，不在宿主的 Job Object 内，能正常脱离。再加一个极小的唤醒 shim 顶在 `bsk` 前面——守护进程没跑就触发任务、等它就绪、原样转发调用。

结果：平时不占内存，用到的时候自动起来，用完按空闲超时自己退出。

## 安装

```sh
# 1. 装本插件
dsh plugin --profile desktop add github:like999888999-ui/dsh-bsk-daemon

# 2. 装 browser-skill（如果还没装）
dsh plugin --profile desktop add @wxg-prc-cpg/browser-skill-dsh-plugin

# 3. 完全退出 DSH 再打开
```

首次加载会自动执行一次 setup（编译 shim + 注册计划任务）。

## 把 browser-skill 指向 shim

本插件在 `~/.local/bin/` 生成 `bsk-shim.exe`。让 `browser-skill` 用它代替 `bsk`，在 profile 的 `cordis.patch.yml` 里加：

```yaml
- id: browserskill
  config:
    bskPath: 'C:\Users\<你>\.local\bin\bsk-shim.exe'
```

重启宿主后生效。之后所有浏览器工具调用都会自动处理守护进程的启停。

> 也可以不配 `bskPath`，改用本插件的 `bsk_wake` 工具在每轮浏览器操作前手动预热。效果一样，只是多一步。

## 提供的工具

| 工具 | 作用 |
| :-- | :-- |
| `bsk_status` | 守护进程是否在跑、连了几个浏览器、shim 与计划任务的状态 |
| `bsk_setup` | 重新编译 shim 并注册计划任务（幂等；升级 `bsk` 后用） |
| `bsk_wake` | 守护进程没跑就启动并等就绪 |
| `bsk_stop` | 立即停掉，不等空闲超时 |

## 配置

写进 profile 的 `cordis.patch.yml`，或用设置页。

| 字段 | 默认 | 说明 |
| :-- | :-- | :-- |
| `bskPath` | 空（自动探测） | `bsk` 可执行文件路径。留空依次试 `~/.local/bin/bsk.exe`、`~/.cargo/bin/bsk`、PATH |
| `taskName` | `bsk-daemon` | 计划任务名 |
| `daemonIdle` | `15m` | 守护进程空闲多久退出 |
| `sessionIdle` | `5m` | 单会话空闲超时 |
| `autoSetup` | `true` | 加载时自动执行一次 setup |
| `autoWake` | `true` | 浏览器工具执行前自动预热守护进程 |
| `shimPath` | 空（`~/.local/bin/bsk-shim.exe`） | shim 输出位置 |

## 平台差异

| 平台 | 唤醒方式 | 说明 |
| :-- | :-- | :-- |
| Windows | 计划任务 + shim | Job Object 限制，必须绕 |
| macOS / Linux | 普通分离进程 | 无此限制，不需要 shim |

非 Windows 平台本插件只提供状态与生命周期工具，不做 shim 与计划任务。

## 依赖

- Node.js ≥ 22.13.0
- `bsk` CLI（见 [BrowserSkill 快速开始](https://github.com/Tencent/BrowserSkill#quick-start)）
- Windows 构建 shim 需要系统自带的 .NET Framework 编译器 `csc.exe`（Win8 及以上都有，无需额外安装）

## 手动安装 shim（不装插件）

```sh
git clone https://github.com/like999888999-ui/dsh-bsk-daemon
cd dsh-bsk-daemon
node lib/shim/build-shim.mjs --bsk "C:\Users\你\.local\bin\bsk.exe" --task bsk-daemon
```

然后按上文注册计划任务，或让插件替你注册。

## 卸载

```sh
dsh plugin --profile desktop remove dsh-bsk-daemon
schtasks /Delete /TN bsk-daemon /F
```

`~/.bsk/` 下的 `bsk-daemon-launch.vbs` 与 `bsk-daemon.xml` 可一并删除。

## 已知限制

- **Windows 专属痛点**：非 Windows 平台这套机制是多余的（但无害）。
- **冷启动约 4–8 秒**：守护进程退出后第一次调用要等它起来。连续使用第二次起几乎无延迟。
- **`csc.exe` 依赖**：只在构建 shim 时需要；已经构建好的 shim 是独立 exe，不再依赖。
- **不处理浏览器扩展**：BrowserSkill 的 Chrome/Edge 扩展需你自行从商店安装，浏览器也不允许程序代装扩展。

## 许可证

MIT。见 [LICENSE](LICENSE)。

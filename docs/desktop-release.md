# OpenPrism Desktop 打包与发版指南

本文档说明如何把 OpenPrism 作为桌面应用（macOS / Windows）发版到 GitHub，并让用户在 Release 页面直接下载安装包。

## 1. 本地打包流程

在仓库根目录执行：

```bash
npm install
npm run desktop:dev
npm run desktop:build
npm run desktop:dist
```

说明：

- `desktop:dev`：本地联调（前端 + 后端 + Electron）。
- `desktop:build`：构建桌面目录包（不生成安装器）。
- `desktop:dist`：生成安装包（macOS: `.dmg/.zip`，Windows: `.exe` 等）。

## 2. GitHub 自动发版（推荐）

仓库已提供工作流：`.github/workflows/desktop-release.yml`。

### 2.1 PR 合并后自动预发布（无需手动打 tag）

当代码合并到 `main`（包括 PR merge）后，工作流会自动触发并发布一个 pre-release：

- tag 形如：`main-<short_sha>`
- release 名称：`OpenPrism Desktop main-<short_sha>`
- 用途：团队快速验收、内测下载

### 2.2 手动 tag 正式发布（推荐对外版本）

触发方式：

1. 提交并推送代码到主分支。
2. 创建并推送语义化版本 tag（例如 `v0.1.0`）。

```bash
git tag v0.1.0
git push origin v0.1.0
```

工作流会自动：

1. 在 macOS runner 构建桌面安装包。
2. 在 Windows runner 构建桌面安装包。
3. 创建/更新同名 GitHub Release。
4. 上传安装包资产到 Release 页面。

## 3. 用户如何下载

发版成功后，用户可直接在：

- `https://github.com/<你的组织或用户名>/<你的仓库名>/releases`

下载对应资产，例如：

- macOS: `*.dmg`, `*.zip`
- Windows: `*.exe`

## 4. 关于签名与系统告警

默认情况下，安装包可能是“未签名”状态：

- macOS 可能出现 Gatekeeper 警告。
- Windows 可能出现 SmartScreen 警告。

这不影响测试分发，但正式对外建议增加代码签名与 notarization（苹果公证）。

## 5. 可选：发布前检查清单

1. `npm run build` 通过。
2. `npm run desktop:dist` 在本地至少跑通一个平台。
3. 核对 Release Notes（版本号、更新点、已知限制）。
4. 确认桌面端依赖说明（LaTeX / Python）已更新到 README。

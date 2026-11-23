# dsh-dispatch-board —— 任务看板 + 工作区组长模式

[![npm](https://img.shields.io/npm/v/dsh-dispatch-board)](https://www.npmjs.com/package/dsh-dispatch-board) [![CI](https://github.com/duanxiangchun/dsh-dispatch-board/actions/workflows/ci.yml/badge.svg)](https://github.com/duanxiangchun/dsh-dispatch-board/actions/workflows/ci.yml)

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）用的任务看板插件：**你只和主会话说话，活由工作区组长派给 worker 干**。看板是唯一事实源与汇报通道。

> 包名 `dsh-dispatch-board`（npm / GitHub 同名）；内部运行时标识仍是 `taskboard`（存储目录 `~/.dsh/storages/dsh-taskboard/`、RPC 路由 `/taskboard`、预设 id `taskboard-*`、工具 `taskboard_*`），老安装与已有看板数据不受影响。

## 工作方式（默认：工作区组长模式）

1. **绑定主会话**：用平时对话的普通会话打开看板，在组长条点「把当前对话设为主会话」。之后加任务、看进度、收完成回执都归它。
2. **加任务**：右栏看板加本工作区任务；左侧「任务看板」可加任意工作区任务（也可直接对主会话说「把 XX 加进看板」）。
3. **自动派发**：插件每 15s 扫「待开始」，交给该工作区的常驻组长；组长置「进行中」并派 worker 后台执行（大任务可拆成写域不相交的切片并行）。一个工作区只有一个组长，不会每个任务新建会话。
4. **审核 + 回执**：worker 完成后组长取证审核；通过则置「已完成」并写结论，主会话空闲时收到合并回执；不通过就打回同一个 worker 重做。
5. **归档**：你点「归档」或「全部归档」；已归档任务不再参与轮询。

Git 仓库内默认开启 Worktree 隔离：并行 worker 在独立工作树执行、依赖自动软链；合入主工作区时逐文件三方合并，**绝不覆盖或删除未提交改动**，冲突文件保持原样交组长处理。

## 安装

```powershell
dsh plugin --profile web add dsh-dispatch-board            # npm
# 本地包：dsh plugin --profile web add C:\path\to\dsh-taskboard
```

重启 `dsh web` 并刷新页面：左侧栏出现「任务看板」，会话 header 右侧出现看板按钮。卸载用 `dsh plugin --profile web remove dsh-dispatch-board`。

需要 **dsh ≥ 0.2.2-rc.1**。两个模式（`taskboard-dispatch` 组长 / `taskboard-worker` 执行者）随包内 `presets/taskboard.patch.yml` 声明，无需写盘或额外安装；默认模式下组长自动创建，通常不用手动选。

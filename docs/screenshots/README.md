# 截图

这个目录放插件市场用的真实界面截图。

当前已有 `01-press.png`、`02-questions.png`、`03-card.png`、`04-panel.png`、`05-settings.png`，全部来自真实 DSH 窗口，使用 `seed.js` 演示数据拍摄、拍完已恢复原 `~/.nitui`。`06-recall.png` 可选，暂未拍。

## 拍什么

| 文件名 | 画面 |
| --- | --- |
| `01-press.png` | 对话输入框左上角的「压一下」按钮（已拍） |
| `02-questions.png` | 三问卡片（已拍：未填写状态） |
| `03-card.png` | 验尸卡：失败场景、死因、每条死因的检验动作、倾向（已拍） |
| `04-panel.png` | 「我的推演」列表，含状态标签、域筛选和排序（已拍） |
| `05-settings.png` | 「我记录了什么」：选择记录、召回门槛、导出/清除（已拍） |
| `06-recall.png` | 对话底部的「旧账」召回条（可选，未拍） |

建议 1440×900 或更高，PNG 或 JPG，单张控制在 300 KB 以内。

## 怎么拍

1. 用演示数据启动，避免把真实记录拍进去：

   ```sh
   node seed.js --force
   ```

   插件在源码目录里运行时会优先使用仓库内 `data/`（前提是它已经存在）。
   如果宿主读的仍是 `~/.nitui`，改用环境变量把数据指到演示目录：

   ```powershell
   $env:DSH_NITUI_DATA = 'D:\tmp\nitui-demo'
   node seed.js --dir D:\tmp\nitui-demo --force
   ```

   **不要直接对 `~/.nitui` 跑 `seed.js`**：那会覆盖真实记录。确实要让正在运行的宿主读演示数据时，先把整个 `~/.nitui` 复制备份，拍完再原样恢复。

2. 重启或刷新 DSH，打开对话页和「我的推演」。
3. 按上表逐张截图，存进本目录。
4. 更新插件根目录的 `screenshots.json`，按市场展示顺序列出路径（当前文件就是这样排的）：

   ```json
   [
     "docs/screenshots/03-card.png",
     "docs/screenshots/02-questions.png",
     "docs/screenshots/04-panel.png",
     "docs/screenshots/05-settings.png",
     "docs/screenshots/01-press.png"
   ]
   ```

5. README 顶部已经引用了更有代表性的验尸卡：

   ```markdown
   ![逆推卡](docs/screenshots/03-card.png)
   ```

6. 拍完把 `~/.nitui` 从备份原样复制回去，并核对文件大小/哈希。

## 注意

- 演示数据是虚构的；不要截真实的选择记录、人名、公司名或金额。
- 截图里如果出现模型名或 provider，确认它不包含私有信息。
- 拍完后把临时数据目录删掉：`Remove-Item -Recurse -Force D:\tmp\nitui-demo`。

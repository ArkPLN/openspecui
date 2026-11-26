## ADDED Requirements

### Requirement: 主规范作者、贡献者与功能点增删清单展示
The system SHALL lazily fetch and display the creator, deduplicated contributor summary, and reverse-chronological evolution list inside the `Specs 规范库` detail panel when a user selects a main spec, explicitly listing added, modified, renamed, and removed `Requirement` titles for each revision and visually highlighting removed capabilities.

#### Scenario: 选中主规范后懒加载贡献者与演进清单
- **WHEN** 用户在 `Specs 规范库` 中点击左侧任意主规范条目
- **THEN** 界面保持主规范 Markdown 正文即时渲染，同时按需请求该规范的历史分析接口，在详情头部展示创建者与去重贡献者统计标签，并在演进记录区按时间倒序列出每次提交的作者、时间与操作摘要

#### Scenario: 展开单次提交查看功能点增删明细并警示移除
- **WHEN** 某次提交包含新增、修改、重命名或移除 `Requirement` 操作
- **THEN** 界面在对应提交记录中明确列出具体的 `Requirement` 标题清单（如 `+ 追加`、`~ 修改`、`> 重命名 (旧 -> 新)`、`- 移除`），其中存在移除以前功能点的记录以醒目警示样式标识

#### Scenario: 无 Git 历史或非 Git 目录的界面降级提示
- **WHEN** 所选主规范所在仓库未初始化 Git 或当前文件尚无提交记录
- **THEN** 详情面板在贡献者区域显示清晰的中性降级提示（如“当前目录非 Git 仓库，暂无作者与演进历史”），不影响 Markdown 规范正文阅读

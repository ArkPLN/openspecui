## ADDED Requirements

### Requirement: 非 ASCII 与含引号 Git 文件路径 UTF-8 还原
The system SHALL disable Git octal path quoting (`core.quotePath=false`) during repository inspection and SHALL decode C-style quoted/octal-escaped file paths across Git status, Diff output, and file-level commit history so that non-ASCII (such as Chinese) and space-containing paths display as their original UTF-8 relative paths.

#### Scenario: 查看含中文目录与中文文件名的 Commit 或工作区 Diff
- **WHEN** 某次提交或工作区改动包含非 ASCII 路径（例如 `sql/2026/20260922理论课堂/20261125线下收款登记权限补齐.sql`）
- **THEN** 系统返回解码后的原始 UTF-8 相对路径 `sql/2026/20260922理论课堂/20261125线下收款登记权限补齐.sql` 作为文件条目标题，且 Diff 头部不显示八进制转义乱码或多余的双引号 `a/`、`b/` 前缀

#### Scenario: 兼容含空格、特殊字符及旧式八进制转义的 Diff 与状态行
- **WHEN** Git 状态输出、带引号的重命名 Diff 头（如 `"a/old name.md" "b/新 文件.md"`）或单边引号 Diff 头中出现双引号或 C 风格八进制字节序列（`\NNN`）
- **THEN** 系统正确拆解左右路径、还原 UTF-8 字符并去除 `a/`、`b/` 前缀与外层引号，同时保持路径遍历安全校验对还原后路径的有效性

# 仓库级 OMP Skills

本仓库通过 `.omp/config.yml` 的 `skills.customDirectories` 读取仓库内 `meta/References/Skills/mattpocock` 子模块中的 Matt Pocock Skills，不修改 OMP 的用户级 Skill 配置。

## 当前生效行为

- OMP 只在本仓库工作目录下读取 `.omp/config.yml`。
- 配置指向 `meta/References/Skills/mattpocock/skills` 下的四个分类目录：`engineering`、`productivity`、`misc`、`in-progress`。
- OMP 对每个 custom directory 扫描一层 `*/SKILL.md`，因此不能只配置 `.../skills/mattpocock` 或 `.../skills/mattpocock/skills`。
- Skill 文件保留在仓库的 `meta/References/` 子模块中，不会复制到本仓库其他位置，也不会写入 OMP 全局 Skill 目录。

## 约束与验证入口

- 该配置使用仓库相对路径；需要先初始化 `meta/References/Skills/mattpocock` 子模块，否则这些目录不存在时不会加载对应 Skills。
- 启动 OMP 后可用 `omp skill list --json` 查看加载结果；用 `omp config get skills.customDirectories --json` 查看当前项目解析到的目录。
- 修改子模块中的 Skill 后，重新启动 OMP 会话；当前会话的 Skill 列表是启动时发现的快照。

---
name: github-npm-release
description: 为本项目执行统一版本发布：同步 package.json、package-lock.json、Git tag、GitHub Release 与 npm 版本。用户要求发版、打 tag、创建 GitHub Release 或发布 npm 时使用。
---

# GitHub + npm 发布

本 skill 只负责本项目的版本发布流程，目标是让同一个 SemVer 版本同时出现在源码、npm 和 GitHub。

## 项目固定信息

- npm 包：`@jiawei666/wecode`
- npm 公共 registry：`https://registry.npmjs.org/`
- npm 包已经配置 `publishConfig.access=public`；发布时仍显式传入 `--access public`。
- 运行要求：Node.js 22+。
- 发布前必须检查 `npm pack --dry-run`，避免把凭证、日志或本地文件打进包。

## 版本不变量

发布版本 `X.Y.Z` 必须同时满足：

- `package.json` 的 `version` 是 `X.Y.Z`。
- `package-lock.json` 根包的 `version` 也是 `X.Y.Z`。
- Git 提交包含版本和本次发布需要的代码、测试、README 变更。
- Git tag 是 `vX.Y.Z`，GitHub Release 也使用 `vX.Y.Z`。
- npm 上发布的版本是 `X.Y.Z`，且不能复用已经存在的版本号。

`package.json` 是版本来源。优先使用 `npm version <version> --no-git-tag-version` 同步两个 npm 文件；如果用户已经改好版本号，先验证两者一致，不要重复改动。

## 发布前检查

只有用户明确要求“发布/推送版本”时才执行外部写入。仅询问流程、查看版本或做预检时，不创建 tag、不发布 npm、不创建 GitHub Release。

1. 查看工作区、分支和远端，识别并保留用户已有的无关修改：

   ```bash
   git status --short
   git branch --show-current
   git remote -v
   ```

   不使用 `git reset --hard`、`git checkout --` 或未经检查的 `git add -A`。提交前逐项审阅待提交文件。

2. 确认包名、版本和发布配置：

   ```bash
   npm pkg get name version publishConfig
   ```

3. 确认 npm 登录的是公共 registry：

   ```bash
   npm whoami --registry=https://registry.npmjs.org/
   ```

   未登录时提示用户自行执行 `npm login --registry=https://registry.npmjs.org/`。不要读取、索要、打印或写入 npm token；2FA/OTP 由用户在终端或浏览器中完成。

4. 检查目标版本没有被占用，并确认版本符合 SemVer。若目标版本已存在，不能覆盖或再次发布，必须选择下一个版本。

5. 根据变更选择版本：修复或文档用 patch，向后兼容的新能力用 minor，破坏性变更用 major。用户没有明确版本且变更级别有歧义时，在外部写入前询问用户。

## 标准发布流程

按以下顺序执行：

1. 更新版本。若需要更新版本：

   ```bash
   npm version X.Y.Z --no-git-tag-version
   ```

   然后确认 `package.json` 和 `package-lock.json` 的根版本完全相同。

2. 更新 README、测试或发布说明，使其描述当前版本实际行为。至少执行：

   ```bash
   npm test
   npm run lint
   npm run build
   npm run pack:check
   git diff --check
   ```

   任一步失败都停止发布，先修复或向用户报告；不要用跳过检查的方式继续。

3. 审阅 npm 包内容和 Git diff。只将本次发布相关的文件加入提交，提交信息使用：

   ```text
   chore: release vX.Y.Z
   ```

4. 创建并推送统一 tag：

   ```bash
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin HEAD
   git push origin vX.Y.Z
   ```

   如果 tag 已存在，先核对它是否指向本次发布提交；禁止强制移动已发布 tag。

5. 发布 npm：

   ```bash
   npm publish --access public --registry=https://registry.npmjs.org/
   ```

   当前项目的 `prepublishOnly` 会运行测试和 lint，`prepare` 会重新构建；仍然保留发布前的显式检查，便于尽早发现问题。

6. 创建 GitHub Release。优先使用已认证的 GitHub CLI：

   ```bash
   gh release create vX.Y.Z --title "vX.Y.Z" --generate-notes
   ```

   若 `gh` 未安装或未登录，保留已推送的 tag，不创建第二个版本；向用户说明需要完成 GitHub 认证后再创建 Release。

## 发布后验证

```bash
npm view @jiawei666/wecode version --registry=https://registry.npmjs.org/
git ls-remote --tags origin vX.Y.Z
git status --short
```

如果使用 `gh` 创建了 Release，再执行 `gh release view vX.Y.Z` 确认。最终报告应包含 npm 版本、Git tag、GitHub Release 地址和验证结果。

## 失败处理

- npm 认证失败：停止并让用户重新登录或完成 2FA，不要改版本号重试。
- npm 提示版本已存在：停止，不覆盖；核对远端版本后选择新的 SemVer。
- tag 已推送但 npm 发布失败：修复认证或构建问题后继续发布同一版本，不要新建版本。
- npm 已发布但 GitHub Release 创建失败：使用同一个已存在的 tag 补建 Release，不要新建版本。
- `package.json` 与 `package-lock.json` 不一致：停止发布，先同步版本。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { normalizeWechatText, renderPageHtml, renderResponse, splitWechatText, PagePublisher } from '../src/render.js';

test('normalizes common Codex markdown for WeChat', () => {
  const result = normalizeWechatText('\u001b[32m# 结果\u001b[0m\n\n**完成**：[查看](https://example.com)');
  assert.equal(result, '# 结果\n\n**完成**：[查看](https://example.com)');
});

test('splits by readable blocks and keeps Unicode intact', () => {
  const input = `第一段：${'你好'.repeat(40)}\n\n第二段：${'世界'.repeat(40)}`;
  const chunks = splitWechatText(input, 60);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => Array.from(chunk).length <= 60));
  assert.equal(chunks.join('').replace(/\s/g, ''), normalizeWechatText(input).replace(/\s/g, ''));
});

test('keeps long code chunks fenced within the WeChat limit', () => {
  const input = `\`\`\`ts\n${'const value = "你好";\n'.repeat(30)}\`\`\``;
  const chunks = splitWechatText(input, 80);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => Array.from(chunk).length <= 80));
  assert.ok(chunks.every((chunk) => chunk.startsWith('```ts\n') && chunk.endsWith('\n```')));
});

test('automatically publishes a long repository report even without an explicit kind', async () => {
  let published = false;
  const pages = {
    publish: async (title: string) => {
      published = true;
      return { title, url: 'https://share.example.test/p/report' };
    },
  } as unknown as PagePublisher;
  const report = `# 仓库分析总结\n\n## 结论\n${'项目结构、代码质量、测试结果和风险建议。'.repeat(80)}`;
  const result = await renderResponse({ text: report, kind: 'plain' }, pages);
  assert.equal(published, true);
  assert.equal(result.mode, 'page');
});

test('embeds referenced local report files and returns a bare share URL', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechatbot-report-page-'));
  const reportPath = path.join(directory, 'PROJECT_SUMMARY.md');
  await writeFile(reportPath, '# 完整报告\n\n这里是报告正文。', 'utf8');
  let publishedTitle = '';
  let publishedMarkdown = '';
  const pages = {
    publish: async (title: string, markdown: string) => {
      publishedTitle = title;
      publishedMarkdown = markdown;
      return { title, url: 'https://share.example.test/p/report' };
    },
  } as unknown as PagePublisher;

  try {
    const result = await renderResponse({
      text: `已完成分析并生成报告：\n\n[主报告](${reportPath})`,
      kind: 'diff',
      cwd: directory,
    }, pages);
    assert.equal(publishedTitle, 'Codex 分析报告');
    assert.match(publishedMarkdown, /报告附件正文/);
    assert.match(publishedMarkdown, /这里是报告正文/);
    assert.equal(result.mode, 'page');
    assert.equal(result.fallback, 'https://share.example.test/p/report');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('renders a mobile report shell and removes unsafe markdown HTML and links', () => {
  const html = renderPageHtml('Codex 分析报告', '<script>alert(1)</script>\n\n[危险链接](javascript:alert(1))\n\n## 章节');
  assert.match(html, /class="page-shell"/);
  assert.match(html, /class="report-content markdown-body"/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /href="javascript:/i);
});

test('explains a missing tunnel when a page cannot be published', async () => {
  const pages = new PagePublisher({ ...loadConfig(), cloudflaredCommand: 'wechatbot-cloudflared-does-not-exist' });
  try {
    const result = await renderResponse({ text: `# 报告\n\n${'结论、风险和建议。'.repeat(120)}`, presentation: 'page' }, pages);
    assert.equal(result.mode, 'chat');
    assert.match(result.text, /cloudflared/);
  } finally {
    await pages.close();
  }
});

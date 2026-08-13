/**
 * 等价性验证: 证明"三个 stage 组合"与"旧 runMinimal"产出完全一致。
 *
 * 为什么不能只用 mock: MockLLMClient 的 dialogue_spans 永远为空(llm.ts:212),
 * 于是 span 抽取 / source grounding / 引号补抽 / 声线绑定 / TTS 切分全都不会执行。
 * 那些恰恰是最复杂、最容易在重构中改坏的部分。所以这里用 cassette 回放真实
 * LLM 响应, 既确定性又覆盖全路径。
 *
 * 用法:
 *   npm run verify:equivalence -- --record    首次: 用真实 LLM 跑并录制
 *   npm run verify:equivalence                之后: 离线回放并比对
 *
 * 判定: 两条路径的结果 JSON 必须逐字节相同(仅允许 llm_request_id 这类
 * 每次调用递增的计数器不同, 但它不在 result 里, 所以实际要求是严格相等)。
 */
import fs from 'node:fs';
import path from 'node:path';
import nextEnv from '@next/env';

nextEnv.loadEnvConfig(process.cwd());

const record = process.argv.includes('--record');
const FIXTURE_DIR = path.join(process.cwd(), 'fixtures');
const CASSETTE = path.join(FIXTURE_DIR, 'equivalence.cassette.json');
const BASELINE = path.join(FIXTURE_DIR, 'equivalence.baseline.json');

// 用真实小说文本(前两章), 比自造文本更能暴露真实的引号/标题形态
const SOURCE_TXT = path.join(process.cwd(), '..', 'test_txt', '医妃倾天下.txt');

const { PipelineRunner } = await import('../src/server/tts/runner.ts');
const { CassetteLLMClient } = await import('../src/server/tts/cassette.ts');
const { createLLMClient } = await import('../src/server/tts/llm.ts');
const { settings } = await import('../src/server/tts/config.ts');
const stages = await import('../src/server/tts/stages.ts');

function loadSample() {
  const full = fs.readFileSync(SOURCE_TXT, 'utf8');
  // 截到第 3 章之前, 控制 LLM 调用量
  const cut = full.indexOf('第3章');
  return cut > 0 ? full.slice(0, cut) : full;
}

function makeLlm() {
  if (record) {
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
    return new CassetteLLMClient(CASSETTE, 'record', createLLMClient(settings.llm));
  }
  return new CassetteLLMClient(CASSETTE, 'replay');
}

const text = loadSample();
const bookTitle = '医妃倾天下';
console.log(`样本: ${text.length} 字`);

// ---------------------------------------------------------------- 路径 A: runMinimal
console.log('\n[A] 运行旧路径 runMinimal ...');
const runnerA = new PipelineRunner(settings, undefined, undefined, makeLlm());
const resultA = await runnerA.runMinimal({ book_title: bookTitle, text });
console.log(`    章节 ${resultA.chapters.length}, spans ${countSpans(resultA)}, tts ${resultA.tts_segments.length}`);

// -------------------------------------------------- 路径 B: chapterize → chapter × N → aggregate
console.log('\n[B] 运行三 stage 组合 ...');
const llmB = makeLlm();
// 注意: llmOverride 必须一路传进 stage —— stage 内部会自建 PipelineRunner,
// 不传就会绕过 cassette 直连真实 LLM, 那样比对出来的"差异"全是模型随机性。
const chapterize = await stages.runChapterizeStage({ bookTitle, text }, settings, undefined, llmB);

// 逐章独立处理: processChapter 对单章自洽, 章节间无共享状态 ——
// 这正是能把"一次调用处理一章"作为任务粒度的前提。
const chapterResults = [];
for (const chapter of chapterize.chapters) {
  chapterResults.push(await stages.runChapterStage({ bookTitle, chapter }, settings, undefined, llmB));
}

// 模拟真实链路: 章节结果先转成 digest 存库, 聚合只读 digest
const digests = chapterResults.map((chapter) => stages.buildChapterDigest(chapter));
const aggregate = await stages.runAggregateStage({ bookTitle, chapters: digests }, settings, undefined, llmB);

const resultB = stages.assembleBookResult({
  bookTitle,
  settings,
  preprocessing: chapterize.preprocessing,
  chapterTitleDetection: chapterize.chapterTitleDetection,
  aggregate,
  chapters: digests,
});
console.log(`    章节 ${resultB.chapters.length}, spans ${countSpans(resultB)}, tts ${resultB.tts_segments.length}`);

// ---------------------------------------------------------------------- 比对
console.log('\n[比对]');
let failures = 0;

failures += compare('章节数', resultA.chapters.length, resultB.chapters.length);
failures += compare('aliases 数', resultA.aliases.length, resultB.aliases.length);
failures += compare('role_registry 数', resultA.role_registry.length, resultB.role_registry.length);
failures += compare('tts_segments 数', resultA.tts_segments.length, resultB.tts_segments.length);
failures += compare('span 总数', countSpans(resultA), countSpans(resultB));

// 全书级字段严格比对
for (const key of ['aliases', 'role_registry', 'tts_segments', 'tts_segment_summary', 'chapter_title_detection', 'preprocessing']) {
  failures += deepCompare(key, resultA[key], resultB[key]);
}

// 章节级: digest 是完整版的子集, 所以只比对 digest 保留的那些字段
for (let i = 0; i < resultA.chapters.length; i += 1) {
  const a = resultA.chapters[i];
  const b = resultB.chapters[i];
  const label = `chapters[${i}](${a.title || 'untitled'})`;
  failures += deepCompare(`${label}.aliases`, a.aliases, b.aliases);
  failures += deepCompare(`${label}.tts_segments`, a.tts_segments, b.tts_segments);
  failures += deepCompare(`${label}.tts_segment_summary`, a.tts_segment_summary, b.tts_segment_summary);
  const spansA = (a.chunks ?? []).flatMap((c) => c.final_grounded_dialogue_spans ?? []);
  const spansB = (b.chunks ?? []).flatMap((c) => c.final_grounded_dialogue_spans ?? []);
  failures += compare(`${label} span 数`, spansA.length, spansB.length);
  // span 逐字段比对(只比 digest 保留的字段, B 侧本就只有这些)
  for (let j = 0; j < Math.min(spansA.length, spansB.length); j += 1) {
    const subset = {};
    for (const k of Object.keys(spansB[j])) subset[k] = spansA[j][k];
    failures += deepCompare(`${label}.span[${j}]`, subset, spansB[j], true);
  }
}

if (record) {
  fs.writeFileSync(BASELINE, JSON.stringify(resultA, null, 2));
  console.log(`\n已录制基准: ${BASELINE}`);
} else if (fs.existsSync(BASELINE)) {
  const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  failures += deepCompare('runMinimal vs 已录制基准', baseline, resultA);
}

console.log(failures === 0 ? '\n✅ 等价性通过' : `\n❌ ${failures} 项不一致`);
process.exit(failures === 0 ? 0 : 1);

// ---------------------------------------------------------------------- helpers
function countSpans(result) {
  return (result.chapters ?? []).reduce(
    (sum, chapter) =>
      sum + (chapter.chunks ?? []).reduce((s, chunk) => s + (chunk.final_grounded_dialogue_spans ?? []).length, 0),
    0,
  );
}

function compare(label, a, b) {
  if (a === b) {
    console.log(`  ok   ${label}: ${a}`);
    return 0;
  }
  console.log(`  FAIL ${label}: A=${a} B=${b}`);
  return 1;
}

function deepCompare(label, a, b, quiet = false) {
  const sa = stableStringify(a);
  const sb = stableStringify(b);
  if (sa === sb) {
    if (!quiet) console.log(`  ok   ${label} (深度一致, ${sa.length} 字节)`);
    return 0;
  }
  console.log(`  FAIL ${label} 不一致`);
  const at = firstDiff(sa, sb);
  console.log(`       首个差异 @${at}`);
  console.log(`       A: ...${sa.slice(Math.max(0, at - 60), at + 120)}`);
  console.log(`       B: ...${sb.slice(Math.max(0, at - 60), at + 120)}`);
  return 1;
}

function stableStringify(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

function firstDiff(a, b) {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) if (a[i] !== b[i]) return i;
  return len;
}

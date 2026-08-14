import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTtsSegmentsForChapters,
  collapseFormattingNarrationSegments,
} from './runnerHelpers';

test('把连续对白之间的纯引号旁白吸收到相邻对白', () => {
  const text = '“你好。” “再见。”';
  const chapter = {
    chapter_id: 1,
    title: '测试',
    chunks: [{
      start: 0,
      text,
      final_grounded_dialogue_spans: [
        { start: 1, end: 4, speaker: '甲', status: 'match_exact' },
        { start: 7, end: 10, speaker: '乙', status: 'match_exact' },
      ],
    }],
  };

  const result = buildTtsSegmentsForChapters([chapter]);
  assert.deepEqual(
    result.segments.map((segment: Record<string, unknown>) => ({
      type: segment.type,
      start: segment.start,
      end: segment.end,
      text: segment.text,
    })),
    [
      { type: 'dialogue', start: 0, end: 6, text: '“你好。” ' },
      { type: 'dialogue', start: 6, end: 11, text: '“再见。”' },
    ],
  );
  assert.equal(result.summary.formatting_narration_segments_absorbed, 3);
  assert.equal(result.summary.coverage_ok, true);
});

test('保留含实际文字的旁白，只吸收对白两侧的引号', () => {
  const text = '他说：“你好。”然后走了。';
  const chapter = {
    chapter_id: 1,
    title: '测试',
    chunks: [{
      start: 0,
      text,
      final_grounded_dialogue_spans: [
        { start: 4, end: 7, speaker: '甲', status: 'match_exact' },
      ],
    }],
  };

  const result = buildTtsSegmentsForChapters([chapter]);
  assert.deepEqual(
    result.segments.map((segment: Record<string, unknown>) => ({ type: segment.type, text: segment.text })),
    [
      { type: 'narration', text: '他说：' },
      { type: 'dialogue', text: '“你好。”' },
      { type: 'narration', text: '然后走了。' },
    ],
  );
  assert.equal(result.summary.coverage_ok, true);
});

test('不删除没有相邻对白的纯格式旁白', () => {
  const result = collapseFormattingNarrationSegments([
    { type: 'narration', start: 0, end: 3, text: '“ ”', char_count: 3 },
  ]);
  assert.equal(result.absorbedCount, 0);
  assert.equal(result.segments.length, 1);
});

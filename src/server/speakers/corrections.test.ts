import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applySpeakerAssignments,
  findProjectRole,
  projectRoleKey,
  type SpeakerAssignment,
} from './corrections';

const role = {
  role_id: 'role_1',
  canonical_name: '萧炎',
  gender: 'male',
  voice_profile_id: 'voice_1',
  voice_profile: { description: '青年男声', gender: 'male' },
};

test('目标人物只能从当前小说 role_registry 中查找', () => {
  const bookResult = { role_registry: [role, { canonical_name: '无ID人物' }] };
  assert.equal(projectRoleKey(role), 'role_1');
  assert.equal(projectRoleKey({ canonical_name: '无ID人物' }), 'name:无ID人物');
  assert.equal(findProjectRole(bookResult, 'role_1')?.canonical_name, '萧炎');
  assert.equal(findProjectRole(bookResult, 'role_other'), null);
});

test('人工指派覆盖 tts segment 和对应 span，但不改原始输入', () => {
  const result = {
    tts_segments: [{
      segment_id: 'c001_s0001',
      type: 'dialogue',
      start: 4,
      end: 8,
      text: '你好。',
      speaker: 'unknown_speaker',
      role_id: '',
    }],
    chunks: [{
      chunk_id: 'chunk_1',
      final_grounded_dialogue_spans: [{
        start: 4,
        end: 8,
        text: '你好。',
        speaker: 'unknown_speaker',
      }],
    }],
  };
  const assignment: SpeakerAssignment = {
    id: 'assignment_1',
    project_id: 'project_1',
    chapter_id: 'chapter_1',
    segment_id: 'c001_s0001',
    segment_start: 4,
    segment_end: 8,
    segment_text: '你好。',
    original_speaker: 'unknown_speaker',
    original_role_id: '',
    target_role_key: 'role_1',
    target_role_snapshot: role,
    changed_by: 'user_1',
    created_at: '2026-08-14T00:00:00Z',
    updated_at: '2026-08-14T00:00:00Z',
  };

  const corrected = applySpeakerAssignments(result, [assignment])!;
  assert.equal(corrected.tts_segments[0].speaker, '萧炎');
  assert.equal(corrected.tts_segments[0].original_speaker, 'unknown_speaker');
  assert.equal(corrected.tts_segments[0].speaker_corrected, true);
  assert.equal(corrected.chunks[0].final_grounded_dialogue_spans[0].canonical_speaker, '萧炎');
  assert.equal(result.tts_segments[0].speaker, 'unknown_speaker');
});

test('segment id 改变后仍可按相同坐标和文本恢复指派', () => {
  const result = {
    tts_segments: [{
      segment_id: 'new_segment_id',
      type: 'dialogue',
      start: 4,
      end: 8,
      text: '你好。',
      speaker: 'unknown_speaker',
    }],
  };
  const assignment = {
    id: 'assignment_1',
    project_id: 'project_1',
    chapter_id: 'chapter_1',
    segment_id: 'old_segment_id',
    segment_start: 4,
    segment_end: 8,
    segment_text: '你好。',
    original_speaker: 'unknown_speaker',
    original_role_id: '',
    target_role_key: 'role_1',
    target_role_snapshot: role,
    changed_by: 'user_1',
    created_at: '2026-08-14T00:00:00Z',
    updated_at: '2026-08-14T00:00:00Z',
  } satisfies SpeakerAssignment;

  assert.equal(applySpeakerAssignments(result, [assignment])?.tts_segments[0].speaker, '萧炎');
});

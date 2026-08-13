'use client';

import { useState } from 'react';
import { api } from './api';
import { Alert } from './ui';

const CATEGORIES = [
  { key: 'split_quality', label: '章节拆分准确性' },
  { key: 'speaker_accuracy', label: '说话人识别' },
  { key: 'voice_profile', label: '声线描述' },
  { key: 'other', label: '其他' },
];

/** 反馈入口。用户选择主要问题，并可补充具体说明。 */
export function FeedbackCard({
  email, projectId, chapterId,
}: { email: string; projectId?: string; chapterId?: string }) {
  const [category, setCategory] = useState('');
  const [comment, setComment] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!category && !comment.trim()) {
      setError('请选择主要问题或填写补充说明');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.feedback({
        email,
        project_id: projectId,
        chapter_id: chapterId,
        category: category || undefined,
        comment: comment.trim() || undefined,
      });
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <section className="card feedback-card">
        <Alert kind="ok">感谢反馈!这会直接帮助我们改进拆分质量。</Alert>
      </section>
    );
  }

  return (
    <section className="card feedback-card">
      <div className="feedback-top">
        <div className="feedback-intro">
          <p className="eyebrow">Feedback</p>
          <h2>拆分反馈</h2>
        </div>

        <div className="field feedback-category">
          <label htmlFor="fbCategory">主要问题（可选）</label>
          <select id="fbCategory" value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="">不选</option>
            {CATEGORIES.map((item) => (
              <option key={item.key} value={item.key}>{item.label}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="feedback-fields">
        <div className="field feedback-comment">
          <label htmlFor="fbComment">补充说明（可选）</label>
          <textarea
            id="fbComment"
            rows={4}
            placeholder="例如：第 3 段的说话人应该是XXX"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
          />
        </div>

        {error && <Alert kind="error">{error}</Alert>}

        <button className="btn btn-primary" onClick={submit} disabled={busy}>
          {busy ? '提交中…' : '提交反馈'}
        </button>
      </div>
    </section>
  );
}

'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, getStoredEmail } from '@/src/client/api';
import { readTextFile } from '@/src/client/readTextFile';
import {
  ChapterBatchEditor,
  type ChapterDraft,
} from '@/src/client/ChapterBatchEditor';
import { Alert, BackLink } from '@/src/client/ui';

type Mode = 'whole_book' | 'per_chapter';

export default function NewProjectPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [mode, setMode] = useState<Mode>('whole_book');
  const [title, setTitle] = useState('');
  const [wholeText, setWholeText] = useState('');
  const [encoding, setEncoding] = useState('');
  const [chapters, setChapters] = useState<ChapterDraft[]>([
    { id: 'initial-chapter', title: '', text: '' },
  ]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const createRequestId = useRef('');

  useEffect(() => {
    const stored = getStoredEmail();
    if (!stored) router.replace('/');
    else setEmail(stored);
  }, [router]);

  const onPickWholeFile = async (file: File) => {
    const { text, encoding: enc } = await readTextFile(file);
    setWholeText(text);
    setEncoding(`${file.name} · ${enc} · ${text.length.toLocaleString()} 字`);
    if (!title) setTitle(file.name.replace(/\.txt$/i, ''));
  };

  const submit = async () => {
    setError(null);
    if (!title.trim()) return setError('请填写项目名称');
    setBusy(true);
    try {
      if (mode === 'whole_book') {
        if (!wholeText.trim()) throw new Error('请上传或粘贴小说全文');
        const { project_id } = await api.createWholeBook(email, title.trim(), wholeText);
        router.push(`/projects/${project_id}`);
      } else {
        const valid = chapters.filter((chapter) => chapter.text.trim());
        if (!valid.length) throw new Error('请至少提供一个章节的正文');
        if (!createRequestId.current) createRequestId.current = crypto.randomUUID();
        const { project_id } = await api.createPerChapter(
          email,
          title.trim(),
          valid.map((chapter) => ({
            title: chapter.title.trim() || undefined,
            text: chapter.text,
            client_file_name: chapter.clientFileName,
            source_encoding: chapter.sourceEncoding,
          })),
          createRequestId.current,
        );
        router.push(`/projects/${project_id}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <main className="page">
      <BackLink href="/">返回项目列表</BackLink>
      <div className="page-header">
        <div>
          <p className="eyebrow">Create project</p>
          <h1>新建项目</h1>
          <p className="sub">选择适合当前文本的上传方式，创建后即可查看实时处理进度。</p>
        </div>
      </div>

      {error && <Alert kind="error">{error}</Alert>}

      <section className="card upload-form">
        <div className="mode-tabs">
          <button
            type="button"
            className={`mode-tab ${mode === 'whole_book' ? 'active' : ''}`}
            onClick={() => setMode('whole_book')}
          >
            <div className="mode-index">01</div>
            <div className="mt">整本上传</div>
            <div className="md">上传完整小说 TXT，系统自动识别章节标题并拆分。</div>
          </button>
          <button
            type="button"
            className={`mode-tab ${mode === 'per_chapter' ? 'active' : ''}`}
            onClick={() => setMode('per_chapter')}
          >
            <div className="mode-index">02</div>
            <div className="mt">逐章上传</div>
            <div className="md">自己按章提供正文，不做任何标题拆分。适合已切好的文本。</div>
          </button>
        </div>

        <div className="upload-content">
          <div className="upload-fields">
            <div className="field">
              <label htmlFor="projectTitle">项目名称</label>
              <input
                id="projectTitle"
                type="text"
                placeholder="例如：医妃倾天下"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>

            {mode === 'whole_book' ? (
              <>
                <div className="field">
                  <label htmlFor="wholeFile">小说 TXT 文件</label>
                  <input
                    id="wholeFile"
                    type="file"
                    accept=".txt,text/plain"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void onPickWholeFile(file);
                    }}
                  />
                  <span className="help">{encoding || '自动识别编码（UTF-8 / GB18030 / UTF-16）'}</span>
                </div>
                <div className="field field-grow">
                  <label htmlFor="wholeText">或直接粘贴全文</label>
                  <textarea
                    id="wholeText"
                    rows={14}
                    placeholder={'第1章 标题\n正文…\n\n第2章 标题\n正文…'}
                    value={wholeText}
                    onChange={(event) => { setWholeText(event.target.value); setEncoding(''); }}
                  />
                  <span className="help">
                    {wholeText ? `${wholeText.length.toLocaleString()} 字` : '文件内容会自动显示在这里，也可以直接粘贴。'}
                  </span>
                </div>
              </>
            ) : (
              <ChapterBatchEditor chapters={chapters} onChange={setChapters} />
            )}
          </div>

          <aside className="upload-aside">
            <p className="eyebrow">Before upload</p>
            <h2>{mode === 'whole_book' ? '适合完整小说文件' : '适合已经切分的章节'}</h2>
            <ul>
              {mode === 'whole_book' ? (
                <>
                  <li>系统自动识别章节标题和边界</li>
                  <li>支持常见中文 TXT 编码</li>
                  <li>长篇处理会按章节逐步完成</li>
                </>
              ) : (
                <>
                  <li>一个文件对应一个章节</li>
                  <li>可以继续手动新增或修改章节</li>
                  <li>正文不会被再次拆章</li>
                </>
              )}
            </ul>
            <p className="upload-note">创建后可以关闭页面，稍后使用同一邮箱回来查看。</p>
          </aside>
        </div>

        <div className="form-actions">
          <span>当前账号：{email}</span>
          <button className="btn btn-primary" onClick={submit} disabled={busy}>
            {busy ? '创建中…' : '创建并开始处理'}
          </button>
        </div>
      </section>
    </main>
  );
}

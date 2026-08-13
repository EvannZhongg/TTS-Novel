'use client';

import { useRef, useState } from 'react';
import { readTextFile } from './readTextFile';

export interface ChapterDraft {
  id: string;
  title: string;
  text: string;
  clientFileName?: string;
  sourceEncoding?: string;
}

export function emptyChapterDraft(id = crypto.randomUUID()): ChapterDraft {
  return { id, title: '', text: '' };
}

interface Props {
  chapters: ChapterDraft[];
  onChange: (chapters: ChapterDraft[]) => void;
  startIndex?: number;
  compact?: boolean;
}

const fileSorter = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

export function ChapterBatchEditor({
  chapters,
  onChange,
  startIndex = 1,
  compact = false,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  const pickFiles = async (files: FileList) => {
    setReading(true);
    setFileError(null);
    try {
      const drafts: ChapterDraft[] = [];
      const sorted = Array.from(files).sort((a, b) => fileSorter.compare(a.name, b.name));
      for (const file of sorted) {
        const { text, encoding } = await readTextFile(file);
        drafts.push({
          id: crypto.randomUUID(),
          title: file.name.replace(/\.txt$/i, ''),
          text,
          clientFileName: file.name,
          sourceEncoding: encoding,
        });
      }
      const kept = chapters.filter((chapter) => chapter.text.trim() || chapter.title.trim());
      onChange([...kept, ...drafts]);
    } catch (error) {
      setFileError(error instanceof Error ? error.message : String(error));
    } finally {
      setReading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const update = (id: string, patch: Partial<ChapterDraft>) => {
    onChange(chapters.map((chapter) => chapter.id === id ? { ...chapter, ...patch } : chapter));
  };

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= chapters.length) return;
    const next = [...chapters];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  const valid = chapters.filter((chapter) => chapter.text.trim());

  return (
    <div className={`chapter-batch-editor ${compact ? 'compact' : ''}`}>
      <div className="field">
        <label htmlFor={compact ? 'appendChapterFiles' : 'chapterFiles'}>
          批量选择章节文件（每个文件一章）
        </label>
        <input
          ref={inputRef}
          id={compact ? 'appendChapterFiles' : 'chapterFiles'}
          type="file"
          accept=".txt,text/plain"
          multiple
          disabled={reading}
          onChange={(event) => {
            if (event.target.files?.length) void pickFiles(event.target.files);
          }}
        />
        <span className="help">
          {reading
            ? '正在读取文件…'
            : '按文件名中的数字自然排序；章节标题默认使用文件名，正文不会再次拆章。'}
        </span>
        {fileError && <span className="field-error">{fileError}</span>}
      </div>

      <div className="chapter-inputs">
        {chapters.map((chapter, index) => {
          const submittedBefore = chapters
            .slice(0, index)
            .filter((item) => item.text.trim())
            .length;
          const chapterIndex = startIndex + submittedBefore;
          return (
            <div className="chapter-input-row" key={chapter.id}>
              <span className="chapter-input-index">{String(chapterIndex).padStart(2, '0')}</span>
              <div className="chapter-input-fields">
                <input
                  type="text"
                  placeholder={`第${chapterIndex}章 名称（可选）`}
                  value={chapter.title}
                  onChange={(event) => update(chapter.id, { title: event.target.value })}
                />
                <textarea
                  rows={compact ? 4 : 5}
                  placeholder="章节正文…"
                  value={chapter.text}
                  onChange={(event) => update(chapter.id, {
                    text: event.target.value,
                    // 手动修改后文件元信息仍用于审计，但服务端会按实际正文重算 hash。
                  })}
                />
                <span className="chapter-draft-meta">
                  {chapter.clientFileName && <span>{chapter.clientFileName}</span>}
                  {chapter.sourceEncoding && <span>{chapter.sourceEncoding}</span>}
                  <span>{chapter.text.length.toLocaleString()} 字</span>
                </span>
              </div>
              <div className="chapter-row-actions">
                <button
                  type="button"
                  className="chapter-order-btn"
                  onClick={() => move(index, -1)}
                  disabled={index === 0}
                  aria-label={`上移第${chapterIndex}章`}
                  title="上移"
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="chapter-order-btn"
                  onClick={() => move(index, 1)}
                  disabled={index === chapters.length - 1}
                  aria-label={`下移第${chapterIndex}章`}
                  title="下移"
                >
                  ↓
                </button>
                {chapters.length > 1 && (
                  <button
                    type="button"
                    className="btn btn-ghost small rm"
                    onClick={() => onChange(chapters.filter((item) => item.id !== chapter.id))}
                    aria-label={`删除第${chapterIndex}章`}
                  >
                    删除
                  </button>
                )}
              </div>
            </div>
          );
        })}
        <button
          type="button"
          className="btn btn-ghost small add-chapter"
          onClick={() => onChange([...chapters, emptyChapterDraft()])}
        >
          + 添加章节
        </button>
      </div>

      {valid.length > 0 && (
        <div className="chapter-batch-preview">
          <div>
            <strong>本次将提交 {valid.length} 章</strong>
            <span>
              序号 #{startIndex}–#{startIndex + valid.length - 1}
              {' · '}
              {valid.reduce((sum, chapter) => sum + chapter.text.length, 0).toLocaleString()} 字
            </span>
          </div>
          <ol>
            {valid.map((chapter, index) => (
              <li key={chapter.id}>
                <span>#{startIndex + index}</span>
                <strong>{chapter.title.trim() || `第${startIndex + index}章`}</strong>
                <em>{chapter.text.length.toLocaleString()} 字</em>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

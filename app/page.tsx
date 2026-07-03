export default function Home() {
  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">TTS Pipeline · Next.js 单体应用</p>
          <h1>TTS Pipeline 全流程可视化</h1>
        </div>
        <div className="topbar-actions">
          <button id="healthBtn" className="btn btn-ghost">检查 API</button>
          <button id="importJsonBtn" className="btn btn-ghost">导入 JSON</button>
          <button id="openUploadBtn" className="btn btn-primary">上传 TXT</button>
          <input id="importJsonInput" type="file" accept=".json,application/json" hidden />
        </div>
      </header>

      <main className="layout">
        <aside className="sidebar card">
          <section className="control-section">
            <h2>输入</h2>
            <div className="book-title-row">
              <label htmlFor="bookTitleInput">书名</label>
              <input id="bookTitleInput" type="text" defaultValue="demo" />
            </div>
            <p className="hint">同源运行完整 pipeline：预处理 → LLM 章节判断 → 拆章/chunk → LLM 对白 span 抽取 → source grounding 定位。</p>
            <div id="jobIdDisplay" className="job-id-display empty">Job ID：无</div>
            <button id="runPipelineBtn" className="btn btn-primary wide">运行完整 Pipeline</button>
          </section>

          <section className="control-section">
            <h2>文件概览</h2>
            <dl className="stats-list" id="inputStats">
              <div><dt>文件</dt><dd>尚未上传</dd></div>
              <div><dt>字符数</dt><dd>0</dd></div>
              <div><dt>行数</dt><dd>0</dd></div>
            </dl>
          </section>

          <section className="control-section">
            <h2>结果概览</h2>
            <dl className="stats-list" id="resultStats">
              <div><dt>章节数</dt><dd>0</dd></div>
              <div><dt>Chunk 数</dt><dd>0</dd></div>
              <div><dt>Dialogue spans</dt><dd>0</dd></div>
              <div><dt>定位成功</dt><dd>0</dd></div>
            </dl>
          </section>

          <section className="control-section">
            <div className="section-heading-row">
              <h2>阶段</h2>
              <span id="currentJobBadge" className="mini-badge">无任务</span>
            </div>
            <ol className="pipeline-steps" id="pipelineSteps">
              <li className="active">TXT 上传/粘贴</li>
              <li>拆章前预处理</li>
              <li>章节标题候选识别</li>
              <li>章节拆分 / Chunk</li>
              <li>LLM Span 抽取</li>
              <li>Source Grounding 定位</li>
              <li>补抽 / 角色声线</li>
            </ol>
          </section>

          <section className="control-section runtime-section">
            <div className="section-heading-row">
              <h2>当前任务日志</h2>
              <span id="logCountBadge" className="mini-badge">0</span>
            </div>
            <div id="runtimeLogs" className="runtime-logs empty-state">尚未运行。</div>
          </section>
        </aside>

        <section className="workspace">
          <div id="statusBar" className="status-bar">请先上传 TXT，或在上传浮窗中粘贴文本。</div>

          <section className="comparison-grid">
            <article className="card panel source-panel">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">Source TXT</p>
                  <h2>原文可视化</h2>
                </div>
                <div className="legend">
                  <span><i className="dot candidate"></i>标题候选</span>
                  <span><i className="dot accepted"></i>真章节标题</span>
                  <span><i className="dot selected"></i>当前章节范围</span>
                  <span><i className="dot tts-narration"></i>TTS 旁白高亮</span>
                  <span><i className="dot span-all"></i>全部 dialogue spans</span>
                  <span><i className="dot span"></i>当前 span 定位</span>
                </div>
              </div>
              <div id="sourceVisualization" className="source-visualization empty-state">
                暂无文本。点击右上角「上传 TXT」。
              </div>
            </article>

            <article className="card panel result-panel">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">Pipeline Inspector</p>
                  <h2>章节 / Chunk / Span 定位</h2>
                  <p className="panel-subtitle">选择章节或 chunk 查看 LLM 抽取的 dialogue spans；点击 span 可在左侧原文定位。</p>
                </div>
                <button id="exportJsonBtn" className="btn btn-ghost small" disabled>导出 JSON</button>
              </div>
              <div id="resultVisualization" className="result-visualization empty-state">
                运行完整 Pipeline 后，这里会展示流程统计、章节/Chunk 导航、span 列表和定位状态。
              </div>
            </article>
          </section>

          <section className="card panel bottom-panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Validation & Roles</p>
                <h2>章节判断与角色别名</h2>
              </div>
              <div className="candidate-toolbar" role="tablist" aria-label="候选筛选">
                <button className="filter-chip active" data-filter="all">全部标题 <span id="countAll">0</span></button>
                <button className="filter-chip" data-filter="accepted">真章节 <span id="countAccepted">0</span></button>
                <button className="filter-chip" data-filter="rejected">非章节 <span id="countRejected">0</span></button>
              </div>
            </div>
            <div id="candidateTable" className="candidate-table empty-state">暂无结果。</div>
          </section>
        </section>
      </main>

      <div id="uploadModal" className="modal-backdrop" aria-hidden="true">
        <div className="modal" role="dialog" aria-modal="true" aria-labelledby="uploadTitle">
          <div className="modal-header">
            <div>
              <p className="eyebrow">Upload</p>
              <h2 id="uploadTitle">上传 / 粘贴 TXT</h2>
            </div>
            <button id="closeUploadBtn" className="icon-btn" aria-label="关闭">×</button>
          </div>

          <div id="dropZone" className="drop-zone">
            <input id="fileInput" type="file" accept=".txt,text/plain" />
            <div className="drop-zone-content">
              <strong>拖拽 TXT 文件到这里</strong>
              <span>或点击选择文件。也可以在下方直接粘贴文本。</span>
            </div>
          </div>

          <div className="encoding-row">
            <span className="auto-encoding-label">编码自动识别</span>
            <span id="fileNamePreview" className="file-name-preview">未选择文件</span>
          </div>

          <label className="paste-label" htmlFor="pasteTextarea">文本内容</label>
          <textarea id="pasteTextarea" placeholder={'在这里粘贴小说 TXT 内容，例如：\n第1章：转学生\n她说：你好。'}></textarea>

          <div className="modal-actions">
            <button id="loadSampleBtn" className="btn btn-ghost">填入示例</button>
            <button id="clearTextBtn" className="btn btn-ghost">清空</button>
            <button id="applyTextBtn" className="btn btn-primary">载入文本</button>
          </div>
        </div>
      </div>
    </div>
  );
}

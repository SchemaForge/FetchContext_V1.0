(() => {
  "use strict";

  // State
  const state = {
    isOpen: true,
    isFullscreen: false,
    isCollapsed: false,
    isAuthenticated: false,
    currentView: "fetch", // fetch | history | settings
    apiKey: "",
    error: null,
    loading: false,
    // prompt
    originalPrompt: "",
    enhancedPrompt: "",
    currentPrompt: null,
    // schemas
    schemas: [],
    selectedSchemas: [],
    contextSearchTerm: "",
    // history
    promptHistory: [],
    historyLoading: false,
    historySearch: "",
    // Q&A
    questions: [],
    submittedAnswers: [],
    submittingAnswers: false,
    // file contexts
    fileContexts: [],
    selectedFileExtracts: [],
    showContextSelection: false,
    showQuestions: false,
    showFileContext: false,
    copiedPrompt: false
  };

  const STORAGE_KEYS = {
    apiKey: "contextos_preview_api_key"
  };

  // Utils
  const el = (tag, opts = {}) => Object.assign(document.createElement(tag), opts);

  const formatDate = (dateString) => new Date(dateString).toLocaleDateString("en-US", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
  });

  const getStatusColor = (status) => {
    switch (status) {
      case "completed": return "status-completed";
      case "failed": return "status-failed";
      case "processing": return "status-processing";
      case "pending": return "status-pending";
      default: return "status-default";
    }
  };

  const getContextTypeColor = (type) => {
    switch (type) {
      case "business": return "badge-blue";
      case "role-specific": return "badge-green";
      case "project-specific": return "badge-purple";
      default: return "badge-gray";
    }
  };

  const generateAdditionalContext = () => {
    if (!state.selectedSchemas.length) return "";
    const selected = state.schemas.filter(s => state.selectedSchemas.includes(s.id));
    if (!selected.length) return "";
    const parts = [];
    selected.forEach(schema => {
      const p = [];
      p.push(`Business Name: ${schema.companyName}`);
      if (schema.targetAudience && schema.targetAudience.length) p.push(`Target Personas: ${schema.targetAudience.join(', ')}`);
      if (schema.type) p.push(`Context Type: ${schema.type}`);
      if (schema.keyGoals && schema.keyGoals.length) p.push(`Key Goals: ${schema.keyGoals.join(', ')}`);
      parts.push(p.join('; '));
    });
    return `\n\nADDITIONAL CONTEXT: ${parts.join(' | ')}`;
  };

  const generateQAContext = () => {
    if (!Array.isArray(state.submittedAnswers) || state.submittedAnswers.length === 0) return "";
    const qa = state.submittedAnswers
      .filter(qa => qa && typeof qa.answer === 'string' && qa.answer.trim() !== '')
      .map(qa => `Q: ${qa.question}\nA: ${qa.answer}`)
      .join('\n\n');
    return qa ? `\n\nQ&A CONTEXT:\n${qa}` : "";
  };

  const generateFileContext = () => {
    if (!state.selectedFileExtracts.length) return "";
    const extracts = state.selectedFileExtracts.join('\n\n');
    return extracts ? `\n\nSUPPLEMENTARY EXTRACTS:\n${extracts}` : "";
  };

  // API base helpers
  const API_BASE = "https://uycbruvaxgawpmdddqry.supabase.co";
  const apiUrl = (path) => {
    const p = String(path || "").replace(/^\/+/, "");
    return `${API_BASE}/${p}`;
  };

  const saveLocal = () => {
    try {
      if (state.apiKey) localStorage.setItem(STORAGE_KEYS.apiKey, state.apiKey);
    } catch (_) {}
  };

  const loadLocal = () => {
    try {
      const savedKey = localStorage.getItem(STORAGE_KEYS.apiKey) || "";
      state.apiKey = savedKey;
      state.isAuthenticated = !!savedKey;
    } catch (_) {}
  };

  // API functions
  const ensureConfigured = () => {
    const hasKey = !!(state.apiKey && state.apiKey.trim());
    const ok = hasKey;
    if (!ok) {
      state.isAuthenticated = false;
    }
    return ok;
  };

  const loadSchemas = async () => {
    if (!ensureConfigured()) return;
    state.loading = true; render();
    try {
      const res = await fetch(`${apiUrl('functions/v1/user-schemas-api')}?api_key=${encodeURIComponent(state.apiKey)}`, {
        method: "GET",
        headers: { "Accept": "application/json" },
        mode: "cors"
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to load schemas");
      }
      const data = await res.json();
      state.schemas = (data.schemas || []).filter(s => s.isPublished);
      state.error = null;
    } catch (e) {
      state.error = e instanceof Error ? e.message : "Failed to load schemas";
      if (String(state.error).includes("Invalid")) {
        state.isAuthenticated = false;
        state.apiKey = "";
        try { localStorage.removeItem(STORAGE_KEYS.apiKey); } catch(_){}}
    } finally {
      state.loading = false; render();
    }
  };

  const submitPrompt = async () => {
    if (!state.originalPrompt.trim()) { state.error = "Please enter a prompt"; render(); return; }
    if (!ensureConfigured()) { render(); return; }
    if (!state.selectedSchemas.length) { state.error = "Please select at least one context"; render(); return; }

    state.loading = true; state.error = null; state.currentPrompt = { status: 'pending' }; render();
    try {
      const payload = { prompt: state.originalPrompt.trim() };
      if (state.selectedSchemas.length) payload.schemaIds = state.selectedSchemas;

      const res = await fetch(`${apiUrl('functions/v1/submit-prompt')}?api_key=${encodeURIComponent(state.apiKey)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify(payload),
        mode: "cors"
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to submit prompt");
      }
      const data = await res.json();
      // Ensure immediate status visibility with prompt id
      state.currentPrompt = { id: data.prompt_id, status: 'pending' }; render();
      pollPromptStatus(data.prompt_id);
    } catch (e) {
      state.error = e instanceof Error ? e.message : "Failed to submit prompt";
      state.currentPrompt = null;
      state.loading = false; render();
    }
  };

  const pollPromptStatus = async (promptId) => {
    const maxAttempts = 30;
    let attempts = 0;
    const poll = async () => {
      try {
        const res = await fetch(`${apiUrl(`functions/v1/retrieve-prompts/${promptId}`)}?api_key=${encodeURIComponent(state.apiKey)}`, {
          method: "GET",
          headers: { "Accept": "application/json" },
          mode: "cors"
        });
        if (!res.ok) throw new Error("Failed to retrieve prompt");
        const prompt = await res.json();
        state.currentPrompt = prompt;

        if (prompt.context && Array.isArray(prompt.context)) {
          state.fileContexts = prompt.context.map((ctx, index) => ({
            id: `${prompt.id}_${index}`,
            source: ctx.source,
            content: ctx.content,
            selected: false
          }));
        } else {
          state.fileContexts = [];
        }

        if (prompt.status === "completed") {
          state.enhancedPrompt = prompt.enriched_prompt || "";
          if (Array.isArray(prompt.questions_answers) && prompt.questions_answers.length) {
            state.questions = prompt.questions_answers;
            state.showQuestions = true;
          }
          state.loading = false; render();
        } else if (attempts < maxAttempts) {
          attempts++;
          setTimeout(poll, 2000);
        } else {
          state.error = "Prompt processing timed out";
          state.loading = false; render();
        }
      } catch (_) {
        state.error = "Failed to retrieve prompt";
        state.loading = false; render();
      }
    };
    poll();
  };

  const submitAnswers = async () => {
    if (!state.currentPrompt || !state.currentPrompt.id) return;
    state.submittingAnswers = true; render();
    try {
      const res = await fetch(`${apiUrl(`functions/v1/respond-prompt/${state.currentPrompt.id}`)}?api_key=${encodeURIComponent(state.apiKey)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify(state.questions || []),
        mode: "cors"
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to submit answers");
      }
      state.showQuestions = false;
      state.submittedAnswers = Array.isArray(state.questions) ? [...state.questions] : [];
      state.error = null;
      // Re-poll for updated enhanced prompt
      pollPromptStatus(state.currentPrompt.id);
    } catch (e) {
      state.error = e instanceof Error ? e.message : "Failed to submit answers";
    } finally {
      state.submittingAnswers = false; render();
    }
  };


  const loadPromptHistory = async () => {
    if (!ensureConfigured()) { render(); return; }
    state.historyLoading = true; render();
    try {
      let url = `${apiUrl('functions/v1/retrieve-prompts')}?status=completed&api_key=${encodeURIComponent(state.apiKey)}`;
      if (state.historySearch && state.historySearch.trim()) url += `&search=${encodeURIComponent(state.historySearch.trim())}`;
      const res = await fetch(url, { method: "GET", headers: { "Accept": "application/json" }, mode: "cors" });
      if (!res.ok) throw new Error("Failed to load history");
      const data = await res.json();
      // Expecting an array of prompts
      state.promptHistory = Array.isArray(data) ? data : (Array.isArray(data.prompts) ? data.prompts : []);
    } catch (_) {
      state.promptHistory = [];
    } finally {
      state.historyLoading = false; render();
    }
  };

  // Clipboard
  const copyToClipboard = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      state.copiedPrompt = true; render();
      setTimeout(() => { state.copiedPrompt = false; render(); }, 2000);
    } catch (_) {
      state.error = "Failed to copy to clipboard"; render();
    }
  };

  // UI rendering
  let root, shadow, container;

  const ensureRoot = () => {
    if (document.getElementById("contextos-preview-root")) return;
    root = el("div", { id: "contextos-preview-root" });
    document.documentElement.appendChild(root);
    shadow = root.attachShadow({ mode: "open" });
    container = el("div");
    shadow.appendChild(styleEl());
    shadow.appendChild(container);
  };

  const styleEl = () => {
    const s = el("style");
    s.textContent = `
      :host, * { box-sizing: border-box; }
      .panel { position: fixed; top: 0; right: 0; bottom: 0; width: 480px; background: #fff; border-left: 1px solid #e5e7eb; box-shadow: -2px 0 10px rgba(0,0,0,0.08); display: flex; z-index: 2147483647; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, Helvetica Neue, Arial, "Apple Color Emoji", "Segoe UI Emoji"; }
      .panel.full { inset: 0; width: auto; border-left: none; }
      .panel.collapsed { width: 48px; }
      .panel.collapsed .main { display: none; }
      .ribbon { width: 48px; background: #f9fafb; border-right: 1px solid #e5e7eb; display: flex; flex-direction: column; padding: 8px; }
      .ribbon button { width: 32px; height: 32px; border-radius: 8px; border: none; background: transparent; color: #4b5563; cursor: pointer; margin-bottom: 6px; }
      .ribbon button.active { background: #2563eb; color: #fff; }
      .ribbon button:hover { background: #e5e7eb; }
      .main { flex: 1; display: flex; flex-direction: column; }
      .header { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; border-bottom: 1px solid #e5e7eb; }
      .header .title { display: flex; align-items: center; gap: 8px; font-weight: 600; color: #111827; font-size: 13px; }
      .header-btn { border: none; background: transparent; color: #9ca3af; cursor: pointer; padding: 4px; }
      .header-btn:hover { color: #4b5563; }
      .content { flex: 1; overflow: auto; }
      .section { padding: 12px; }
      .textarea { width: 100%; border: none; outline: none; resize: none; font-size: 13px; color: #111827; }
      .box { border: 1px solid #e5e7eb; border-radius: 8px; background: #fff; }
      .box-header { padding: 8px 12px; border-bottom: 1px solid #f3f4f6; background: #f9fafb; border-radius: 8px 8px 0 0; }
      .box-body { padding: 12px; }
      .row { display: flex; align-items: center; gap: 8px; }
      .grow { flex: 1; }
      .btn { display: inline-flex; align-items: center; justify-content: center; border: none; cursor: pointer; border-radius: 999px; font-weight: 600; font-size: 12px; }
      .btn-send { width: 24px; height: 24px; color: #fff; background: #111827; }
      .btn-send:disabled { background: #9ca3af; cursor: not-allowed; }
      .btn-pill { padding: 4px 8px; background: #f3f4f6; color: #374151; border-radius: 8px; }
      .btn-primary { padding: 6px 10px; background: #2563eb; color: #fff; border-radius: 8px; }
      .btn-outline { padding: 6px 10px; background: #fff; color: #374151; border: 1px solid #d1d5db; border-radius: 8px; }
      .tag { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 999px; font-size: 11px; border: 1px solid #e5e7eb; }
      .badge-blue { background: #dbeafe; color: #1e3a8a; border-color: #bfdbfe; }
      .badge-green { background: #dcfce7; color: #166534; border-color: #bbf7d0; }
      .badge-purple { background: #ede9fe; color: #5b21b6; border-color: #ddd6fe; }
      .badge-gray { background: #f3f4f6; color: #374151; border-color: #e5e7eb; }
      .status { display: inline-flex; padding: 2px 6px; border-radius: 999px; font-size: 11px; font-weight: 600; }
      .status-completed { color: #16a34a; background: #dcfce7; }
      .status-failed { color: #dc2626; background: #fee2e2; }
      .status-processing { color: #2563eb; background: #dbeafe; }
      .status-pending { color: #ca8a04; background: #fef3c7; }
      .status-default { color: #4b5563; background: #e5e7eb; }
      .muted { color: #6b7280; font-size: 12px; }
      .muted-sm { color: #6b7280; font-size: 11px; }
      .input { width: 100%; padding: 6px 8px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 12px; }
      .input:focus { outline: 2px solid #93c5fd; border-color: transparent; }
      .switch-row { display: flex; align-items: center; justify-content: space-between; }
      .divider { height: 1px; background: #e5e7eb; margin: 8px 0; }
      .code { white-space: pre-wrap; font-size: 12px; color: #111827; }
      .pill { padding: 2px 6px; background: #f3f4f6; border-radius: 999px; font-size: 11px; }
      .loading { animation: spin 1s linear infinite; display: inline-block; }
      @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      .hidden { display: none; }
      .reopen-btn { position: fixed; right: 20px; bottom: 20px; width: 48px; height: 48px; border-radius: 999px; border: none; background: #2563eb; color: #fff; cursor: pointer; box-shadow: 0 4px 12px rgba(0,0,0,0.2); display: flex; align-items: center; justify-content: center; font-size: 18px; z-index: 2147483647; }
      .reopen-btn:hover { background: #1d4ed8; }
    `;
    return s;
  };

  const icon = (name) => {
    // Minimal inline SVG icons by name
    const map = {
      x: '<svg width="16" height="16" viewBox="0 0 24 24"><path fill="currentColor" d="M18.3 5.71L12 12.01l-6.3-6.3-1.4 1.41 6.3 6.3-6.3 6.3 1.4 1.41 6.3-6.3 6.3 6.3 1.41-1.41-6.3-6.3 6.3-6.3z"/></svg>',
      settings: '<svg width="16" height="16" viewBox="0 0 24 24"><path fill="currentColor" d="M19.14,12.94a7.14,7.14,0,0,0,.05-1,7.14,7.14,0,0,0-.05-1l2.11-1.65a.5.5,0,0,0,.12-.64l-2-3.46a.5.5,0,0,0-.6-.22l-2.49,1a7.28,7.28,0,0,0-1.73-1L14.5,2.5a.5.5,0,0,0-.5-.5H10a.5.5,0,0,0-.5.5L9.46,4.93a7.28,7.28,0,0,0-1.73,1l-2.49-1a.5.5,0,0,0-.6.22l-2,3.46a.5.5,0,0,0,.12.64L4.9,10a7.14,7.14,0,0,0-.05,1,7.14,7.14,0,0,0,.05,1L2.79,13.65a.5.5,0,0,0-.12.64l2,3.46a.5.5,0,0,0,.6.22l2.49-1a7.28,7.28,0,0,0,1.73,1L9.5,21.5a.5.5,0,0,0,.5.5h4a.5.5,0,0,0,.5-.5l.04-2.43a7.28,7.28,0,0,0,1.73-1l2.49,1a.5.5,0,0,0,.6-.22l2-3.46a.5.5,0,0,0-.12-.64ZM12,15.5A3.5,3.5,0,1,1,15.5,12,3.5,3.5,0,0,1,12,15.5Z"/></svg>',
      history: '<svg width="16" height="16" viewBox="0 0 24 24"><path fill="currentColor" d="M13 3a9 9 0 1 0 9 9h-2a7 7 0 1 1-7-7v4l5-5-5-5v4Z"/></svg>',
      zap: '<svg width="16" height="16" viewBox="0 0 24 24"><path fill="currentColor" d="M13 2L3 14h7l-1 8 10-12h-7l1-8z"/></svg>',
      send: '<svg width="14" height="14" viewBox="0 0 24 24"><path fill="currentColor" d="M2 21l21-9L2 3v7l15 2-15 2v7z"/></svg>',
      copy: '<svg width="14" height="14" viewBox="0 0 24 24"><path fill="currentColor" d="M16 1H4a2 2 0 0 0-2 2v12h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"/></svg>',
      check: '<svg width="14" height="14" viewBox="0 0 24 24"><path fill="currentColor" d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>',
      refresh: '<svg class="loading" width="14" height="14" viewBox="0 0 24 24"><path fill="currentColor" d="M17.65 6.35A7.95 7.95 0 0 0 12 4V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 13.65-6.65z"/></svg>'
    };
    return map[name] || "";
  };

  // Render helpers
  const renderHeaderTitle = () => {
    if (state.currentView === "fetch") return "Fetch Context";
    if (state.currentView === "history") return "Context History";
    return "Settings";
  };

  const renderStatusBar = () => {
    if (!state.currentPrompt) return "";
    if (!(state.currentPrompt.status === "pending" || state.currentPrompt.status === "processing")) return "";
    return `
      <div class="box" style="margin:8px 12px 0 12px;">
        <div class="box-body row">
          <span class="loading" style="width:16px;height:16px;border:2px solid #9ca3af;border-top-color:transparent;border-radius:50%;"></span>
          <div class="grow">
            <div style="font-size:13px;color:#374151;font-weight:600;">
              ${state.currentPrompt.status === 'pending' ? 'Processing your prompt...' : 'Enhancing with context...'}
            </div>
            <div class="muted-sm">This may take a few moments</div>
          </div>
          <div class="status ${getStatusColor(state.currentPrompt.status)}">${state.currentPrompt.status}</div>
        </div>
      </div>`;
  };

  const renderFetchView = () => {
    if (!state.isAuthenticated) {
      return `
        <div class="section">
          <div style="text-align:center;padding:24px 0;">
            <div style="font-size:32px;color:#9ca3af;line-height:1;">🔑</div>
            <div style="font-size:16px;font-weight:600;margin-top:8px;color:#111827;">API Configuration Required</div>
            <div class="muted" style="margin-top:4px;">Enter your ContextOS API key</div>
          </div>
          <div style="margin-top:12px;">
            <label class="muted" style="display:block;margin-bottom:6px;">API Key</label>
            <input id="ctx-api-key" class="input" type="password" placeholder="Enter your API key" />
          </div>

          ${state.error ? `<div class="box" style="background:#fef2f2;border-color:#fecaca;margin-top:12px;"><div class="box-body" style="color:#991b1b;font-size:12px;">${state.error}</div></div>`: ""}
          <button id="ctx-connect" class="btn btn-primary" style="width:100%;margin-top:12px;">Connect</button>
        </div>`;
    }

    const selectedSchemas = state.schemas.filter(s => state.selectedSchemas.includes(s.id));
    const filteredSchemas = state.schemas.filter(s => {
      const q = state.contextSearchTerm.toLowerCase();
      return s.name.toLowerCase().includes(q) || s.companyName.toLowerCase().includes(q) || s.type.toLowerCase().includes(q);
    });

    return `
      <div class="section">
        <div class="box">
          <div class="box-body">
            <textarea id="ctx-original-prompt" class="textarea" rows="3" placeholder="Write a prompt to get started">${escapeHtml(state.originalPrompt)}</textarea>
          </div>
          <div class="box-body" style="border-top:1px solid #f3f4f6;background:#f9fafb;border-radius:0 0 8px 8px;">
            <div class="row">
              <button id="ctx-toggle-context" class="btn-pill" title="Add context">+</button>
              <div class="grow" id="ctx-selected-tags">
                ${selectedSchemas.map(s => `<span class="tag ${getContextTypeColor(s.type)}">${escapeHtml(s.name)} <button data-remove-schema="${s.id}" class="btn-pill" style="padding:0 6px;">x</button></span>`).join(' ')}
              </div>
              <button id="ctx-submit" class="btn btn-send" ${state.loading || !state.originalPrompt.trim() || !state.selectedSchemas.length ? 'disabled' : ''} title="Send">${icon('send')}</button>
            </div>
          </div>
        </div>

        ${state.showContextSelection ? `
          <div class="box" style="margin-top:12px;">
            <div class="box-header row" style="justify-content:space-between;">
              <div style="font-weight:600;color:#111827;font-size:13px;">Select Contexts</div>
              <button id="ctx-close-context" class="header-btn" title="Close">${icon('x')}</button>
            </div>
            <div class="box-body">
              <input id="ctx-context-search" class="input" placeholder="Search contexts..." value="${escapeAttr(state.contextSearchTerm)}" />
            </div>
            <div class="box-body" style="max-height:192px;overflow:auto;">
              ${state.loading && state.schemas.length === 0 ? `<div class="muted" style="text-align:center;">Loading contexts...</div>` :
                (filteredSchemas.length === 0 ? `<div class="muted" style="text-align:center;">${state.contextSearchTerm ? 'No contexts match your search' : 'No contexts available'}</div>` :
                  filteredSchemas.map(s => `
                    <button class="row" data-add-schema="${s.id}" style="width:100%;text-align:left;padding:8px;border-bottom:1px solid #f3f4f6;background:#fff;">
                      <div class="grow">
                        <div class="row" style="gap:8px;">
                          <div style="font-weight:600;color:#111827;font-size:13px;">${escapeHtml(s.name)}</div>
                          <span class="tag ${getContextTypeColor(s.type)}" style="padding:2px 6px;">${escapeHtml(s.type)}</span>
                        </div>
                        <div class="muted-sm">${escapeHtml(s.companyName)}</div>
                        <div class="muted-sm" style="margin-top:2px;">${escapeHtml(s.description || '')}</div>
                      </div>
                      ${state.selectedSchemas.includes(s.id) ? `<span class="status status-completed">Selected</span>` : ''}
                    </button>`).join('')
                )}
            </div>
          </div>` : ''}

        ${state.fileContexts.length ? `
          <div class="box" style="margin-top:12px;border-color:#bfdbfe;">
            <button id="ctx-filectx-toggle" class="box-body row" style="width:100%;justify-content:space-between;background:#eff6ff;">
              <div class="row" style="gap:6px;">
                <span>📄</span>
                <span class="muted" style="color:#1d4ed8;">File Context (${state.fileContexts.filter(c=>c.selected).length}/${state.fileContexts.length} selected)</span>
              </div>
              <span>${state.showFileContext ? '▴' : '▾'}</span>
            </button>
            ${state.showFileContext ? `
              <div class="box-body" style="max-height:256px;overflow:auto;padding-top:6px;">
                ${state.fileContexts.map(ctx => `
                  <div class="box" data-filectx="${ctx.id}" style="padding:8px;margin-bottom:8px;border-color:${ctx.selected ? '#93c5fd' : '#e5e7eb'};background:${ctx.selected ? '#eff6ff' : '#fff'};cursor:pointer;">
                    <div class="row" style="justify-content:space-between;margin-bottom:4px;">
                      <span class="muted" style="color:#1d4ed8;">${escapeHtml(ctx.source)}</span>
                      ${ctx.selected ? `<span class="status status-processing">${icon('check')} Selected</span>` : ''}
                    </div>
                    <div class="code">${escapeHtml(ctx.content)}</div>
                  </div>`).join('')}
                ${state.fileContexts.filter(c=>c.selected).length ? `<div class="muted" style="padding-top:4px;border-top:1px solid #e5e7eb;">${state.fileContexts.filter(c=>c.selected).length} extract(s) will be added to your enhanced prompt</div>` : ''}
              </div>` : ''}
          </div>` : ''}


        ${Array.isArray(state.questions) && state.questions.length ? `
          <div class="box" style="margin-top:12px;border-color:#fed7aa;">
            <button id="ctx-qa-toggle" class="box-body row" style="width:100%;justify-content:space-between;background:#fffbeb;">
              <div class="row" style="gap:6px;">
                <span>💬</span>
                <span class="muted" style="color:#9a3412;">${state.submittedAnswers && state.submittedAnswers.length ? 'Update Answers' : 'Additional Questions'} (${state.questions.length})</span>
              </div>
              <span>${state.showQuestions ? '▴' : '▾'}</span>
            </button>
            ${state.showQuestions ? `
              <div class="box-body" style="padding-top:6px;">
                ${state.questions.map((q, idx) => `
                  <div style="margin-bottom:8px;">
                    <label class="muted" style="display:block;margin-bottom:4px;color:#111827;">${escapeHtml(q.question)}</label>
                    <textarea class="input" data-qa-index="${idx}" rows="2" placeholder="${state.submittedAnswers && state.submittedAnswers.length ? 'Update your answer...' : 'Enter your answer...'}">${escapeHtml(q.answer || '')}</textarea>
                  </div>`).join('')}
                <div class="row" style="gap:8px;">
                  <button id="ctx-qa-submit" class="btn btn-primary grow" ${state.submittingAnswers ? 'disabled' : ''}>${state.submittingAnswers ? 'Submitting...' : (state.submittedAnswers && state.submittedAnswers.length ? 'Update' : 'Submit')}</button>
                  <button id="ctx-qa-skip" class="btn btn-outline">${state.submittedAnswers && state.submittedAnswers.length ? 'Cancel' : 'Skip'}</button>
                </div>
              </div>` : ''}
          </div>` : ''}


        ${state.error ? `<div class="box" style="background:#fef2f2;border-color:#fecaca;margin-top:12px;"><div class="box-body" style="color:#991b1b;font-size:12px;">${state.error}</div></div>`: ""}
      </div>`;
  };

  const renderHistoryView = () => {
    return `
      <div class="section" style="display:flex;flex-direction:column;height:100%">
        <div class="box" style="display:flex;flex-direction:column;flex:1;">
          <div class="box-header" style="background:#fff;border-radius:8px 8px 0 0;">
            <div class="row" style="justify-content:space-between;">
              <button id="ctx-history-refresh" class="header-btn" ${state.historyLoading ? 'disabled' : ''} title="Refresh">${icon('refresh')}</button>
              <div class="grow" style="margin-left:8px;"><input id="ctx-history-search" class="input" placeholder="Search prompts..." value="${escapeAttr(state.historySearch)}" /></div>
            </div>
          </div>
          <div class="box-body" style="flex:1;overflow:auto;">
            ${state.historyLoading ? `<div style="text-align:center;" class="muted-sm">Loading history...</div>` :
              (state.promptHistory.length === 0 ? `<div style="text-align:center;" class="muted-sm">${state.historySearch ? 'No prompts match your filters' : 'No prompt history yet'}</div>` :
                state.promptHistory.map(p => `
                  <button class="row" data-history-id="${p.id}" style="align-items:flex-start;width:100%;text-align:left;padding:8px;border-bottom:1px solid #e5e7eb;background:#fff;">
                    <div class="grow">
                      <div style="font-size:12px;font-weight:600;color:#111827;margin-bottom:4px;">${escapeHtml(p.original_prompt)}</div>
                      <div class="row" style="gap:8px;">
                        <span class="status ${getStatusColor(p.status)}">${p.status}</span>
                        <span class="muted-sm">🕒 ${formatDate(p.created_at)}</span>
                      </div>
                      ${p.enriched_prompt ? `<div class="muted-sm" style="margin-top:4px;">Enhanced: ${escapeHtml((p.enriched_prompt || '').slice(0, 100))}...</div>` : ''}
                    </div>
                  </button>`).join('')
              )}
          </div>
        </div>
      </div>`;
  };

  const renderSettingsView = () => {
    return `
      <div class="section">
        <div style="margin-top:12px;">
          <label class="muted" style="display:block;margin-bottom:6px;">API Key</label>
          <input id="ctx-settings-apikey" class="input" type="password" placeholder="Enter your API key" value="${escapeAttr(state.apiKey)}" />
          <div class="muted-sm" style="margin-top:4px;">Your settings are stored locally in your browser</div>
        </div>

        ${state.error ? `<div class="box" style="background:#fef2f2;border-color:#fecaca;margin-top:12px;"><div class="box-body" style="color:#991b1b;font-size:12px;">${state.error}</div></div>`: ""}
        <div class="row" style="gap:8px;margin-top:12px;">
          <button id="ctx-settings-cancel" class="btn btn-outline grow">Cancel</button>
          <button id="ctx-settings-save" class="btn btn-primary grow">Save</button>
        </div>
        ${state.isAuthenticated ? `<div class="divider" style="margin-top:16px;"></div>
          <button id="ctx-disconnect" class="btn" style="color:#dc2626;width:100%;">Disconnect API Key</button>` : ''}
      </div>`;
  };

  const renderFooter = () => {
    if (!state.isAuthenticated || !state.enhancedPrompt || state.currentView !== "fetch") return "";
    const composite = state.enhancedPrompt + generateAdditionalContext() + generateFileContext() + generateQAContext();
    return `
      <div class="box" style="margin:0 12px 12px 12px;background:#f9fafb;border-top:1px solid #e5e7eb;">
        <div class="box-body row" style="justify-content:space-between;padding-bottom:8px;">
          <label style="font-weight:600;color:#374151;font-size:13px;">Enhanced Prompt</label>
          <button id="ctx-copy" class="row" style="gap:6px;color:${state.copiedPrompt ? '#16a34a' : '#2563eb'};background:transparent;">
            ${state.copiedPrompt ? icon('check') + '<span class="muted-sm" style="color:#16a34a;">Copied!</span>' : icon('copy') + '<span class="muted-sm">Copy</span>'}
          </button>
        </div>
        <div class="box-body" style="max-height:160px;overflow:auto;background:#fff;border-radius:8px;">
          <div class="code">${escapeHtml(composite)}</div>
        </div>
      </div>`;
  };

  const renderMain = () => {
    const header = `
      <div class="header">
        <div class="title">${state.currentView === 'fetch' ? '⚡' : state.currentView === 'history' ? '🕘' : '⚙️'} ${renderHeaderTitle()}</div>
        <div class="actions">
          ${state.isAuthenticated && state.currentView === 'fetch' ? `<button id="ctx-new" class="btn btn-primary">+ NEW</button>` : ''}
          ${state.currentView !== 'fetch' ? `<button id="ctx-collapse" title="${state.isCollapsed ? 'Expand' : 'Collapse'}" class="header-btn">${state.isCollapsed ? '⟩' : '⟨'}</button>` : ''}
          <button id="ctx-fullscreen" title="Toggle fullscreen" class="header-btn">${state.isFullscreen ? '⤢' : '⤡'}</button>
          <button id="ctx-close" title="Close" class="header-btn">${icon('x')}</button>
        </div>
      </div>`;

    const status = renderStatusBar();
    const content = `
      <div class="content">
        ${state.currentView === 'settings' ? renderSettingsView() : state.currentView === 'history' ? renderHistoryView() : renderFetchView()}
      </div>`;

    const footer = renderFooter();

    const ribbon = `
      <div class="ribbon">
        <button id="ctx-collapse-toggle" title="${state.isCollapsed ? 'Expand' : 'Collapse'}">${state.isCollapsed ? '⟨' : '⟩'}</button>
        <button id="ctx-nav-fetch" class="${state.currentView === 'fetch' ? 'active' : ''}" title="Fetch">⚡</button>
        ${state.isAuthenticated ? `<button id="ctx-nav-history" class="${state.currentView === 'history' ? 'active' : ''}" title="History">🕘</button>` : ''}
        <button id="ctx-nav-settings" class="${state.currentView === 'settings' ? 'active' : ''}" title="Settings">⚙️</button>
      </div>`;

    const wrapperCls = `panel ${state.isFullscreen ? 'full' : ''} ${state.isCollapsed ? 'collapsed' : ''}`.trim();
    const reopenBtn = state.isOpen ? '' : `<button id="ctx-reopen" class="reopen-btn" title="Open">⚡</button>`;
    container.innerHTML = `<div class="${wrapperCls}"${state.isOpen ? '' : ' style="display:none;"'}>${ribbon}<div class="main">${header}${status}${content}${footer}</div></div>${reopenBtn}`;

    bindEvents();
  };

  // Event binding
  const bindEvents = () => {
    // Header
    byId('ctx-close', false)?.addEventListener('click', () => { state.isCollapsed = true; render(); });
    byId('ctx-fullscreen', false)?.addEventListener('click', () => { state.isFullscreen = !state.isFullscreen; if (state.isFullscreen) state.isCollapsed = false; render(); });
    byId('ctx-collapse', false)?.addEventListener('click', () => { state.isCollapsed = !state.isCollapsed; render(); });
    byId('ctx-new', false)?.addEventListener('click', () => { resetPrompt(); render(); });

    // Nav
    byId('ctx-nav-fetch', false)?.addEventListener('click', () => { if (state.isCollapsed) state.isCollapsed = false; state.currentView = 'fetch'; render(); });
    byId('ctx-nav-history', false)?.addEventListener('click', () => { if (state.isCollapsed) state.isCollapsed = false; state.currentView = 'history'; if (!state.historyLoading) loadPromptHistory(); });
    byId('ctx-nav-settings', false)?.addEventListener('click', () => { if (state.isCollapsed) state.isCollapsed = false; state.currentView = 'settings'; render(); });
    byId('ctx-collapse-toggle', false)?.addEventListener('click', () => { state.isCollapsed = !state.isCollapsed; render(); });

    // Fetch view events
    const promptEl = byId('ctx-original-prompt', false);
    if (promptEl) promptEl.addEventListener('input', (e) => {
      state.originalPrompt = e.target.value;
      resizeTextarea(e.target);
      const submitBtn = byId('ctx-submit', false);
      if (submitBtn) submitBtn.disabled = state.loading || !state.originalPrompt.trim() || !state.selectedSchemas.length;
    });

    byId('ctx-toggle-context', false)?.addEventListener('click', () => {
      state.showContextSelection = !state.showContextSelection; render();
    });
    byId('ctx-close-context', false)?.addEventListener('click', () => { state.showContextSelection = false; state.contextSearchTerm = ""; render(); });
    const searchEl = byId('ctx-context-search', false);
    if (searchEl) searchEl.addEventListener('input', (e) => { state.contextSearchTerm = e.target.value; render(); });

    // Add/remove contexts
    container.querySelectorAll('[data-add-schema]')?.forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = e.currentTarget.getAttribute('data-add-schema');
        if (!state.selectedSchemas.includes(id)) state.selectedSchemas.push(id);
        state.showContextSelection = false; state.contextSearchTerm = ""; render();
      });
    });
    container.querySelectorAll('[data-remove-schema]')?.forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = e.currentTarget.getAttribute('data-remove-schema');
        state.selectedSchemas = state.selectedSchemas.filter(s => s !== id); render();
      });
    });

    byId('ctx-submit', false)?.addEventListener('click', submitPrompt);

    // File context toggle
    byId('ctx-filectx-toggle', false)?.addEventListener('click', () => { state.showFileContext = !state.showFileContext; render(); });
    container.querySelectorAll('[data-filectx]')?.forEach(div => {
      div.addEventListener('click', (e) => {
        const id = e.currentTarget.getAttribute('data-filectx');
        const ctx = state.fileContexts.find(c => c.id === id);
        if (!ctx) return;
        ctx.selected = !ctx.selected;
        if (ctx.selected) {
          if (!state.selectedFileExtracts.includes(ctx.content)) state.selectedFileExtracts.push(ctx.content);
        } else {
          state.selectedFileExtracts = state.selectedFileExtracts.filter(x => x !== ctx.content);
        }
        render();
      });
    });


    // History
    byId('ctx-history-refresh', false)?.addEventListener('click', loadPromptHistory);
    const hs = byId('ctx-history-search', false);
    if (hs) {
      hs.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadPromptHistory(); });
      hs.addEventListener('input', (e) => { state.historySearch = e.target.value; });
    }
    container.querySelectorAll('[data-history-id]')?.forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = e.currentTarget.getAttribute('data-history-id');
        const prompt = state.promptHistory.find(p => String(p.id) === String(id));
        if (!prompt) return;
              state.originalPrompt = prompt.original_prompt || "";
      state.currentPrompt = prompt;
      state.enhancedPrompt = prompt.enriched_prompt || "";
      state.selectedSchemas = Array.isArray(prompt.schemas_used) ? prompt.schemas_used : [];
      if (Array.isArray(prompt.questions_answers) && prompt.questions_answers.length) {
        state.questions = prompt.questions_answers;
        state.submittedAnswers = prompt.questions_answers;
      } else {
        state.questions = [];
        state.submittedAnswers = [];
      }
      if (prompt.context && Array.isArray(prompt.context)) {
          state.fileContexts = prompt.context.map((ctx, index) => ({ id: `${prompt.id}_${index}`, source: ctx.source, content: ctx.content, selected: false }));
        } else {
          state.fileContexts = [];
        }
        state.selectedFileExtracts = [];
        state.showQuestions = false; state.showFileContext = false; state.currentView = 'fetch';
        render();
      });
    });

    // Settings
    byId('ctx-settings-cancel', false)?.addEventListener('click', () => { state.currentView = 'fetch'; render(); });
    byId('ctx-settings-save', false)?.addEventListener('click', () => {
      const a = byId('ctx-settings-apikey');
      state.apiKey = a ? a.value : state.apiKey;
      state.isAuthenticated = !!(state.apiKey && state.apiKey.trim());
      saveLocal(); state.currentView = 'fetch'; state.error = null; if (state.isAuthenticated && ensureConfigured()) loadSchemas(); else render();
    });
    byId('ctx-disconnect', false)?.addEventListener('click', () => {
      try { localStorage.removeItem(STORAGE_KEYS.apiKey); } catch(_){}
      state.apiKey = ""; state.isAuthenticated = false; state.schemas = []; state.currentPrompt = null; state.enhancedPrompt = ""; state.questions = []; render();
    });

    // Connect on unauthenticated view
    byId('ctx-connect', false)?.addEventListener('click', () => {
      const a = byId('ctx-api-key');
      state.apiKey = a ? a.value : "";
      state.isAuthenticated = !!(state.apiKey && state.apiKey.trim());
      state.error = null;
      saveLocal();
      if (state.isAuthenticated && ensureConfigured()) loadSchemas(); else render();
    });

    // Footer copy
    byId('ctx-copy', false)?.addEventListener('click', () => {
      const text = state.enhancedPrompt + generateAdditionalContext() + generateFileContext() + generateQAContext();
      copyToClipboard(text);
    });

    // Q&A events
    byId('ctx-qa-toggle', false)?.addEventListener('click', () => { state.showQuestions = !state.showQuestions; render(); });
    byId('ctx-qa-submit', false)?.addEventListener('click', submitAnswers);
    byId('ctx-qa-skip', false)?.addEventListener('click', () => { state.showQuestions = false; render(); });
    container.querySelectorAll('[data-qa-index]')?.forEach(ta => {
      ta.addEventListener('input', (e) => {
        const idxStr = e.currentTarget.getAttribute('data-qa-index');
        const idx = Number(idxStr);
        if (!isNaN(idx) && state.questions[idx]) {
          state.questions[idx].answer = e.target.value;
        }
      });
    });

    // Reopen floating button
    byId('ctx-reopen', false)?.addEventListener('click', () => { state.isOpen = true; render(); });
  };

  // Helpers
  const byId = (id, required = true) => {
    const node = container.querySelector(`#${id}`);
    if (!node && required) console.warn(`[ContextOS] element #${id} not found`);
    return node || null;
  };

  const escapeHtml = (str) => (str || "").replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c]));
  const escapeAttr = (str) => (str || "").replace(/[&<>]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));

  const resetPrompt = () => {
    state.originalPrompt = "";
    state.enhancedPrompt = "";
    state.currentPrompt = null;
    state.questions = [];
    state.submittedAnswers = [];
    state.selectedSchemas = [];
    state.error = null;
    state.fileContexts = [];
    state.selectedFileExtracts = [];
    state.showFileContext = false;
    state.showQuestions = false;
  };

  const resizeTextarea = (ta) => {
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 240) + 'px';
  };

  const render = () => {
    ensureRoot();
    renderMain();
  };

  // Init
  loadLocal();
  ensureRoot();
  render();
  if (state.isAuthenticated) loadSchemas();
})();


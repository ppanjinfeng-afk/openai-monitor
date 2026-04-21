# Console Layout Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refresh the existing OpenAI Monitor frontend so the layout feels more polished, consistent, and professional without changing product behavior.

**Architecture:** Keep the current multi-page single-file frontend structure, but tighten the visual system in place. The work is concentrated in `public/index.html` for small structural wrappers and semantic grouping, `public/css/style.css` for the active theme layer, and a tiny `public/js/app.js` helper only if responsive class toggles or page-title metadata need to be normalized.

**Tech Stack:** Static HTML, vanilla JavaScript, CSS, Express-served frontend

---

## File Structure

- **Modify:** `public/index.html`
  - Add minimal wrappers and utility classes to make hero/toolbars/panels follow one visual rhythm.
  - Preserve IDs used by existing JS.
- **Modify:** `public/css/style.css`
  - Update the active theme layer only.
  - Normalize spacing, card treatments, toolbar hierarchy, page section headers, table panels, and responsive behavior.
- **Modify (only if needed):** `public/js/app.js`
  - Keep behavior unchanged.
  - Only touch if markup adjustments require a selector update or a page-title metadata helper.
- **Manual verification:** existing browser UI for dashboard, accounts, workspaces, invites, audit, checkout-tools, settings.

### Task 1: Lock the dashboard and console shell markup

**Files:**
- Modify: `public/index.html:73-238`
- Test: manual browser check on dashboard layout

- [ ] **Step 1: Add a failing visual checklist in the plan notes**

```md
Expected failures before implementation:
- Header, hero, stat cards, and content panels do not share one spacing rhythm.
- Accounts/workspaces pages have toolbars that feel crowded and visually flat.
- Page sections do not consistently separate summary, tools, and data surfaces.
```

- [ ] **Step 2: Run app to confirm current baseline**

Run: `node "C:/Users/lysan/.gemini/antigravity/scratch/openai-monitor/server.js"`
Expected: local server starts successfully and existing UI loads.

- [ ] **Step 3: Refine dashboard shell markup with non-breaking wrappers**

Update `public/index.html` around the dashboard and top-level page areas to use stable semantic wrappers like this while preserving all existing IDs and button handlers:

```html
<header class="top-header">
  <div class="header-left">
    <button class="menu-toggle" id="menu-toggle">...</button>
    <div class="page-title-wrap">
      <span class="page-kicker">运营总览</span>
      <h1 class="page-title" id="page-title">仪表盘</h1>
    </div>
  </div>
  <div class="header-right header-actions-primary">
    <button class="btn btn-ghost" id="btn-refresh" title="刷新数据">...</button>
    <button class="btn btn-primary header-cta" id="btn-check-all" title="立即检查所有账号">...</button>
  </div>
</header>

<div class="page-content" id="page-content">
  <div class="page page-active-shell" id="page-dashboard">
    <section class="dashboard-hero panel panel-hero panel-hero-compact">...</section>
    <div class="stats-grid dashboard-stats-grid dashboard-stats-grid-balanced" id="stats-grid">...</div>
    <div class="dashboard-story-grid dashboard-story-grid-emphasis">...</div>
  </div>
</div>
```

- [ ] **Step 4: Group section headers consistently on secondary pages**

Apply one shared header structure to accounts, invites, workspaces, audit, checkout-tools, and settings:

```html
<div class="page-section-head page-section-head-inline page-section-head-compact">
  <div class="page-section-copy">
    <span class="page-section-kicker">Accounts Operations</span>
    <h2 class="page-section-title">账号池、授权状态、配额与邀请能力总览。</h2>
    <p class="page-section-text">集中处理搜索、筛选、配额同步、坏号检测、自动邀请和成员管理。</p>
  </div>
</div>
```

- [ ] **Step 5: Run visual smoke check**

Reload the app in the browser.
Expected: no console errors, navigation still switches pages, all existing `id` hooks still work.

### Task 2: Normalize the global visual system in CSS

**Files:**
- Modify: `public/css/style.css:1390-2206`
- Test: manual browser check for shell, sidebar, header, panel spacing

- [ ] **Step 1: Add visual tokens for spacing and panel hierarchy**

Extend the active `:root` block with a tighter, reusable token set:

```css
:root {
  --surface-0: #08131c;
  --surface-1: rgba(10, 18, 27, 0.94);
  --surface-2: rgba(12, 22, 33, 0.9);
  --surface-3: rgba(255, 255, 255, 0.03);
  --line-soft: rgba(148, 175, 170, 0.10);
  --line-strong: rgba(148, 175, 170, 0.18);
  --shadow-soft: 0 12px 30px rgba(0, 0, 0, 0.18);
  --shadow-panel: 0 18px 38px rgba(0, 0, 0, 0.22);
  --space-1: 8px;
  --space-2: 12px;
  --space-3: 16px;
  --space-4: 20px;
  --space-5: 24px;
}
```

- [ ] **Step 2: Tighten sidebar and top header treatments**

Replace the current shell styling with a more restrained look:

```css
.sidebar,
.main-content {
  border: 1px solid var(--line-soft);
  box-shadow: var(--shadow-soft);
}

.top-header {
  height: 72px;
  padding: 0 var(--space-4);
  background: rgba(9, 18, 28, 0.88);
  backdrop-filter: blur(10px);
}

.page-title {
  font-size: 1.24rem;
  letter-spacing: -0.04em;
}

.page-kicker {
  color: rgba(180, 197, 193, 0.52);
}
```

- [ ] **Step 3: Standardize panel, hero, and section spacing**

Update shared blocks so every page reads with the same rhythm:

```css
.page-content {
  padding: var(--space-4) var(--space-4) var(--space-5);
}

.panel {
  background: var(--surface-1);
  border: 1px solid var(--line-soft);
  border-radius: 18px;
  box-shadow: none;
}

.panel-header {
  padding: 14px 18px;
}

.panel-body {
  padding: 14px 18px 18px;
}

.page-section-head {
  margin-bottom: 14px;
}
```

- [ ] **Step 4: Make hero blocks shorter and more premium**

Update hero-specific rules to reduce banner feel and improve readability:

```css
.panel-hero {
  padding: 16px 18px;
  border-radius: 18px;
}

.dashboard-hero-title {
  max-width: 640px;
  font-size: clamp(1.1rem, 1.3vw, 1.38rem);
  line-height: 1.14;
}

.dashboard-hero-text {
  max-width: 560px;
  font-size: 0.82rem;
  color: rgba(214, 226, 223, 0.74);
}
```

- [ ] **Step 5: Reload and verify shell consistency**

Expected: sidebar, header, hero, and standard panels now feel visually related and use visibly consistent spacing.

### Task 3: Rebuild stat cards, toolbars, and table surfaces as one system

**Files:**
- Modify: `public/css/style.css:1827-2206`
- Modify: `public/index.html:114-192`, `public/index.html:250-319`, `public/index.html:377-410`, `public/index.html:424-492`
- Test: manual browser check on dashboard cards and list pages

- [ ] **Step 1: Adjust stat card markup only where wrappers improve hierarchy**

Keep IDs unchanged, but allow a cleaner internal layout where needed:

```html
<div class="stat-card stat-total interactive" data-dashboard-action="accounts_all" tabindex="0" role="button">
  <div class="stat-card-top">
    <div class="stat-icon">...</div>
    <span class="stat-label">总账号</span>
  </div>
  <div class="stat-info">
    <span class="stat-value" id="stat-total">0</span>
    <span class="stat-subtext">账号池总量概览</span>
  </div>
</div>
```

- [ ] **Step 2: Restyle stat cards with less glow and stronger hierarchy**

```css
.dashboard-stats-grid-balanced {
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 12px;
}

.stat-card {
  min-height: 104px;
  padding: 14px;
  background: linear-gradient(180deg, rgba(14, 24, 35, 0.96), rgba(10, 18, 27, 0.94));
  border: 1px solid var(--line-soft);
}

.stat-card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.stat-value {
  font-size: 1.5rem;
}

.stat-label {
  font-size: 0.68rem;
  letter-spacing: 0.1em;
}
```

- [ ] **Step 3: Introduce a stronger toolbar pattern for dense pages**

Add an optional grouped toolbar wrapper in markup where actions are visually noisy:

```html
<div class="toolbar toolbar-premium compact-toolbar toolbar-clustered toolbar-separated">
  <div class="toolbar-left toolbar-group-filters">...</div>
  <div class="toolbar-right toolbar-group-actions">...</div>
</div>
```

Then style it:

```css
.toolbar-separated {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  background: var(--surface-2);
}

.toolbar-group-filters,
.toolbar-group-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.search-box,
.form-input,
.select-input {
  min-height: 40px;
  border-radius: 12px;
}
```

- [ ] **Step 4: Elevate table wrappers without changing data behavior**

```css
.accounts-table-wrapper {
  padding: 8px;
  border-radius: 16px;
  background: rgba(9, 17, 25, 0.92);
  border: 1px solid var(--line-soft);
}

.accounts-table {
  border-spacing: 0 6px;
}

.accounts-table thead th {
  padding: 12px 14px;
  color: rgba(225, 235, 232, 0.62);
}

.accounts-table tbody tr {
  background: rgba(255, 255, 255, 0.018);
}
```

- [ ] **Step 5: Verify accounts, invites, and workspaces page rhythm**

Expected: the toolbars read as a single strip, data tables feel like premium panels, and primary actions are clearer than secondary actions.

### Task 4: Strengthen page-specific layouts and responsive behavior

**Files:**
- Modify: `public/css/style.css:2090-3392`
- Modify: `public/index.html:194-237`, `public/index.html:531-668`, `public/index.html:681-890`
- Test: manual browser check for dashboard, side panels, and narrow widths

- [ ] **Step 1: Refine dashboard and console split layouts**

```css
.dashboard-story-grid-emphasis {
  grid-template-columns: minmax(0, 1.8fr) minmax(280px, 0.72fr);
  gap: 14px;
}

.accounts-console-grid,
.workspaces-console-grid,
.audit-console-grid {
  gap: 16px;
}

.accounts-console-side,
.workspaces-console-side,
.audit-console-side {
  top: 84px;
}
```

- [ ] **Step 2: Improve secondary side panels and summary cards**

```css
.quota-overview-card,
.dashboard-alert-item,
.workspace-summary-card,
.audit-summary-card {
  border-radius: 14px;
  border: 1px solid var(--line-soft);
  background: rgba(255, 255, 255, 0.022);
}
```

If summary card class names differ, use the exact existing selectors found in `style.css` rather than inventing new behavior.

- [ ] **Step 3: Make checkout and audit workbenches visually match the rest**

Reuse the same section/header/panel language for these pages, avoiding one-off bright treatments:

```css
.checkout-result-panel,
.checkout-side-panel,
.compact-panel {
  border-radius: 18px;
  border: 1px solid var(--line-soft);
  background: var(--surface-1);
}
```

- [ ] **Step 4: Tighten responsive rules instead of collapsing too late**

Update existing responsive blocks near the end of `style.css` so layout changes happen earlier and more cleanly:

```css
@media (max-width: 1200px) {
  .accounts-console-grid,
  .workspaces-console-grid,
  .audit-console-grid,
  .dashboard-story-grid-emphasis {
    grid-template-columns: 1fr;
  }

  .accounts-console-side,
  .workspaces-console-side,
  .audit-console-side {
    position: static;
  }
}

@media (max-width: 860px) {
  .top-header,
  .page-content {
    padding-left: 14px;
    padding-right: 14px;
  }

  .toolbar-separated {
    flex-direction: column;
    align-items: stretch;
  }
}
```

- [ ] **Step 5: Verify responsive behavior manually**

Check at desktop width, medium width, and narrow width.
Expected: no overlapping toolbar controls, no clipped stat cards, sidebar/mobile shell still opens and closes correctly.

### Task 5: Apply minimal JS fixes only if markup changes require them

**Files:**
- Modify: `public/js/app.js` (only if selectors or page metadata break)
- Test: browser console and page navigation

- [ ] **Step 1: Search for selectors or assumptions broken by the markup changes**

Check for lookups like these in `public/js/app.js`:

```js
const host = document.getElementById('stats-grid');
const page = document.getElementById('page-content');
const button = document.getElementById('btn-refresh');
```

- [ ] **Step 2: Keep JS changes minimal and localized**

If a wrapper class needs to be toggled after navigation, use a tiny helper like this rather than restructuring page logic:

```js
setActivePageShell(pageId) {
  document.querySelectorAll('.page').forEach(node => {
    node.classList.toggle('page-active-shell', node.id === `page-${pageId}` && !node.classList.contains('hidden'));
  });
}
```

Then call it only from the existing navigation/render path.

- [ ] **Step 3: Verify runtime behavior**

Expected: no new console errors, nav still works, refresh buttons still work, no event handler regressions.

### Task 6: Final verification and local handoff

**Files:**
- Modify: none if all prior tasks succeed
- Test: full frontend smoke test

- [ ] **Step 1: Run the app again after all edits**

Run: `node "C:/Users/lysan/.gemini/antigravity/scratch/openai-monitor/server.js"`
Expected: server starts successfully.

- [ ] **Step 2: Execute manual verification checklist**

Check all of the following in the browser:

```md
- Dashboard hero is shorter and cleaner.
- Stat cards have consistent height, icon treatment, spacing, and number hierarchy.
- Accounts/workspaces/invites toolbars look unified and not overcrowded.
- Tables sit inside cleaner panels with improved spacing.
- Side summary panels align visually with main panels.
- Responsive layout does not overlap or clip controls.
- No features changed: searching, filtering, pagination, and buttons still work.
```

- [ ] **Step 3: Record implementation notes for the user**

Summarize only:

```md
- Files changed
- Any selectors kept intentionally for JS compatibility
- Any responsive tradeoffs still worth revisiting later
```

- [ ] **Step 4: Commit if and only if the project is under git**

If `git rev-parse --is-inside-work-tree` succeeds:

```bash
git add public/index.html public/css/style.css public/js/app.js
git commit -m "feat: polish console layout hierarchy"
```

If it fails, skip commit and report that this workspace is not a git repository.

---

## Self-Review

- **Spec coverage:** Covers the approved direction: keep the existing dense console structure, refine shell/header/hero, unify stat cards, unify list-page toolbars and panels, reduce glow and gradient noise, and preserve behavior.
- **Placeholder scan:** No TODO/TBD placeholders remain. JS work is explicitly optional and bounded.
- **Type consistency:** All file paths and selectors referenced exist in the current codebase (`public/index.html`, `public/css/style.css`, `public/js/app.js`).

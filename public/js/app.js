// Main Application Controller

const App = {
  currentPage: 'dashboard',
  accounts: [],
  stats: {},
  selectedIds: new Set(),
  currentEditId: null,
  currentAccountsPage: 1,
  currentInvitesPage: 1,
  currentWorkspacesPage: 1,
  currentCdkCardsPage: 1,
  currentCdkOrdersPage: 1,
  currentCdkTasksPage: 1,
  cdkPageLimit: 10,
  searchTimeout: null,
  autoRefreshInterval: null,
  checkStatusInterval: null,
  bulkChecking: false,
  requestFlights: new Map(),
  workspaceDashboard: { alerts: [], failure_categories: [], summary: {} },
  auditData: null,
  batchAuditData: null,
  batchAuditSelection: new Set(),
  batchAuditProgress: null,
  memberCleanupData: null,
  memberCleanupSelection: new Set(),
  memberCleanupLoading: false,
  memberCleanupSearchTimeout: null,
  untrackedMembersData: null,
  untrackedMembersSelection: new Set(),
  untrackedMembersLoading: false,
  untrackedMembersSearchTimeout: null,
  checkoutToolsData: { summary: {}, items: [], filters: {} },
  lastCheckoutToolResult: null,
  currentModalType: null,
  autosubPollers: new Map(),
  currentMembersAccountId: null,
  currentMembersAccount: null,
  currentMembers: [],
  currentMembersTotal: 0,
  currentMembersSearch: '',
  currentMembersLoading: false,
  currentMemberDetailUserId: null,
  currentMemberDetail: null,
  currentMemberDetailLoading: false,
  currentMemberDetailError: '',
  currentInviteAccountId: null,
  currentInviteAccount: null,
  currentInviteWorkspaces: [],
  currentInviteSelectedWorkspaceId: '',
  currentInvitePreferredWorkspaceId: '',
  currentInviteLoading: false,
  currentInviteError: '',
  overflowRebalanceRecords: [],
  cdkCardsData: { items: [], summary: {} },
  cdkTasksData: { tasks: [] },
  cdkOrdersData: { orders: [], summary: {} },
  cdkTraceData: null,
  systemMetricsHistory: { cpu: [], memory: [] },
  systemMetricsTimer: null,
  systemMetricsMaxPoints: 60,

  // ===== Init =====
  async init() {
    this.bindEvents();
    this.navigateTo('dashboard');
    this.startAutoRefresh();
    this.syncBulkCheckStatus({ silent: true, skipRefresh: true }).catch(err => {
      console.warn('Failed to sync bulk check status:', err);
    });
  },

  setText(id, value) {
    const element = document.getElementById(id);
    if (element) {
      element.textContent = value;
    }
  },

  resetAccountDashboardFilters(status = 'all') {
    const searchInput = document.getElementById('search-input');
    const statusFilter = document.getElementById('status-filter');

    if (searchInput) searchInput.value = '';
    if (statusFilter) statusFilter.value = status;

    this.currentAccountsPage = 1;
  },

  resetWorkspaceDashboardFilters(capacity = 'all') {
    const searchInput = document.getElementById('search-workspaces-input');
    const statusFilter = document.getElementById('workspace-sync-filter');
    const capacityFilter = document.getElementById('workspace-capacity-filter');
    const sortBy = document.getElementById('workspace-sort-by');
    const sortDirection = document.getElementById('workspace-sort-direction');

    if (searchInput) searchInput.value = '';
    if (statusFilter) statusFilter.value = 'all';
    if (capacityFilter) capacityFilter.value = capacity;
    if (sortBy) sortBy.value = 'health';
    if (sortDirection) sortDirection.value = 'desc';

    this.currentWorkspacesPage = 1;
  },

  handleDashboardStatAction(action) {
    switch (action) {
      case 'accounts_all':
        this.resetAccountDashboardFilters('all');
        this.navigateTo('accounts');
        break;
      case 'accounts_active':
        this.resetAccountDashboardFilters('active');
        this.navigateTo('accounts');
        break;
      case 'accounts_banned':
        this.resetAccountDashboardFilters('banned');
        this.navigateTo('accounts');
        break;
      case 'accounts_invalid':
        this.openInvalidCredentialsModal();
        break;
      case 'accounts_quota':
      case 'quota_sync':
        this.resetAccountDashboardFilters('all');
        this.navigateTo('accounts');
        break;
      case 'over_quota':
        this.resetWorkspaceDashboardFilters('over');
        this.navigateTo('workspaces');
        break;
      case 'invite_health':
        this.openInviteHealthModal();
        break;
    }
  },

  runSingleFlight(key, work) {
    if (this.requestFlights.has(key)) {
      return this.requestFlights.get(key);
    }

    const promise = (async () => work())()
      .finally(() => {
        if (this.requestFlights.get(key) === promise) {
          this.requestFlights.delete(key);
        }
      });

    this.requestFlights.set(key, promise);
    return promise;
  },

  getWorkspaceFilters() {
    return {
      search: document.getElementById('search-workspaces-input')?.value.trim() || '',
      status: document.getElementById('workspace-sync-filter')?.value || 'all',
      capacity: document.getElementById('workspace-capacity-filter')?.value || 'all',
      sort: document.getElementById('workspace-sort-by')?.value || 'health',
      direction: document.getElementById('workspace-sort-direction')?.value || 'desc',
    };
  },

  getAuditFilters() {
    return {
      recommendation: document.getElementById('audit-recommendation-filter')?.value || 'all',
      presence: document.getElementById('audit-presence-filter')?.value || 'all',
      history: document.getElementById('audit-history-filter')?.value || 'all',
    };
  },

  getCheckoutToolFilters() {
    return {
      search: document.getElementById('search-checkout-tools-input')?.value.trim() || '',
      limit: 100,
    };
  },

  clearCheckoutToolForm() {
    const input = document.getElementById('checkout-tool-input');
    const redeemCode = document.getElementById('checkout-redeem-code');
    const note = document.getElementById('checkout-tool-note');

    if (input) input.value = '';
    if (redeemCode) redeemCode.value = '';
    if (note) note.value = '';
  },

  updateWorkspaceResultsMeta(result = null) {
    const host = document.getElementById('workspace-results-meta');
    if (!host) return;

    if (!result) {
      host.textContent = '正在读取工作区...';
      return;
    }

    const filters = result.filters || {};
    const statusLabels = {
      success: '同步成功',
      error: '同步失败',
      stale: '未再返回',
    };
    const capacityLabels = {
      available: '余量充足',
      warning: '仅剩 1 个',
      full: '刚好满员',
      over: '已经超额',
    };
    const bits = [`共 ${result.total || 0} 个工作区`];
    if (filters.search) bits.push(`搜索 “${filters.search}”`);
    if (filters.status && filters.status !== 'all') bits.push(`状态 ${statusLabels[filters.status] || filters.status}`);
    if (filters.capacity && filters.capacity !== 'all') bits.push(`容量 ${capacityLabels[filters.capacity] || filters.capacity}`);
    host.textContent = bits.join(' · ');
  },

  resetWorkspaceFilters() {
    const search = document.getElementById('search-workspaces-input');
    const status = document.getElementById('workspace-sync-filter');
    const capacity = document.getElementById('workspace-capacity-filter');
    const sort = document.getElementById('workspace-sort-by');
    const direction = document.getElementById('workspace-sort-direction');

    if (search) search.value = '';
    if (status) status.value = 'all';
    if (capacity) capacity.value = 'all';
    if (sort) sort.value = 'health';
    if (direction) direction.value = 'desc';

    this.loadWorkspaces(1);
  },

  clearAudit() {
    this.auditData = null;
    const input = document.getElementById('audit-email-input');
    if (input) {
      input.value = '';
    }
    const recommendation = document.getElementById('audit-recommendation-filter');
    const presence = document.getElementById('audit-presence-filter');
    const history = document.getElementById('audit-history-filter');
    if (recommendation) recommendation.value = 'all';
    if (presence) presence.value = 'all';
    if (history) history.value = 'all';
    this.renderAudit();
  },

  updateAuditBulkKickButton() {
    const button = document.getElementById('btn-audit-bulk-remove');
    if (!button) {
      return;
    }

    const removableMembers = (Array.isArray(this.auditData?.memberships) ? this.auditData.memberships : [])
      .filter(item => !item.is_owner && item.account_id && item.user_id);

    button.disabled = removableMembers.length === 0;
    button.innerHTML = `<span>批量踢人${removableMembers.length > 0 ? ` (${removableMembers.length})` : ''}</span>`;
  },

  async refreshCurrentPage(options = {}) {
    const page = options.page || this.currentPage;
    switch (page) {
      case 'dashboard':
        await Promise.all([this.loadStats(), this.loadRecentLogs(), this.loadWorkspaceDashboard(), this.loadCdkPriceSetting()]);
        break;
      case 'accounts':
        await this.refreshAccountsSurface();
        break;
      case 'workspaces':
        await this.refreshWorkspacesSurface();
        break;
      case 'invites':
        await this.loadInvites(this.currentInvitesPage);
        break;
      case 'audit': {
        const email = this.auditData?.email || document.getElementById('audit-email-input')?.value.trim() || '';
        if (email) {
          await this.runEmailAudit({ email, silent: true });
        } else {
          this.renderAudit();
        }
        break;
      }
      case 'member-cleanup':
        await Promise.all([this.loadStaleMemberAutoKickSetting(), this.loadMemberCleanup()]);
        break;
      case 'untracked-members':
        await Promise.all([this.loadUntrackedAutoKickSetting(), this.loadUntrackedMembers()]);
        break;
      case 'checkout-tools':
        await this.loadCheckoutTools();
        break;
      case 'cdk-manage':
        await this.loadCdkPage();
        break;
      case 'system-monitor':
        await this.loadSystemMetrics(options);
        break;
      case 'logs':
        await this.loadLogs();
        break;
      case 'settings':
        await this.loadSettings();
        break;
    }
  },

  async refreshAccountsSurface(extraLoads = []) {
    await Promise.all([
      this.loadAccounts(this.currentAccountsPage),
      this.loadStats(),
      this.loadOverflowRebalanceRecords(),
      this.loadWorkspaces(this.currentWorkspacesPage),
      this.loadWorkspaceDashboard(),
      ...extraLoads,
    ]);
  },

  async refreshWorkspacesSurface(extraLoads = []) {
    await Promise.all([
      this.loadWorkspaces(this.currentWorkspacesPage),
      this.loadWorkspaceDashboard(),
      ...extraLoads,
    ]);
  },

  async refreshWorkspaceChangeSurfaces(options = {}) {
    const extraLoads = [];

    if (options.includeLogs) {
      extraLoads.push(this.loadRecentLogs());
    }

    if (options.includeCurrentPage && !['dashboard', 'accounts', 'workspaces'].includes(this.currentPage)) {
      extraLoads.push(this.refreshCurrentPage({ page: this.currentPage }));
    }

    await this.refreshAccountsSurface(extraLoads);
  },

  clearAutoSubPoller(id) {
    const timer = this.autosubPollers.get(id);
    if (timer) {
      clearInterval(timer);
      this.autosubPollers.delete(id);
    }
  },

  clearAllAutoSubPollers() {
    this.autosubPollers.forEach(timer => clearInterval(timer));
    this.autosubPollers.clear();
  },

  resetInviteModalState() {
    this.currentInviteAccountId = null;
    this.currentInviteAccount = null;
    this.currentInviteWorkspaces = [];
    this.currentInviteSelectedWorkspaceId = '';
    this.currentInvitePreferredWorkspaceId = '';
    this.currentInviteLoading = false;
    this.currentInviteError = '';
  },

  resetMembersModalState() {
    this.currentMembersAccountId = null;
    this.currentMembersAccount = null;
    this.currentMembers = [];
    this.currentMembersTotal = 0;
    this.currentMembersSearch = '';
    this.currentMembersLoading = false;
    this.currentMemberDetailUserId = null;
    this.currentMemberDetail = null;
    this.currentMemberDetailLoading = false;
    this.currentMemberDetailError = '';
  },

  resetBatchAuditModalState() {
    this.batchAuditSelection = new Set();
    this.batchAuditProgress = null;
  },

  jumpToWorkspace(workspaceId, workspaceName = '') {
    const searchInput = document.getElementById('search-workspaces-input');
    if (searchInput) {
      searchInput.value = workspaceName || workspaceId || '';
    }
    this.navigateTo('workspaces');
    this.loadWorkspaces(1);
  },

  openWorkspaceInvite(accountId, workspaceId = '', workspaceName = '') {
    this.openInviteModal(accountId, { workspaceId, workspaceName });
  },

  openWorkspaceMembers(accountId, workspaceId = '', workspaceName = '', planType = '', accountEmail = '') {
    this.openMembersModal(accountId, { workspaceId, workspaceName, planType, accountEmail });
  },

  getCurrentMembersWorkspaceParams() {
    return {
      workspace_id: this.currentMembersAccount?.quota_workspace_id || '',
      workspace_name: this.currentMembersAccount?.quota_workspace_name || '',
      plan_type: this.currentMembersAccount?.quota_plan_type || '',
    };
  },

  // ===== Navigation =====
  pageTitleMap: {
    dashboard: '仪表盘',
    accounts: '账号管理',
    workspaces: '工作区',
    audit: '邮箱审计',
    invites: '邀请记录',
    logs: '检查日志',
    'cdk-manage': 'CDK 管理',
    'member-cleanup': '成员清理',
    'untracked-members': '没有记录来源',
    'checkout-tools': '结账工具',
    'system-monitor': 'VPS 监控',
    settings: '设置',
  },

  navigateTo(page) {
    this.currentPage = page;

    // Update nav items
    document.querySelectorAll('.nav-item').forEach(el => {
      el.classList.toggle('active', el.dataset.page === page);
    });

    // Show/hide pages
    document.querySelectorAll('.page').forEach(el => {
      el.classList.toggle('hidden', el.id !== `page-${page}`);
    });

    // Update title
    document.getElementById('page-title').textContent = this.pageTitleMap[page] || page;

    // Show/hide check all button based on page
    const btnCheckAll = document.getElementById('btn-check-all');
    if (btnCheckAll) {
      const showCheckButton = ['dashboard', 'accounts'].includes(page);
      btnCheckAll.style.display = showCheckButton ? '' : 'none';
    }

    this.updateSystemMonitorPolling(page);

    // Load page data
    this.loadPageData(page);
  },

  async loadPageData(page) {
    await this.refreshCurrentPage({ page });
  },

  // ===== Stats =====
  async loadStats() {
    return this.runSingleFlight('stats', async () => {
      try {
        this.stats = await API.getStats();
        this.setText('stat-total', this.stats.currentTotal ?? this.stats.total);
        this.setText('stat-active', this.stats.active);
        this.setText('stat-banned', this.stats.banned);
        this.setText('stat-invalid', this.stats.invalid || 0);
        this.setText('stat-invites', `${this.stats.invitesUsed}/${this.stats.invitesTotal}`);

        const quotaSyncValue = `${this.stats.quotaSyncSuccess || 0}/${this.stats.quotaSyncEligible || 0}`;
        const quotaSyncMeta = this.stats.quotaLastSyncedAt
          ? `上次 ${Components.timeAgo(this.stats.quotaLastSyncedAt)}`
          : '从未同步';
        const overQuotaMeta = (this.stats.overQuota || 0) > 0
          ? `${this.stats.overQuota} 个超额`
          : `${this.stats.fullQuota || 0} 个已满`;

        this.setText('stat-quota-sync', quotaSyncValue);
        this.setText('stat-quota-sync-meta', quotaSyncMeta);
        this.setText('stat-over-quota', this.stats.overQuota || 0);
        this.setText('stat-over-quota-meta', overQuotaMeta);
        this.setText(
          'stat-invalid-meta',
          (this.stats.invalid || 0) > 0
            ? `${this.stats.invalid || 0} 个隐藏账号`
            : '当前没有'
        );
        this.setText('stat-bad-invite', this.stats.badInviteAccounts || 0);
        this.setText(
          'stat-bad-invite-meta',
          (this.stats.badInviteAccounts || 0) > 0
            ? `${this.stats.badInviteAccounts || 0} 个坏号 · ${this.stats.watchInviteAccounts || 0} 个待观察`
            : '暂无异常'
        );

        this.setText('quota-last-synced', quotaSyncMeta);
        this.setText(
          'quota-sync-summary',
          `${this.stats.quotaSyncSuccess || 0}/${this.stats.quotaSyncEligible || 0} 成功 · ${this.stats.quotaSyncError || 0} 失败`
        );
        this.setText(
          'quota-over-quota-summary',
          (this.stats.overQuota || 0) > 0
            ? `${this.stats.overQuota} 个账号超额`
            : `${this.stats.fullQuota || 0} 个账号已满`
        );
      } catch (err) {
        console.error('Failed to load stats:', err);
      }
    });
  },

  async openInviteHealthModal(accountId = null) {
    const account = accountId ? this.accounts.find(item => item.id === accountId) : null;
    const title = account ? `坏号检测 · ${account.email}` : '坏号检测';
    this.showModal(
      title,
      '<div class="empty-state"><p>正在检测坏号...</p></div>',
      { wide: true, type: 'invite-health' }
    );

    try {
      const result = await API.getInviteHealth(accountId ? { account_id: accountId } : {});
      this.showModal(title, Components.inviteHealthModal(result), { wide: true, type: 'invite-health' });
    } catch (err) {
      this.showModal(
        title,
        `<div class="empty-state"><p>坏号检测失败</p><p class="text-muted">${Components.escapeHtml(err.message)}</p></div>`,
        { wide: true, type: 'invite-health' }
      );
      this.toast(`坏号检测失败: ${err.message}`, 'error');
    }
  },

  inspectInviteHealth(id) {
    return this.openInviteHealthModal(id);
  },

  async restoreInviteHealth(id) {
    try {
      const result = await API.restoreInviteHealth(id);
      this.toast(result.message || '已恢复邀请状态', 'success');
      await this.refreshAccountsSurface();
      if (this.currentModalType === 'invite-health') {
        await this.openInviteHealthModal();
      }
    } catch (err) {
      this.toast(`恢复邀请状态失败: ${err.message}`, 'error');
    }
  },

  async restoreAllInviteHealth() {
    if (!confirm('确定要一键修复所有邀请坏号/待观察账号吗？系统会清掉近 24 小时的邀请异常计数，并解除自动暂停。')) {
      return;
    }

    try {
      const result = await API.restoreAllInviteHealth();
      this.toast(result.message || '已批量恢复邀请状态', 'success');
      await this.refreshAccountsSurface();
      await this.openInviteHealthModal();
    } catch (err) {
      this.toast(`批量恢复邀请状态失败: ${err.message}`, 'error');
    }
  },

  async openInvalidCredentialsModal() {
    const title = '令牌无效账号';
    this.showModal(
      title,
      '<div class="empty-state"><p>正在读取隐藏账号...</p></div>',
      { wide: true, type: 'invalid-accounts' }
    );

    try {
      const result = await API.getInvalidAccounts();
      this.showModal(title, Components.invalidCredentialsModal(result), { wide: true, type: 'invalid-accounts' });
    } catch (err) {
      this.showModal(
        title,
        `<div class="empty-state"><p>读取失败</p><p class="text-muted">${Components.escapeHtml(err.message)}</p></div>`,
        { wide: true, type: 'invalid-accounts' }
      );
      this.toast(`读取令牌无效账号失败: ${err.message}`, 'error');
    }
  },

  async recheckInvalidAccount(id) {
    await this.checkSingle(id);
    await this.openInvalidCredentialsModal();
  },

  // ===== Accounts =====
  async loadAccounts(page = this.currentAccountsPage) {
    this.currentAccountsPage = page;
    const searchInput = document.getElementById('search-input');
    const statusFilter = document.getElementById('status-filter');
    const params = { page };

    if (searchInput && searchInput.value) {
      params.search = searchInput.value;
    }
    if (statusFilter && statusFilter.value !== 'all') {
      params.status = statusFilter.value;
    }

    const requestKey = `accounts:${JSON.stringify(params)}`;
    return this.runSingleFlight(requestKey, async () => {
      try {
        const data = await API.getAccounts(params);
        this.accounts = data.accounts;

        const accountsTable = document.getElementById('accounts-table');
        const tbody = document.getElementById('accounts-tbody');
        const empty = document.getElementById('accounts-empty');

        if (this.accounts.length === 0) {
          tbody.innerHTML = '';
          empty.classList.remove('hidden');
          if (accountsTable) {
            accountsTable.classList.add('hidden');
          }
        } else {
          empty.classList.add('hidden');
          if (accountsTable) {
            accountsTable.classList.remove('hidden');
          }
          tbody.innerHTML = this.accounts.map(acc => Components.accountRow(acc)).join('');
        }

        this.renderPagination(data);
        this.updateBulkActions();
        this.updateOverflowRebalanceMeta();
      } catch (err) {
        console.error('Failed to load accounts:', err);
        this.toast('加载账号失败: ' + err.message, 'error');
      }
    });
  },

  updateOverflowRebalanceMeta() {
    const meta = document.getElementById('overflow-rebalance-meta');
    if (!meta) {
      return;
    }

    const activeOverflowAccounts = this.accounts.filter(account => Number(account?.workspace_overflow_count || 0) > 0).length;
    const recentCount = Array.isArray(this.overflowRebalanceRecords) ? this.overflowRebalanceRecords.length : 0;

    if (activeOverflowAccounts > 0) {
      meta.textContent = `当前还有 ${activeOverflowAccounts} 个账号超员，下面是最近 ${recentCount || 0} 条处理记录`;
      return;
    }

    if (recentCount > 0) {
      meta.textContent = `最近 ${recentCount} 条自动迁移 / 修复记录`;
      return;
    }

    meta.textContent = '最近自动迁移与修复结果';
  },

  renderOverflowRebalanceRecords() {
    const host = document.getElementById('overflow-rebalance-records');
    if (!host) {
      return;
    }

    if (!Array.isArray(this.overflowRebalanceRecords) || this.overflowRebalanceRecords.length === 0) {
      host.innerHTML = `
        <div class="empty-state overflow-records-empty">
          <p>最近还没有迁移记录</p>
          <p class="text-muted">出现超员后，自动迁移结果会显示在这里</p>
        </div>
      `;
      this.updateOverflowRebalanceMeta();
      return;
    }

    host.innerHTML = this.overflowRebalanceRecords
      .map(record => Components.overflowRebalanceRecord(record))
      .join('');
    this.updateOverflowRebalanceMeta();
  },

  async loadOverflowRebalanceRecords(limit = 12) {
    const requestKey = `overflow-rebalance-records:${limit}`;
    return this.runSingleFlight(requestKey, async () => {
      const host = document.getElementById('overflow-rebalance-records');
      if (host && (!Array.isArray(this.overflowRebalanceRecords) || this.overflowRebalanceRecords.length === 0)) {
        host.innerHTML = `
          <div class="empty-state overflow-records-empty">
            <p>正在读取迁移记录...</p>
          </div>
        `;
      }

      try {
        const result = await API.getOverflowRebalanceRecords({ limit });
        this.overflowRebalanceRecords = Array.isArray(result?.records) ? result.records : [];
        this.renderOverflowRebalanceRecords();
      } catch (err) {
        console.error('Failed to load overflow rebalance records:', err);
        if (host) {
          host.innerHTML = `
            <div class="empty-state overflow-records-empty">
              <p>迁移记录读取失败</p>
              <p class="text-muted">${Components.escapeHtml(err.message)}</p>
            </div>
          `;
        }
        this.updateOverflowRebalanceMeta();
      }
    });
  },

  renderPagination(data) {
    const container = document.getElementById('pagination');
    if (data.total <= data.limit) {
      container.innerHTML = '';
      return;
    }

    const totalPages = Math.ceil(data.total / data.limit);
    let html = '';

    html += `<button ${data.page <= 1 ? 'disabled' : ''} onclick="App.goToPage(${data.page - 1})">‹</button>`;

    for (let i = 1; i <= totalPages; i++) {
      if (i === data.page) {
        html += `<button class="active">${i}</button>`;
      } else if (Math.abs(i - data.page) <= 2 || i === 1 || i === totalPages) {
        html += `<button onclick="App.goToPage(${i})">${i}</button>`;
      } else if (Math.abs(i - data.page) === 3) {
        html += `<button disabled>…</button>`;
      }
    }

    html += `<button ${data.page >= totalPages ? 'disabled' : ''} onclick="App.goToPage(${data.page + 1})">›</button>`;
    container.innerHTML = html;
  },

  goToPage(page) {
    this.loadAccounts(page);
  },

  // ===== Logs =====
  async loadRecentLogs() {
    try {
      const data = await API.getLogs({ limit: 20, visible_only: true });
      const container = document.getElementById('recent-logs');
      if (data.logs.length === 0) {
        container.innerHTML = `
          <div class="empty-state">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            <p>暂无检查记录</p>
          </div>`;
      } else {
        container.innerHTML = data.logs.map(log =>
          Components.logEntry(log)
        ).join('');
      }
    } catch (err) {
      console.error('Failed to load recent logs:', err);
    }
  },

  async loadLogs() {
    try {
      const data = await API.getLogs({ limit: 100 });
      const container = document.getElementById('logs-list');
      if (data.logs.length === 0) {
        container.innerHTML = '<div class="empty-state"><p>暂无日志</p></div>';
      } else {
        container.innerHTML = data.logs.map(log =>
          Components.logEntry(log)
        ).join('');
      }
    } catch (err) {
      console.error('Failed to load logs:', err);
      this.toast('加载日志失败', 'error');
    }
  },

  // ===== Invites =====
  async loadInvites(page = 1) {
    this.currentInvitesPage = page;
    const searchInput = document.getElementById('search-invites-input');
    const search = searchInput ? searchInput.value : '';
    const requestKey = `invites:${page}:${search}`;

    return this.runSingleFlight(requestKey, async () => {
      try {
        const res = await API.getInvites({ page, limit: 50, search });

        const tbody = document.getElementById('invites-tbody');
        const emptyState = document.getElementById('invites-empty');
        const table = document.getElementById('invites-table');
        const pagination = document.getElementById('invites-pagination');

        if (res.invites.length === 0) {
          table.classList.add('hidden');
          emptyState.classList.remove('hidden');
          pagination.innerHTML = '';
        } else {
          table.classList.remove('hidden');
          emptyState.classList.add('hidden');
          tbody.innerHTML = res.invites.map(i => Components.inviteRow(i)).join('');
          this.renderInvitesPagination(res.total, res.page, res.limit);
        }
      } catch (err) {
        console.error('Failed to load invites:', err);
        this.toast('加载邀请记录失败', 'error');
      }
    });
  },
  
  renderInvitesPagination(total, currentPage, limit) {
    const totalPages = Math.ceil(total / limit);
    const container = document.getElementById('invites-pagination');
    
    if (totalPages <= 1) {
      container.innerHTML = '';
      return;
    }

    let html = '';
    for (let i = 1; i <= totalPages; i++) {
      if (i === 1 || i === totalPages || (i >= currentPage - 2 && i <= currentPage + 2)) {
        html += `<button class="page-btn ${i === currentPage ? 'active' : ''}" onclick="App.loadInvites(${i})">${i}</button>`;
      } else if (i === currentPage - 3 || i === currentPage + 3) {
        html += `<span class="page-dots">...</span>`;
      }
    }
    container.innerHTML = html;
  },

  formatInviteResultMessage(result) {
    const details = [];
    const usedAccount = result.used_account || '';
    const fallbackFromAccount = result.fallback_from_account || '';
    const remoteInviteId = result.remote_invite_id || result.remoteInviteId || '';
    const workspaceName = result.workspace_name || result.workspaceName || '';

    if (usedAccount) {
      details.push(`实际账号: ${usedAccount}`);
    }
    if (fallbackFromAccount) {
      details.push(`回退自: ${fallbackFromAccount}`);
    }
    if (workspaceName) {
      details.push(`工作区: ${workspaceName}`);
    }
    if (remoteInviteId) {
      details.push(`远端ID: ${Components.shortId(remoteInviteId)}`);
    }

    return details.length > 0
      ? `${result.message} [${details.join(' | ')}]`
      : result.message;
  },

  async deleteInvite(id) {
    if (!confirm('确定要删除这条邀请记录吗？')) return;
    try {
      await API.deleteInvite(id);
      this.toast('记录已删除', 'success');
      await Promise.all([
        this.loadInvites(this.currentInvitesPage),
        this.loadAccounts(this.currentAccountsPage),
        this.loadStats(),
      ]);
      this.loadLogs();
      this.loadAccounts();
      this.loadStats();
    } catch (err) {
      this.toast(err.message, 'error');
    }
  },
  
  async resendInvite(accountId, email, workspaceId = '', workspaceName = '') {
    if (!confirm(`确定要使用原账号为 ${email} 重新发送邀请吗？\n（系统将自动识别为补发，不会重复扣除名额）`)) return;
    
    try {
      this.toast(`正在补发 ${email} 的邀请...`, 'info');
      const res = await API.inviteAccount(accountId, email, {
        force_resend: true,
        workspace_id: workspaceId || '',
        workspace_name: workspaceName || '',
      });
      this.toast(`✅ ${this.formatInviteResultMessage(res)}`, 'success');
      await Promise.all([
        this.loadInvites(this.currentInvitesPage),
        this.loadAccounts(this.currentAccountsPage),
        this.loadStats(),
      ]);
    } catch (err) {
      this.toast(`❌ 补发失败: ${err.message}`, 'error');
    }
  },

  // ===== Settings =====
  formatCdkPriceYuan(cents) {
    return (Number(cents || 200) / 100).toFixed(2);
  },

  parseCdkPriceCents(value) {
    const amount = Number(String(value || '').replace(/[^\d.]/g, ''));
    if (!Number.isFinite(amount) || amount < 0.01 || amount > 9999.99) {
      return null;
    }
    return Math.round(amount * 100);
  },

  applyCdkPriceSetting(settings = {}) {
    const cents = Number.parseInt(settings.cdk_team_price_cents || '200', 10) || 200;
    const yuan = this.formatCdkPriceYuan(cents);
    const input = document.getElementById('dashboard-cdk-price-yuan');
    const note = document.getElementById('dashboard-cdk-price-note');

    if (input) {
      input.value = yuan;
    }
    if (note) {
      note.textContent = `当前每个 CDK：${yuan} CNY，新订单会按此金额生成支付宝 API 二维码。`;
    }
  },

  async loadCdkPriceSetting() {
    try {
      const settings = await API.getSettings();
      this.applyCdkPriceSetting(settings);
    } catch (err) {
      console.error('Failed to load CDK price setting:', err);
    }
  },

  async saveCdkPriceSetting() {
    const input = document.getElementById('dashboard-cdk-price-yuan');
    const cents = this.parseCdkPriceCents(input?.value);
    if (!cents) {
      this.toast('请输入 0.01 到 9999.99 之间的金额', 'error');
      return;
    }

    try {
      const settings = await API.updateSettings({ cdk_team_price_cents: String(cents) });
      this.applyCdkPriceSetting(settings);
      this.toast(`CDK 售价已更新为 ${this.formatCdkPriceYuan(cents)} CNY`, 'success');
    } catch (err) {
      this.toast('保存金额失败: ' + err.message, 'error');
    }
  },

  async loadSettings() {
    try {
      const settings = await API.getSettings();
      document.getElementById('tg-bot-token').value = settings.telegram_bot_token || '';
      document.getElementById('tg-chat-id').value = settings.telegram_chat_id || '';
      document.getElementById('alerts-enabled').checked = settings.alerts_enabled === 'true';
      document.getElementById('check-interval').value = settings.check_interval_minutes || 30;
      document.getElementById('invite-cooldown').value = settings.invite_cooldown_minutes || 5;
      document.getElementById('daily-summary-enabled').checked = settings.daily_summary_enabled === 'true';
      document.getElementById('daily-summary-hour').value = settings.daily_summary_hour || '9';
      const publicTunnelEnabled = settings.public_tunnel_enabled !== 'false';
      document.getElementById('public-tunnel-enabled').checked = publicTunnelEnabled;
      this.updatePublicTunnelStatus(publicTunnelEnabled);
      this.applyUntrackedAutoKickSetting(settings);
      this.applyStaleMemberAutoKickSetting(settings);
      this.applyCdkPriceSetting(settings);
    } catch (err) {
      console.error('Failed to load settings:', err);
    }
  },

  applyUntrackedAutoKickSetting(settings = {}) {
    const checkbox = document.getElementById('untracked-auto-kick-enabled');
    const status = document.getElementById('untracked-auto-kick-status');
    const enabled = settings.untracked_members_auto_kick_enabled === 'true';

    if (checkbox) {
      checkbox.checked = enabled;
    }

    if (status) {
      status.className = `quota-sync-badge ${enabled ? 'warning' : 'skipped'}`;
      status.textContent = enabled ? '自动踢人已开启' : '自动踢人已关闭';
    }
  },

  async loadUntrackedAutoKickSetting() {
    try {
      const settings = await API.getSettings();
      this.applyUntrackedAutoKickSetting(settings);
    } catch (err) {
      console.error('Failed to load untracked auto kick setting:', err);
    }
  },

  async saveUntrackedAutoKickSetting() {
    const checkbox = document.getElementById('untracked-auto-kick-enabled');
    if (!checkbox) {
      return;
    }

    try {
      const settings = await API.updateSettings({
        untracked_members_auto_kick_enabled: checkbox.checked ? 'true' : 'false',
      });
      this.applyUntrackedAutoKickSetting(settings);
      this.toast(checkbox.checked ? '没有来源记录自动踢人已开启' : '没有来源记录自动踢人已关闭', 'success');
    } catch (err) {
      this.toast(`保存自动踢人开关失败: ${err.message}`, 'error');
    }
  },

  getStaleMemberAutoKickHoursInput() {
    const input = document.getElementById('stale-members-auto-kick-hours');
    const hours = Number.parseFloat(input?.value || '26');
    if (!Number.isFinite(hours) || hours < 1 || hours > 720) {
      return null;
    }
    return hours;
  },

  applyStaleMemberAutoKickSetting(settings = {}) {
    const checkbox = document.getElementById('stale-members-auto-kick-enabled');
    const input = document.getElementById('stale-members-auto-kick-hours');
    const status = document.getElementById('stale-members-auto-kick-status');
    const enabled = settings.stale_members_auto_kick_enabled === 'true';
    const hours = Number.parseFloat(settings.stale_members_auto_kick_hours || '26') || 26;

    if (checkbox) {
      checkbox.checked = enabled;
    }

    if (input) {
      input.value = String(Math.max(1, Math.min(hours, 720)));
    }

    if (status) {
      status.className = `quota-sync-badge ${enabled ? 'warning' : 'skipped'}`;
      status.textContent = enabled ? `已开启，超过 ${hours} 小时自动踢出` : '自动踢人已关闭';
    }
  },

  async loadStaleMemberAutoKickSetting() {
    try {
      const settings = await API.getSettings();
      this.applyStaleMemberAutoKickSetting(settings);
    } catch (err) {
      console.error('Failed to load stale member auto kick setting:', err);
    }
  },

  async saveStaleMemberAutoKickSetting() {
    const checkbox = document.getElementById('stale-members-auto-kick-enabled');
    if (!checkbox) {
      return;
    }

    const hours = this.getStaleMemberAutoKickHoursInput();
    if (!hours) {
      this.toast('自动踢人小时数必须在 1 到 720 之间', 'error');
      return;
    }

    try {
      const settings = await API.updateSettings({
        stale_members_auto_kick_enabled: checkbox.checked ? 'true' : 'false',
        stale_members_auto_kick_hours: String(hours),
      });
      this.applyStaleMemberAutoKickSetting(settings);
      this.toast(checkbox.checked ? `超时自动踢人已开启：超过 ${hours} 小时` : '超时自动踢人已关闭', 'success');
    } catch (err) {
      this.toast(`保存超时自动踢人设置失败: ${err.message}`, 'error');
    }
  },

  async runStaleMemberAutoKickNow() {
    const hours = this.getStaleMemberAutoKickHoursInput();
    if (!hours) {
      this.toast('自动踢人小时数必须在 1 到 720 之间', 'error');
      return;
    }

    if (!confirm(`确定立即踢出加入超过 ${hours} 小时的普通成员吗？所有者不会被踢出。`)) {
      return;
    }

    const button = document.getElementById('btn-run-stale-member-auto-kick');
    if (button) {
      button.disabled = true;
      button.classList.add('loading');
    }

    try {
      const result = await API.runStaleMemberAutoKick(hours);
      this.memberCleanupSelection = new Set();
      await this.loadMemberCleanup({ silent: true });
      this.toast(`超时自动踢人完成：成功 ${result.removed || 0} 个，失败 ${result.failed || 0} 个`, result.failed ? 'warning' : 'success');
    } catch (err) {
      this.toast(`超时自动踢人失败: ${err.message}`, 'error');
    } finally {
      if (button) {
        button.disabled = false;
        button.classList.remove('loading');
      }
      this.renderMemberCleanup();
    }
  },

  updatePublicTunnelStatus(enabled) {
    const status = document.getElementById('public-tunnel-status');
    const note = document.getElementById('public-tunnel-note');

    if (status) {
      status.className = `quota-sync-badge ${enabled ? 'success' : 'warning'}`;
      status.textContent = enabled ? '公网已开启' : '维护中';
    }

    if (note) {
      note.textContent = enabled
        ? '关闭后 https://www.penqda.com/buy 会显示维护中，localhost:3000 不受影响。'
        : '当前公网域名入口已关闭，访问会显示维护中；localhost:3000 仍然正常。';
    }
  },

  async saveSettings(type) {
    try {
      let data;
      if (type === 'telegram') {
        data = {
          telegram_bot_token: document.getElementById('tg-bot-token').value,
          telegram_chat_id: document.getElementById('tg-chat-id').value,
          alerts_enabled: document.getElementById('alerts-enabled').checked ? 'true' : 'false',
        };
      } else if (type === 'public-tunnel') {
        data = {
          public_tunnel_enabled: document.getElementById('public-tunnel-enabled').checked ? 'true' : 'false',
        };
      } else {
        data = {
          check_interval_minutes: document.getElementById('check-interval').value,
          invite_cooldown_minutes: document.getElementById('invite-cooldown').value,
          daily_summary_enabled: document.getElementById('daily-summary-enabled').checked ? 'true' : 'false',
          daily_summary_hour: document.getElementById('daily-summary-hour').value,
        };
      }

      const settings = await API.updateSettings(data);
      if (type === 'public-tunnel') {
        const publicTunnelEnabled = settings.public_tunnel_enabled !== 'false';
        this.updatePublicTunnelStatus(publicTunnelEnabled);
        this.toast(
          publicTunnelEnabled ? '公网入口已开启' : '公网入口已关闭，外部访问会显示维护中',
          'success'
        );
        return settings;
      }
      this.toast('设置已保存', 'success');
    } catch (err) {
      this.toast('保存失败: ' + err.message, 'error');
    }
  },

  async testTelegram() {
    const btn = document.getElementById('btn-test-telegram');
    btn.disabled = true;
    btn.textContent = '发送中...';

    try {
      // Save settings first
      await this.saveSettings('telegram');
      await API.testTelegram();
      this.toast('测试消息已发送，请检查 Telegram', 'success');
    } catch (err) {
      this.toast('发送失败: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '发送测试消息';
    }
  },

  // ===== Account Actions =====
  showAddModal() {
    this.currentEditId = null;
    this.showModal('添加账号', Components.addAccountModal(), { type: 'account' });
    document.getElementById('account-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleSaveAccount();
    });
  },

  async editAccount(id) {
    const account = this.accounts.find(a => a.id === id);
    if (!account) return;

    this.currentEditId = id;
    this.showModal('编辑账号', Components.addAccountModal(account), { type: 'account' });
    document.getElementById('account-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleSaveAccount();
    });
  },

  async handleSaveAccount() {
    const data = {
      email: document.getElementById('acc-email').value,
      password: document.getElementById('acc-password').value,
      label: document.getElementById('acc-label').value,
      invite_link: document.getElementById('acc-invite-link').value,
      invite_total: parseInt(document.getElementById('acc-invite-total').value),
      invited_count: parseInt(document.getElementById('acc-invited-count').value),
    };

    try {
      if (this.currentEditId) {
        await API.updateAccount(this.currentEditId, data);
        this.toast('账号已更新', 'success');
      } else {
        await API.addAccount(data);
        this.toast('账号已添加', 'success');
      }
      this.closeModal();
      await this.loadAccounts();
      await this.loadStats();
    } catch (err) {
      this.toast('保存失败: ' + err.message, 'error');
    }
  },

  async deleteAccount(id) {
    if (!confirm('确定要删除此账号吗？')) return;

    try {
      await API.deleteAccount(id);
      this.toast('账号已删除', 'success');
      await this.loadAccounts();
      await this.loadStats();
    } catch (err) {
      this.toast('删除失败: ' + err.message, 'error');
    }
  },

  async checkSingle(id) {
    this.toast('正在检查...', 'info');
    try {
      const result = await API.checkAccount(id);
      this.toast(`检查完成: ${Components.statusLabels[result.status] || result.status}`, 'success');
      await this.refreshWorkspaceChangeSurfaces({
        includeLogs: this.currentPage === 'dashboard',
        includeCurrentPage: true,
      });
    } catch (err) {
      this.toast('检查失败: ' + err.message, 'error');
    }
  },

  async oauthAccount(id) {
    this.toast('正在启动 OAuth 授权...', 'info');
    try {
      const result = await API.startOAuth(id);
      // Open auth URL in new tab
      window.open(result.authUrl, '_blank');
      this.toast('已在新标签页打开授权页面，请在那里登录 OpenAI 账号', 'info');
      // Poll for completion
      setTimeout(() => this.loadAccounts(), 5000);
      setTimeout(() => this.loadAccounts(), 15000);
      setTimeout(() => this.loadAccounts(), 30000);
    } catch (err) {
      this.toast('OAuth 启动失败: ' + err.message, 'error');
    }
  },

  async checkAll() {
    const btn = document.getElementById('btn-check-all');
    btn.disabled = true;
    btn.classList.add('loading');

    try {
      await API.runCheckAll();
      this.toast('全量检查已启动，后台运行中', 'info');
    } catch (err) {
      this.toast('启动检查失败: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.classList.remove('loading');
    }
  },

  async runFullCheck() {
    if (this.bulkChecking) {
      this.toast('全量检测正在运行中', 'warning');
      return;
    }

    this.bulkChecking = true;
    this.setCheckAllButtonState(true);
    this.startCheckStatusPolling();

    try {
      await API.runCheckAll();
      this.toast('已启动全量检测，完成后会自动刷新', 'info');
    } catch (err) {
      if (String(err.message || '').includes('already in progress')) {
        this.toast('已有全量检测在运行，正在读取状态', 'warning');
        this.startCheckStatusPolling();
        await this.syncBulkCheckStatus({ silent: true, skipRefresh: true }).catch(() => {});
        return;
      }

      this.bulkChecking = false;
      this.setCheckAllButtonState(false);
      this.stopCheckStatusPolling();
      this.toast('启动全量检测失败: ' + err.message, 'error');
    }
  },

  setCheckAllButtonState(isChecking) {
    const btn = document.getElementById('btn-check-all');
    if (!btn) return;

    btn.disabled = Boolean(isChecking);
    btn.classList.toggle('loading', Boolean(isChecking));
    btn.title = isChecking ? '正在检测所有账号状态' : '立即检查所有账号';

    const label = btn.querySelector('span');
    if (label) {
      label.textContent = isChecking ? '检测中...' : '立即检查';
    }
  },

  startCheckStatusPolling() {
    if (this.checkStatusInterval) {
      return;
    }

    this.checkStatusInterval = setInterval(() => {
      this.syncBulkCheckStatus().catch(err => {
        console.error('Bulk check status polling failed:', err);
      });
    }, 3000);
  },

  stopCheckStatusPolling() {
    if (!this.checkStatusInterval) {
      return;
    }

    clearInterval(this.checkStatusInterval);
    this.checkStatusInterval = null;
  },

  async syncBulkCheckStatus(options = {}) {
    const status = await API.getCheckStatus();
    const nextChecking = Boolean(status?.isChecking);
    const wasChecking = this.bulkChecking;

    this.bulkChecking = nextChecking;
    this.setCheckAllButtonState(nextChecking);

    if (nextChecking) {
      this.startCheckStatusPolling();
    } else {
      this.stopCheckStatusPolling();
    }

    if (wasChecking && !nextChecking) {
      if (!options.silent) {
        this.toast('全量检测已完成', 'success');
      }
      if (!options.skipRefresh) {
        await this.refreshWorkspaceChangeSurfaces({
          includeLogs: this.currentPage === 'dashboard',
          includeCurrentPage: true,
        });
      }
    }

    return nextChecking;
  },

  async syncAllQuotas() {
    const btn = document.getElementById('btn-sync-quotas');
    if (btn) {
      btn.disabled = true;
      btn.classList.add('loading');
    }

    this.toast('正在同步全部名额...', 'info');

    try {
      const result = await API.syncAllQuotas();
      const summary = [`成功 ${result.synced}`];
      if (result.failed) summary.push(`失败 ${result.failed}`);
      if (result.skipped) summary.push(`跳过 ${result.skipped}`);
      if (result.overQuota) summary.push(`超额 ${result.overQuota}`);

      this.toast(`名额同步完成: ${summary.join(' / ')}`, result.failed ? 'warning' : 'success');
      await this.refreshAccountsSurface();
    } catch (err) {
      this.toast(`同步名额失败: ${err.message}`, 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.classList.remove('loading');
      }
    }
  },

  async syncAccountQuota(id) {
    const account = this.accounts.find(item => item.id === id);
    const label = account ? account.email : `#${id}`;
    this.toast(`正在同步 ${label} 的名额...`, 'info');

    try {
      const result = await API.syncAccountQuota(id);
      const syncSuffix = result.overQuota
        ? ` / 超额 ${Math.abs(result.remainingSeats)}`
        : ` / 剩余 ${result.remainingSeats}`;

      if (result.skipped) {
        this.toast(`已跳过: ${result.message}`, 'warning');
      } else {
        this.toast(
          `同步完成: ${result.email} => 成员总数 ${result.totalUsers} / 占位成员 ${result.memberSeats} / 待处理邀请 ${result.pendingInvites}${syncSuffix}`,
          result.overQuota ? 'warning' : 'success'
        );
      }

      await this.refreshAccountsSurface();
    } catch (err) {
      this.toast(`同步名额失败: ${err.message}`, 'error');
    }
  },

  // ===== Members =====
  renderMembersModal() {
    if (!this.currentMembersAccountId || !this.currentMembersAccount) {
      return;
    }

    this.showModal(
      '\u6210\u5458\u7ba1\u7406',
      Components.membersModal(this.currentMembersAccount, {
        workspaceName: this.currentMembersAccount.quota_workspace_name,
        planType: this.currentMembersAccount.quota_plan_type,
        loading: this.currentMembersLoading,
        members: this.currentMembers,
        total: this.currentMembersTotal,
        search: this.currentMembersSearch,
        selectedUserId: this.currentMemberDetailUserId,
        detailLoading: this.currentMemberDetailLoading,
        detail: this.currentMemberDetail,
        detailError: this.currentMemberDetailError,
      }),
      { wide: true, type: 'members' }
    );
  },

  async openMembersModal(id, options = {}) {
    const account = this.accounts.find(item => item.id === id);
    const baseAccount = account || {
      id,
      email: String(options.accountEmail || `#${id}`),
      label: '',
      quota_workspace_id: '',
      quota_workspace_name: '',
      quota_plan_type: '',
    };

    this.currentMembersAccountId = id;
    this.currentMembersAccount = {
      ...baseAccount,
      quota_workspace_id: String(options.workspaceId || baseAccount.quota_workspace_id || '').trim(),
      quota_workspace_name: String(options.workspaceName || baseAccount.quota_workspace_name || '').trim(),
      quota_plan_type: String(options.planType || baseAccount.quota_plan_type || '').trim(),
    };
    this.currentMembers = [];
    this.currentMembersTotal = 0;
    this.currentMembersSearch = '';
    this.currentMembersLoading = true;
    this.currentMemberDetailUserId = null;
    this.currentMemberDetail = null;
    this.currentMemberDetailLoading = false;
    this.currentMemberDetailError = '';

    this.renderMembersModal();

    try {
      const result = await API.getMembers(id, this.getCurrentMembersWorkspaceParams());
      if (this.currentMembersAccountId !== id) {
        return;
      }

      this.currentMembers = result.members || [];
      this.currentMembersTotal = Number(result.total || this.currentMembers.length || 0);
      this.currentMembersAccount = {
        ...this.currentMembersAccount,
        quota_workspace_id: result.workspace_id || this.currentMembersAccount.quota_workspace_id,
        quota_workspace_name: result.workspace_name || this.currentMembersAccount.quota_workspace_name,
        quota_plan_type: result.plan_type || this.currentMembersAccount.quota_plan_type,
      };
      this.currentMembersLoading = false;
      this.renderMembersModal();
    } catch (err) {
      if (this.currentMembersAccountId === id) {
        this.currentMembersLoading = false;
      }
      this.toast(`\u52a0\u8f7d\u6210\u5458\u5931\u8d25: ${err.message}`, 'error');
      this.closeModal();
    }
  },

  async refreshMembersModal(options = {}) {
    if (!this.currentMembersAccountId) {
      return;
    }

    const accountId = this.currentMembersAccountId;
    this.currentMembersLoading = true;
    this.renderMembersModal();

    try {
      const result = await API.getMembers(accountId, this.getCurrentMembersWorkspaceParams());
      if (this.currentMembersAccountId !== accountId) {
        return;
      }

      this.currentMembers = result.members || [];
      this.currentMembersTotal = Number(result.total || this.currentMembers.length || 0);
      this.currentMembersAccount = {
        ...this.currentMembersAccount,
        quota_workspace_id: result.workspace_id || this.currentMembersAccount.quota_workspace_id,
        quota_workspace_name: result.workspace_name || this.currentMembersAccount.quota_workspace_name,
        quota_plan_type: result.plan_type || this.currentMembersAccount.quota_plan_type,
      };
      this.currentMembersLoading = false;

      if (
        this.currentMemberDetailUserId &&
        !this.currentMembers.some(member => member.id === this.currentMemberDetailUserId)
      ) {
        this.currentMemberDetailUserId = null;
        this.currentMemberDetail = null;
        this.currentMemberDetailLoading = false;
        this.currentMemberDetailError = '';
      }

      this.renderMembersModal();

      if (options.reloadDetail && this.currentMemberDetailUserId) {
        await this.loadMemberDetail(accountId, this.currentMemberDetailUserId, { silent: true });
      }
    } catch (err) {
      if (this.currentMembersAccountId === accountId) {
        this.currentMembersLoading = false;
        this.renderMembersModal();
      }
      this.toast(`\u5237\u65b0\u6210\u5458\u5217\u8868\u5931\u8d25: ${err.message}`, 'error');
    }
  },

  filterMembers(value) {
    this.currentMembersSearch = value || '';
    if (this.currentMembersAccountId) {
      this.renderMembersModal();
      setTimeout(() => {
        const input = document.querySelector('.members-search input');
        if (!input) return;
        input.focus();
        const length = input.value.length;
        if (typeof input.setSelectionRange === 'function') {
          input.setSelectionRange(length, length);
        }
      }, 0);
    }
  },

  async loadMemberDetail(accountId, userId, options = {}) {
    if (!this.currentMembersAccountId || this.currentMembersAccountId !== accountId) {
      return;
    }

    this.currentMemberDetailUserId = userId;
    this.currentMemberDetailLoading = true;
    this.currentMemberDetailError = '';
    if (!options.silent) {
      this.renderMembersModal();
    }

    try {
      const result = await API.getMemberDetail(accountId, userId, this.getCurrentMembersWorkspaceParams());
      if (this.currentMembersAccountId !== accountId || this.currentMemberDetailUserId !== userId) {
        return;
      }

      this.currentMemberDetail = result;
      this.currentMemberDetailLoading = false;
      this.currentMemberDetailError = '';
      this.renderMembersModal();
    } catch (err) {
      if (this.currentMembersAccountId === accountId && this.currentMemberDetailUserId === userId) {
        this.currentMemberDetailLoading = false;
        this.currentMemberDetailError = err.message;
        this.renderMembersModal();
      }
      this.toast(`\u52a0\u8f7d\u8be6\u60c5\u5931\u8d25: ${err.message}`, 'error');
    }
  },

  async updateMemberRole(accountId, userId, role) {
    const member = this.currentMembers.find(item => item.id === userId);
    if (!member || member.role === role) {
      return;
    }

    try {
      await API.updateMember(accountId, userId, { role }, this.getCurrentMembersWorkspaceParams());
      this.toast(`\u5df2\u66f4\u65b0 ${member.email || userId} \u7684\u8d26\u53f7\u7c7b\u578b`, 'success');
      await Promise.all([
        this.refreshMembersModal({ reloadDetail: true }),
        this.loadAccounts(this.currentAccountsPage),
        this.loadStats(),
        this.loadWorkspaces(this.currentWorkspacesPage),
        this.loadWorkspaceDashboard(),
      ]);
    } catch (err) {
      this.toast(`\u66f4\u65b0\u6210\u5458\u6743\u9650\u5931\u8d25: ${err.message}`, 'error');
      this.renderMembersModal();
    }
  },

  async removeMember(accountId, userId) {
    const member = this.currentMembers.find(item => item.id === userId);
    const label = member?.email || userId;
    if (!confirm(`\u786e\u5b9a\u8981\u5c06 ${label} \u8e22\u51fa\u5de5\u4f5c\u533a\u5417\uff1f`)) return;

    try {
      await API.removeMember(accountId, userId, this.getCurrentMembersWorkspaceParams());
      this.toast(`\u5df2\u79fb\u51fa ${label}`, 'success');
      if (this.currentMemberDetailUserId === userId) {
        this.currentMemberDetailUserId = null;
        this.currentMemberDetail = null;
        this.currentMemberDetailLoading = false;
        this.currentMemberDetailError = '';
      }
      await Promise.all([
        this.refreshMembersModal(),
        this.loadAccounts(this.currentAccountsPage),
        this.loadStats(),
        this.loadWorkspaces(this.currentWorkspacesPage),
        this.loadWorkspaceDashboard(),
      ]);
    } catch (err) {
      this.toast(`\u79fb\u51fa\u6210\u5458\u5931\u8d25: ${err.message}`, 'error');
    }
  },

  async logoutMember(accountId, userId) {
    const member = this.currentMembers.find(item => item.id === userId);
    const label = member?.email || userId;
    if (!confirm(`\u786e\u5b9a\u8981\u5c06 ${label} \u4ece\u6240\u6709\u4f1a\u8bdd\u4e2d\u4e0b\u7ebf\u5417\uff1f`)) return;

    try {
      await API.logoutMember(accountId, userId, this.getCurrentMembersWorkspaceParams());
      this.toast(`\u5df2\u5c06 ${label} \u4ece\u6240\u6709\u4f1a\u8bdd\u4e2d\u4e0b\u7ebf`, 'success');
      if (this.currentMemberDetailUserId === userId) {
        await this.loadMemberDetail(accountId, userId, { silent: true });
      }
    } catch (err) {
      this.toast(`\u6210\u5458\u4e0b\u7ebf\u5931\u8d25: ${err.message}`, 'error');
    }
  },

  // ===== Import =====
  showImportModal() {
    this.showModal('批量导入', Components.importModal(), { type: 'import' });
  },

  async handleImport() {
    const raw = document.getElementById('import-data').value.trim();
    if (!raw) {
      this.toast('请输入导入数据', 'warning');
      return;
    }

    let accounts = [];

    try {
      // Try JSON first
      accounts = JSON.parse(raw);
      if (!Array.isArray(accounts)) {
        accounts = [accounts];
      }
    } catch {
      // Try CSV format: email,api_key,label
      const lines = raw.split('\n').filter(l => l.trim());
      for (const line of lines) {
        const parts = line.split(',').map(s => s.trim());
        if (parts[0] && parts[0].includes('@')) {
          accounts.push({
            email: parts[0],
            password: parts[1] || '',
            label: parts[2] || '',
          });
        }
      }
    }

    if (accounts.length === 0) {
      this.toast('未识别到有效数据', 'error');
      return;
    }

    try {
      const result = await API.batchImport(accounts);
      this.toast(`成功导入 ${result.imported} 个账号`, 'success');
      if (result.errors.length > 0) {
        this.toast(`${result.errors.length} 个账号导入失败`, 'warning');
      }
      this.closeModal();
      await this.loadAccounts();
      await this.loadStats();
    } catch (err) {
      this.toast('导入失败: ' + err.message, 'error');
    }
  },

  // ===== Bulk Actions =====
  updateBulkActions() {
    const bar = document.getElementById('bulk-actions');
    const count = document.getElementById('selected-count');
    if (this.selectedIds.size > 0) {
      bar.classList.remove('hidden');
      count.textContent = `${this.selectedIds.size} 个已选`;
    } else {
      bar.classList.add('hidden');
    }
  },

  async bulkDelete() {
    if (!confirm(`确定要删除 ${this.selectedIds.size} 个账号吗？`)) return;

    try {
      await API.deleteAccounts([...this.selectedIds]);
      this.toast(`已删除 ${this.selectedIds.size} 个账号`, 'success');
      this.selectedIds.clear();
      await this.loadAccounts();
      await this.loadStats();
    } catch (err) {
      this.toast('批量删除失败: ' + err.message, 'error');
    }
  },

  // ===== Modal =====
  showModal(title, content, options = {}) {
    const modal = document.getElementById('modal');
    this.currentModalType = options.type || null;
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-body').innerHTML = content;
    modal.classList.toggle('modal-wide', Boolean(options.wide));
    document.getElementById('modal-overlay').classList.remove('hidden');
  },

  closeModal() {
    document.getElementById('modal-overlay').classList.add('hidden');
    document.getElementById('modal').classList.remove('modal-wide');

    switch (this.currentModalType) {
      case 'account':
        this.currentEditId = null;
        break;
      case 'invite':
        this.resetInviteModalState();
        break;
      case 'members':
        this.resetMembersModalState();
        break;
      case 'batch-audit':
        this.resetBatchAuditModalState();
        break;
      default:
        break;
    }

    this.currentModalType = null;
  },

  renderInviteModal() {
    if (!this.currentInviteAccountId) {
      return;
    }

    this.showModal(
      '发送团队邀请',
      Components.inviteModal(this.currentInviteAccountId, {
        loading: this.currentInviteLoading,
        error: this.currentInviteError,
        workspaces: this.currentInviteWorkspaces,
        selectedWorkspaceId: this.currentInviteSelectedWorkspaceId,
      }),
      { type: 'invite' }
    );

    if (!this.currentInviteLoading) {
      setTimeout(() => {
        const emailInput = document.getElementById('invite-email');
        if (emailInput) {
          emailInput.focus();
        }
      }, 50);
    }
  },

  async openInviteModal(id, options = {}) {
    const account = this.accounts.find(item => item.id === id);
    this.currentInviteAccountId = id;
    this.currentInviteAccount = account || null;
    this.currentInviteWorkspaces = [];
    this.currentInvitePreferredWorkspaceId = String(options.workspaceId || '').trim();
    this.currentInviteSelectedWorkspaceId = this.currentInvitePreferredWorkspaceId;
    this.currentInviteLoading = true;
    this.currentInviteError = '';
    this.renderInviteModal();

    try {
      const result = await API.getAccountWorkspaces(id);
      if (this.currentInviteAccountId !== id) {
        return;
      }

      this.currentInviteWorkspaces = Array.isArray(result.workspaces) ? result.workspaces : [];
      const preferredWorkspace = this.currentInvitePreferredWorkspaceId
        ? this.currentInviteWorkspaces.find(item => item.id === this.currentInvitePreferredWorkspaceId)
        : null;
      this.currentInviteSelectedWorkspaceId =
        preferredWorkspace?.id ||
        result.default_workspace_id ||
        this.currentInviteWorkspaces[0]?.id ||
        '';
      this.currentInviteLoading = false;
      this.currentInviteError = '';
      this.renderInviteModal();
    } catch (err) {
      if (this.currentInviteAccountId !== id) {
        return;
      }

      this.currentInviteLoading = false;
      this.currentInviteError = err.message;
      this.renderInviteModal();
    }
  },

  async handleSendInvite(id) {
    const emailInput = document.getElementById('invite-email');
    const email = emailInput ? emailInput.value.trim() : '';
    if (!email) {
      this.toast('请输入受邀邮箱', 'error');
      return;
    }

    const workspaceInput = document.getElementById('invite-workspace');
    const workspaceId = workspaceInput ? workspaceInput.value.trim() : '';
    const selectedWorkspace = this.currentInviteWorkspaces.find(item => item.id === workspaceId);
    const btn = document.getElementById('btn-submit-invite');
    if (!btn) {
      return;
    }

    const originalText = btn.textContent;
    btn.textContent = '发送中...';
    btn.disabled = true;

    try {
      const res = await API.inviteAccount(id, email, {
        workspace_id: workspaceId,
        workspace_name: selectedWorkspace?.name || '',
      });
      this.closeModal();
      this.toast(`成功: ${this.formatInviteResultMessage(res)}`, 'success');
      if (res.quota_sync_skipped_reason) {
        this.toast(res.quota_sync_skipped_reason, 'warning');
      }
      await Promise.all([
        this.loadLogs(),
        this.loadAccounts(this.currentAccountsPage),
        this.loadStats(),
        this.loadInvites(1),
        this.loadWorkspaces(this.currentWorkspacesPage),
      ]);
      if (this.currentPage === 'audit' && this.auditData?.email) {
        this.runEmailAudit({ email: this.auditData.email, silent: true });
      }
    } catch (err) {
      this.toast(`发送失败: ${err.message}`, 'error');
    } finally {
      if (document.getElementById('btn-submit-invite')) {
        btn.textContent = originalText;
        btn.disabled = false;
      }
    }
  },

  openAutoInviteModal() {
    const modalContent = Components.autoInviteModal();
    this.showModal('自动发送邀请', modalContent, { type: 'auto-invite' });
    setTimeout(() => document.getElementById('auto-invite-email')?.focus(), 100);
  },

  async handleAutoInvite() {
    const emailInput = document.getElementById('auto-invite-email');
    const email = emailInput.value.trim();
    if (!email) {
      this.toast('请输入受邀人的邮箱地址', 'error');
      return;
    }

    const btn = document.getElementById('btn-submit-auto-invite');
    const originalText = btn.textContent;
    btn.textContent = '自动分配并发送中... (请等待10-30秒)';
    btn.disabled = true;

    try {
      const res = await API.autoInvite(email);
      this.closeModal();
      this.toast(`✅ 成功: ${this.formatInviteResultMessage(res)}`, 'success');
      this.loadLogs();
      this.loadAccounts();
      this.loadStats();
      this.loadInvites(1);
    } catch (err) {
      this.toast(`❌ 发送失败: ${err.message}`, 'error');
    } finally {
      if (document.getElementById('btn-submit-auto-invite')) {
        btn.textContent = originalText;
        btn.disabled = false;
      }
    }
  },

  openBulkAutoInviteModal() {
    const modalContent = Components.bulkAutoInviteModal();
    document.getElementById('modal-title').textContent = '🚀 批量自动邀请';
    document.getElementById('modal-body').innerHTML = modalContent;
    document.getElementById('modal-overlay').classList.remove('hidden');
    setTimeout(() => document.getElementById('bulk-invite-emails').focus(), 100);
  },

  async handleBulkAutoInvite() {
    const emailInput = document.getElementById('bulk-invite-emails');
    const rawEmails = emailInput.value;
    
    // Parse emails splitting by any whitespace or punctuation
    const emails = rawEmails.split(/[\n,;|\s]+/)
      .map(e => e.trim())
      .filter(e => e && e.includes('@'));
      
    if (emails.length === 0) {
      this.toast('未在此文本中识别到有效的邮箱地址', 'error');
      return;
    }
    
    // Setup UI
    document.getElementById('bulk-invite-progress-container').classList.remove('hidden');
    const btnSubmit = document.getElementById('btn-submit-bulk-invite');
    const btnCancel = document.getElementById('btn-bulk-cancel');
    const statusText = document.getElementById('bulk-invite-status-text');
    const progressBar = document.getElementById('bulk-invite-progress-bar');
    const logsContainer = document.getElementById('bulk-invite-logs');
    
    btnSubmit.disabled = true;
    btnCancel.disabled = true;
    emailInput.disabled = true;
    
    let successCount = 0;
    let failCount = 0;
    
    const appendLog = (msg, color = 'var(--text-primary)') => {
      const el = document.createElement('div');
      el.style.color = color;
      el.style.marginBottom = '4px';
      el.textContent = msg;
      logsContainer.appendChild(el);
      logsContainer.scrollTop = logsContainer.scrollHeight;
    };
    
    appendLog(`📝 共识别到 ${emails.length} 个邮箱，开始处理...`, 'var(--blue)');
    
    for (let i = 0; i < emails.length; i++) {
      const email = emails[i];
      statusText.textContent = `${i + 1} / ${emails.length}`;
      progressBar.style.width = `${((i) / emails.length) * 100}%`;
      
      appendLog(`[${i+1}/${emails.length}] 正在分配并发送邀请 -> ${email} ...`, 'var(--text-secondary)');
      
      try {
        const res = await API.autoInvite(email);
        successCount++;
        appendLog(`   ✅ 成功: ${this.formatInviteResultMessage(res)}`, 'var(--green)');
      } catch (err) {
        failCount++;
        appendLog(`   ❌ 失败: ${err.message}`, 'var(--red)');
        
        if (err.message.includes('没有可用') || err.message.includes('均已满员')) {
          appendLog(`⚠️ 检测到无可用账号剩余，停止后续排队任务！`, 'var(--yellow)');
          break; // Stop completely to save time as no accounts are left
        }
      }
      
      // Delay to avoid strict rate limiting
      if (i < emails.length - 1) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    
    progressBar.style.width = '100%';
    statusText.textContent = `完成: 成功 ${successCount}, 失败 ${failCount}`;
    appendLog(`=============`, 'var(--text-secondary)');
    appendLog(`🎉 批量任务结束。成功: ${successCount}, 失败: ${failCount}`, 'var(--blue)');
    
    // UI clean up
    btnCancel.textContent = '完成 / 关闭';
    btnCancel.disabled = false;
    
    this.loadLogs();
    this.loadAccounts();
    this.loadStats();
  },

  async loadWorkspaceDashboard() {
    return this.runSingleFlight('workspace-dashboard', async () => {
      try {
        this.workspaceDashboard = await API.getWorkspaceDashboard();

        const alertsHost = document.getElementById('workspace-alerts-list');
        if (alertsHost) {
          const alerts = Array.isArray(this.workspaceDashboard.alerts) ? this.workspaceDashboard.alerts : [];
          alertsHost.innerHTML = alerts.length > 0
            ? alerts.map(item => Components.dashboardAlertItem(item)).join('')
            : '<div class="empty-state"><p>暂无预警</p></div>';
        }

        const failureHost = document.getElementById('failure-category-list');
        if (failureHost) {
          const failures = Array.isArray(this.workspaceDashboard.failure_categories) ? this.workspaceDashboard.failure_categories : [];
          failureHost.innerHTML = failures.length > 0
            ? failures.map(item => Components.failureCategoryItem(item)).join('')
            : '<div class="empty-state"><p>暂无失败统计</p></div>';
        }

        const summaryHost = document.getElementById('workspace-summary-grid');
        if (summaryHost) {
          const summary = this.workspaceDashboard.summary || {};
          summaryHost.innerHTML = [
            Components.workspaceSummaryCard('工作区总数', summary.total_workspaces || 0, 'neutral', '当前库内快照'),
            Components.workspaceSummaryCard('同步失败', summary.sync_errors || 0, (summary.sync_errors || 0) > 0 ? 'warning' : 'neutral', '需要优先排查'),
            Components.workspaceSummaryCard('余量充足', summary.healthy_quota || 0, 'success', '预占后仍剩 2 个以上'),
            Components.workspaceSummaryCard('接近满员', summary.warning_quota || 0, (summary.warning_quota || 0) > 0 ? 'warning' : 'neutral', '只剩 1 个'),
            Components.workspaceSummaryCard('刚好满员', summary.full_quota || 0, (summary.full_quota || 0) > 0 ? 'warning' : 'neutral', '没有剩余名额'),
            Components.workspaceSummaryCard('已经超额', summary.over_quota || 0, (summary.over_quota || 0) > 0 ? 'warning' : 'neutral', '待处理邀请已超出总额'),
          ].join('');
        }
      } catch (err) {
        console.error('Failed to load workspace dashboard:', err);
      }
    });
  },

  async loadWorkspaces(page = this.currentWorkspacesPage) {
    this.currentWorkspacesPage = page;
    const filters = this.getWorkspaceFilters();
    const params = { page, limit: 50, ...filters };
    const requestKey = `workspaces:${JSON.stringify(params)}`;

    return this.runSingleFlight(requestKey, async () => {
      try {
        const result = await API.getWorkspaces(params);

        const table = document.getElementById('workspaces-table');
        const tbody = document.getElementById('workspaces-tbody');
        const empty = document.getElementById('workspaces-empty');
        const pagination = document.getElementById('workspaces-pagination');
        if (!table || !tbody || !empty || !pagination) {
          return;
        }

        this.updateWorkspaceResultsMeta(result);

        if (!result.workspaces || result.workspaces.length === 0) {
          table.classList.add('hidden');
          empty.classList.remove('hidden');
          pagination.innerHTML = '';
        } else {
          table.classList.remove('hidden');
          empty.classList.add('hidden');
          tbody.innerHTML = result.workspaces.map(item => Components.workspaceRowWithEffectiveLock(item)).join('');
          this.renderWorkspacesPagination(result.total, result.page, result.limit);
        }
      } catch (err) {
        this.toast(`加载工作区失败: ${err.message}`, 'error');
      }
    });
  },

  renderWorkspacesPagination(total, currentPage, limit) {
    const totalPages = Math.ceil(total / limit);
    const container = document.getElementById('workspaces-pagination');
    if (!container) return;
    if (totalPages <= 1) {
      container.innerHTML = '';
      return;
    }

    let html = '';
    for (let i = 1; i <= totalPages; i++) {
      if (i === 1 || i === totalPages || (i >= currentPage - 2 && i <= currentPage + 2)) {
        html += `<button class="page-btn ${i === currentPage ? 'active' : ''}" onclick="App.loadWorkspaces(${i})">${i}</button>`;
      } else if (i === currentPage - 3 || i === currentPage + 3) {
        html += `<span class="page-dots">...</span>`;
      }
    }
    container.innerHTML = html;
  },

  async syncAllWorkspaces() {
    this.toast('正在同步全部工作区...', 'info');
    try {
      const result = await API.syncAllWorkspaces();
      const summary = result.summary || {};
      const removedCount = (result.results || [])
        .flatMap(item => item.results || [])
        .filter(item => item && item.removed)
        .length;
      this.toast(
        `工作区同步完成: 账号成功 ${summary.syncedAccounts || 0}/${summary.accountTotal || 0}，工作区成功 ${summary.syncedWorkspaces || 0}/${summary.workspaceTotal || 0}`,
        summary.failedAccounts || summary.failedWorkspaces ? 'warning' : 'success'
      );
      if (removedCount > 0) {
        this.toast(`已自动移除 ${removedCount} 个失效空间快照`, 'info');
      }
      await Promise.all([
        this.loadAccounts(this.currentAccountsPage),
        this.loadWorkspaces(this.currentWorkspacesPage),
        this.loadWorkspaceDashboard(),
        this.loadStats(),
      ]);
    } catch (err) {
      this.toast(`同步工作区失败: ${err.message}`, 'error');
    }
  },

  async syncWorkspace(id) {
    this.toast('正在同步这个工作区...', 'info');
    try {
      const result = await API.syncWorkspace(id);
      this.toast(
        `同步完成: ${result.workspaceName || result.workspaceId} => 成员 ${result.memberCount || 0} / 占位 ${result.occupiedSeats || 0} / 待接受 ${result.pendingInvites || 0}`,
        'success'
      );
      if (result.removed) {
        this.toast(`已自动移除失效空间快照: ${result.workspaceName || result.workspaceId || id}`, 'info');
      }
      await Promise.all([
        this.loadAccounts(this.currentAccountsPage),
        this.loadWorkspaces(this.currentWorkspacesPage),
        this.loadWorkspaceDashboard(),
        this.loadStats(),
        this.loadInvites(this.currentInvitesPage),
      ]);
    } catch (err) {
      this.toast(`同步工作区失败: ${err.message}`, 'error');
    }
  },

  async toggleWorkspaceInviteLock(id, inviteLocked) {
    const actionText = inviteLocked ? '锁定' : '解锁';
    try {
      const result = await API.setWorkspaceInviteLock(id, inviteLocked);
      this.toast(result.message || `${actionText}成功`, 'success');
      await this.refreshWorkspacesSurface();
      if (this.currentPage === 'audit' && this.auditData?.email) {
        await this.runAudit();
      }
    } catch (err) {
      this.toast(`${actionText}失败: ${err.message}`, 'error');
    }
  },

  exportWorkspace(id) {
    window.open(API.getWorkspaceExportUrl(id), '_blank');
  },

  async searchWorkspaceMembers() {
    const input = document.getElementById('workspace-member-search-input');
    const query = input ? input.value.trim() : '';
    const table = document.getElementById('workspace-member-search-table');
    const tbody = document.getElementById('workspace-member-search-tbody');
    const empty = document.getElementById('workspace-member-search-empty');
    if (!table || !tbody || !empty) return;

    if (!query) {
      table.classList.add('hidden');
      empty.classList.remove('hidden');
      empty.innerHTML = '<p>输入关键词后开始搜索</p>';
      return;
    }

    try {
      const result = await API.searchWorkspaceMembers(query);
      const items = Array.isArray(result.items) ? result.items : [];
      if (items.length === 0) {
        table.classList.add('hidden');
        empty.classList.remove('hidden');
        empty.innerHTML = '<p>没有匹配的成员</p>';
        return;
      }

      table.classList.remove('hidden');
      empty.classList.add('hidden');
      tbody.innerHTML = items.map(item => Components.memberSearchRow(item)).join('');
    } catch (err) {
      this.toast(`搜索成员失败: ${err.message}`, 'error');
    }
  },

  renderAudit() {
    const summaryHost = document.getElementById('audit-summary');
    const recommendTable = document.getElementById('audit-recommendation-table');
    const recommendBody = document.getElementById('audit-recommendation-tbody');
    const recommendEmpty = document.getElementById('audit-recommendation-empty');
    const presenceHost = document.getElementById('audit-presence-list');
    const historyTable = document.getElementById('audit-history-table');
    const historyBody = document.getElementById('audit-history-tbody');
    const historyEmpty = document.getElementById('audit-history-empty');

    if (!summaryHost || !recommendTable || !recommendBody || !recommendEmpty || !presenceHost || !historyTable || !historyBody || !historyEmpty) {
      return;
    }

    if (!this.auditData) {
      summaryHost.innerHTML = '';
      recommendTable.classList.add('hidden');
      recommendEmpty.classList.remove('hidden');
      presenceHost.innerHTML = '<div class="empty-state"><p>暂无数据</p></div>';
      historyTable.classList.add('hidden');
      historyEmpty.classList.remove('hidden');
      this.updateAuditBulkKickButton();
      return;
    }

    const summary = this.auditData.summary || {};
    this.updateAuditBulkKickButton();
    summaryHost.innerHTML = `
      <div class="quota-overview-card"><span class="quota-overview-label">成员</span><strong class="quota-overview-value">${summary.memberships || 0}</strong></div>
      <div class="quota-overview-card"><span class="quota-overview-label">待邀请</span><strong class="quota-overview-value">${summary.pending || 0}</strong></div>
      <div class="quota-overview-card"><span class="quota-overview-label">历史记录</span><strong class="quota-overview-value">${summary.history || 0}</strong></div>
    `;

    const filters = this.getAuditFilters();
    const recommendations = (Array.isArray(this.auditData.recommendations) ? this.auditData.recommendations : [])
      .filter(item => filters.recommendation === 'all' || item.recommendation_state === filters.recommendation);
    if (recommendations.length > 0) {
      recommendTable.classList.remove('hidden');
      recommendEmpty.classList.add('hidden');
      recommendBody.innerHTML = recommendations.map(item => Components.recommendationRowWithEffectiveLock(item)).join('');
    } else {
      recommendTable.classList.add('hidden');
      recommendEmpty.classList.remove('hidden');
    }

    const memberships = Array.isArray(this.auditData.memberships) ? this.auditData.memberships : [];
    const pendingInvites = Array.isArray(this.auditData.pending_invites) ? this.auditData.pending_invites : [];
    const presenceItems = [
      ...memberships.map(item => ({
        ...item,
        kind: 'member',
        title: item.workspace_name || item.workspace_id,
        detail: `${item.account_email || ''} · 成员 · ${Components.memberRoleLabel(item.role)}`,
      })),
      ...pendingInvites.map(item => ({
        ...item,
        kind: 'pending',
        title: item.workspace_name || item.workspace_id,
        detail: `${item.account_email || ''} · 待邀请`,
      })),
    ].filter(item => filters.presence === 'all' || item.kind === filters.presence);
    presenceHost.innerHTML = presenceItems.length > 0
      ? presenceItems.map(item => Components.auditPresenceCard(item)).join('')
      : '<div class="empty-state"><p>这个邮箱当前没有成员或待邀请记录</p></div>';

    const inviteHistory = (Array.isArray(this.auditData.invite_history) ? this.auditData.invite_history : [])
      .filter(item => {
        if (filters.history === 'all') return true;
        if (['member', 'pending', 'missing'].includes(filters.history)) {
          return item.remote_state === filters.history;
        }
        return item.status === filters.history;
      });
    if (inviteHistory.length > 0) {
      historyTable.classList.remove('hidden');
      historyEmpty.classList.add('hidden');
      historyBody.innerHTML = inviteHistory.map(item => `
        <tr>
          <td>${Components.escapeHtml(item.account_email || '')}</td>
          <td>${Components.escapeHtml(item.workspace_name || item.workspace_id || '默认工作区')}</td>
          <td>${Components.statusBadge(item.status)}</td>
          <td>${Components.quotaPill(Components.inviteRemoteStateLabel(item.remote_state), item.remote_state === 'missing' ? 'warning' : 'neutral')}</td>
          <td>${Components.timeAgo(item.created_at)}</td>
        </tr>
      `).join('');
    } else {
      historyTable.classList.add('hidden');
      historyEmpty.classList.remove('hidden');
    }
  },

  async runEmailAudit(options = {}) {
    const input = document.getElementById('audit-email-input');
    const email = String(options.email || (input ? input.value.trim() : '')).trim();
    if (!email) {
      if (!options.silent) {
        this.toast('请输入要审计的邮箱', 'warning');
      }
      return;
    }

    try {
      if (input && input.value.trim() !== email) {
        input.value = email;
      }
      if (!options.silent) {
        this.toast(`正在审计 ${email} ...`, 'info');
      }
      this.auditData = await API.getEmailAudit(email);
      this.renderAudit();
      const recommendations = this.auditData.recommendations || [];
      if (!options.silent) {
        this.toast(`审计完成，共找到 ${recommendations.length} 个候选工作区`, 'success');
      }
    } catch (err) {
      if (!options.silent) {
        this.toast(`邮箱审计失败: ${err.message}`, 'error');
      }
    }
  },

  makeBatchAuditSelectionKey(item) {
    return `${Number(item.account_id || 0)}::${Number(item.workspace_row_id || 0)}::${String(item.user_id || '')}`;
  },

  normalizeBatchAuditData(data) {
    const memberships = (Array.isArray(data?.memberships) ? data.memberships : []).map(item => ({
      ...item,
      selection_key: this.makeBatchAuditSelectionKey(item),
    }));

    return {
      ...data,
      memberships,
      pending_invites: Array.isArray(data?.pending_invites) ? data.pending_invites : [],
      invite_history: Array.isArray(data?.invite_history) ? data.invite_history : [],
      email_summaries: Array.isArray(data?.email_summaries) ? data.email_summaries : [],
      emails: Array.isArray(data?.emails) ? data.emails : [],
    };
  },

  parseBatchAuditEmails() {
    const textarea = document.getElementById('batch-audit-emails');
    const raw = textarea ? textarea.value : '';
    return Array.from(new Set(
      String(raw || '')
        .split(/[\r\n,;]+/)
        .map(item => item.trim().toLowerCase())
        .filter(Boolean)
    ));
  },

  openBatchAuditModal() {
    this.batchAuditSelection = new Set();
    this.batchAuditProgress = null;
    const preset = this.auditData?.email || document.getElementById('audit-email-input')?.value.trim() || '';
    this.showModal('批量邮箱审计', Components.batchAuditModal(preset), { wide: true, type: 'batch-audit' });
    this.renderBatchAuditResults();

    const btnRun = document.getElementById('btn-run-batch-audit-modal');
    if (btnRun) {
      btnRun.addEventListener('click', () => {
        this.runBatchAudit();
      });
    }

    const btnSelectAll = document.getElementById('btn-batch-audit-select-all');
    if (btnSelectAll) {
      btnSelectAll.addEventListener('click', () => {
        this.toggleBatchAuditSelectAll(true);
      });
    }

    const btnRemoveSelected = document.getElementById('btn-batch-audit-remove-selected');
    if (btnRemoveSelected) {
      btnRemoveSelected.addEventListener('click', () => {
        this.removeSelectedBatchAuditMembers();
      });
    }
  },

  renderBatchAuditResults() {
    const host = document.getElementById('batch-audit-results');
    if (!host) {
      return;
    }

    host.innerHTML = Components.batchAuditResults(this.batchAuditData, this.batchAuditSelection, this.batchAuditProgress);

    const removable = (Array.isArray(this.batchAuditData?.memberships) ? this.batchAuditData.memberships : [])
      .filter(item => !item.is_owner && item.account_id && item.user_id);
    const selectedCount = removable.filter(item => this.batchAuditSelection.has(item.selection_key)).length;
    const isRunning = Boolean(this.batchAuditProgress?.active);

    const btnSelectAll = document.getElementById('btn-batch-audit-select-all');
    if (btnSelectAll) {
      btnSelectAll.disabled = removable.length === 0 || isRunning;
      btnSelectAll.innerHTML = `<span>全选可踢${removable.length > 0 ? ` (${removable.length})` : ''}</span>`;
    }

    const btnRemoveSelected = document.getElementById('btn-batch-audit-remove-selected');
    if (btnRemoveSelected) {
      btnRemoveSelected.disabled = selectedCount === 0 || isRunning;
      btnRemoveSelected.innerHTML = `<span>踢出已选${selectedCount > 0 ? ` (${selectedCount})` : ''}</span>`;
    }
  },

  toggleBatchAuditSelection(key, checked) {
    if (!key) {
      return;
    }

    if (checked) {
      this.batchAuditSelection.add(key);
    } else {
      this.batchAuditSelection.delete(key);
    }

    this.renderBatchAuditResults();
  },

  toggleBatchAuditSelectAll(checked) {
    const removable = (Array.isArray(this.batchAuditData?.memberships) ? this.batchAuditData.memberships : [])
      .filter(item => !item.is_owner && item.account_id && item.user_id);

    if (checked) {
      removable.forEach(item => this.batchAuditSelection.add(item.selection_key));
    } else {
      removable.forEach(item => this.batchAuditSelection.delete(item.selection_key));
    }

    this.renderBatchAuditResults();
  },

  async runBatchAudit() {
    const emails = this.parseBatchAuditEmails();
    if (emails.length === 0) {
      this.toast('请先输入至少一个邮箱', 'warning');
      return;
    }

    const btnRun = document.getElementById('btn-run-batch-audit-modal');
    if (btnRun) {
      btnRun.disabled = true;
      btnRun.classList.add('loading');
    }

    try {
      const result = await API.batchEmailAudit(emails);
      this.batchAuditSelection = new Set();
      this.batchAuditProgress = null;
      this.batchAuditData = this.normalizeBatchAuditData(result);
      this.renderBatchAuditResults();
      this.toast(`批量审计完成，共 ${emails.length} 个邮箱`, 'success');
    } catch (err) {
      this.toast(`批量邮箱审计失败: ${err.message}`, 'error');
    } finally {
      if (btnRun) {
        btnRun.disabled = false;
        btnRun.classList.remove('loading');
      }
    }
  },

  async removeSelectedBatchAuditMembers() {
    const selectedMembers = (Array.isArray(this.batchAuditData?.memberships) ? this.batchAuditData.memberships : [])
      .filter(item => this.batchAuditSelection.has(item.selection_key))
      .filter(item => !item.is_owner && item.account_id && item.user_id);

    if (selectedMembers.length === 0) {
      this.toast('请先勾选要踢出的成员', 'warning');
      return;
    }

    if (!confirm(`确定批量踢出已选中的 ${selectedMembers.length} 个成员吗？`)) {
      return;
    }

    const btn = document.getElementById('btn-batch-audit-remove-selected');
    if (btn) {
      btn.disabled = true;
      btn.classList.add('loading');
    }

    let successCount = 0;
    const failed = [];
    const workspaceRowsToSync = new Set();
    this.batchAuditProgress = {
      active: true,
      phase: 'removing',
      total: selectedMembers.length,
      completed: 0,
      success: 0,
      failed: 0,
      current: '',
      sync_total: 0,
      sync_completed: 0,
    };
    this.renderBatchAuditResults();

    try {
      for (const member of selectedMembers) {
        this.batchAuditProgress.current = `${member.email || member.user_id} · ${member.workspace_name || member.workspace_id || ''}`;
        this.renderBatchAuditResults();

        try {
          await API.removeMember(member.account_id, member.user_id, {
            workspace_id: member.workspace_id,
            workspace_name: member.workspace_name || member.workspace_id,
            plan_type: member.plan_type || '',
            skip_sync: '1',
          });

          if (member.workspace_row_id) {
            workspaceRowsToSync.add(Number(member.workspace_row_id));
          }

          successCount += 1;
          this.batchAuditProgress.success = successCount;
        } catch (err) {
          failed.push(`${member.email || member.user_id}: ${err.message}`);
          this.batchAuditProgress.failed = failed.length;
        }

        this.batchAuditProgress.completed += 1;
        this.renderBatchAuditResults();
      }

      const workspaceRows = Array.from(workspaceRowsToSync).filter(Boolean);
      this.batchAuditProgress.phase = 'syncing';
      this.batchAuditProgress.sync_total = workspaceRows.length;
      this.batchAuditProgress.sync_completed = 0;
      this.batchAuditProgress.current = workspaceRows.length > 0 ? '正在同步工作区...' : '正在刷新结果...';
      this.renderBatchAuditResults();

      for (const workspaceRowId of workspaceRows) {
        await API.syncWorkspace(workspaceRowId).catch(err => {
          console.warn('Failed to sync workspace after batch-audit removal:', err);
        });
        this.batchAuditProgress.sync_completed += 1;
        this.renderBatchAuditResults();
      }

      if (this.batchAuditData?.emails?.length) {
        const refreshed = await API.batchEmailAudit(this.batchAuditData.emails);
        this.batchAuditData = this.normalizeBatchAuditData(refreshed);
      }
      this.batchAuditSelection = new Set();
      this.renderBatchAuditResults();

      await Promise.all([
        this.loadAccounts(this.currentAccountsPage),
        this.loadStats(),
        this.loadWorkspaces(this.currentWorkspacesPage),
        this.loadWorkspaceDashboard(),
      ]);

      this.batchAuditProgress = {
        ...this.batchAuditProgress,
        active: false,
        phase: 'done',
        current: failed.length === 0 ? '批量踢人完成' : '批量踢人已完成，存在失败项',
      };
      this.renderBatchAuditResults();

      if (failed.length === 0) {
        this.toast(`批量踢人完成，成功 ${successCount} 个`, 'success');
      } else {
        this.toast(`批量踢人完成，成功 ${successCount} 个，失败 ${failed.length} 个`, 'warning');
        console.warn('Batch audit selected removals failed:', failed);
      }
    } catch (err) {
      this.batchAuditProgress = {
        ...(this.batchAuditProgress || {}),
        active: false,
        phase: 'error',
        current: `批量踢人中断: ${err.message}`,
      };
      this.toast(`批量踢人失败: ${err.message}`, 'error');
    } finally {
      if (btn) {
        btn.classList.remove('loading');
      }
      this.renderBatchAuditResults();
    }
  },

  async removeAuditMember(accountId, userId, workspaceId = '', workspaceName = '', planType = '', memberEmail = '', workspaceRowId = 0) {
    const label = memberEmail || userId;
    const workspaceLabel = workspaceName || workspaceId || '当前工作区';
    if (!confirm(`确定要把 ${label} 从 ${workspaceLabel} 踢出去吗？`)) {
      return;
    }

    try {
      await API.removeMember(accountId, userId, {
        workspace_id: workspaceId,
        workspace_name: workspaceName,
        plan_type: planType,
      });

      if (workspaceRowId) {
        await API.syncWorkspace(workspaceRowId).catch(err => {
          console.warn('Failed to sync workspace after audit removal:', err);
        });
      }

      this.toast(`已移出 ${label}`, 'success');

      await Promise.all([
        this.runEmailAudit({ email: this.auditData?.email || memberEmail, silent: true }),
        this.loadAccounts(this.currentAccountsPage),
        this.loadStats(),
        this.loadWorkspaces(this.currentWorkspacesPage),
        this.loadWorkspaceDashboard(),
      ]);
    } catch (err) {
      this.toast(`审计页踢人失败: ${err.message}`, 'error');
    }
  },

  async removeAuditMembersBatch() {
    const email = this.auditData?.email || document.getElementById('audit-email-input')?.value.trim() || '';
    const members = (Array.isArray(this.auditData?.memberships) ? this.auditData.memberships : [])
      .filter(item => !item.is_owner && item.account_id && item.user_id);

    if (!email) {
      this.toast('请先搜索一个邮箱', 'warning');
      return;
    }

    if (totalSelected === 0) {
      this.toast('当前没有可批量踢出的成员', 'warning');
      return;
    }

    if (!confirm(`确定批量踢出 ${email} 在 ${members.length} 个工作区中的成员身份吗？`)) {
      return;
    }

    const button = document.getElementById('btn-audit-bulk-remove');
    if (button) {
      button.disabled = true;
      button.classList.add('loading');
    }

    let successCount = 0;
    const failed = [];

    try {
      for (const member of members) {
        try {
          await API.removeMember(member.account_id, member.user_id, {
            workspace_id: member.workspace_id,
            workspace_name: member.workspace_name || member.workspace_id,
            plan_type: member.plan_type || '',
          });

          if (member.workspace_row_id) {
            await API.syncWorkspace(member.workspace_row_id).catch(err => {
              console.warn('Failed to sync workspace after bulk audit removal:', err);
            });
          }

          successCount += 1;
        } catch (err) {
          failed.push(`${member.workspace_name || member.workspace_id}: ${err.message}`);
        }
      }

      await Promise.all([
        this.runEmailAudit({ email, silent: true }),
        this.loadAccounts(this.currentAccountsPage),
        this.loadStats(),
        this.loadWorkspaces(this.currentWorkspacesPage),
        this.loadWorkspaceDashboard(),
      ]);

      if (failed.length === 0) {
        this.toast(`批量踢人完成，成功 ${successCount} 个`, 'success');
      } else {
        this.toast(`批量踢人完成，成功 ${successCount} 个，失败 ${failed.length} 个`, 'warning');
        console.warn('Bulk audit removal failures:', failed);
      }
    } finally {
      if (button) {
        button.classList.remove('loading');
      }
      this.updateAuditBulkKickButton();
    }
  },

  getMemberCleanupFilters() {
    return {
      search: document.getElementById('member-cleanup-search-input')?.value.trim() || '',
      item_type: document.getElementById('member-cleanup-type-filter')?.value || 'all',
      date: document.getElementById('member-cleanup-date-filter')?.value || '',
      age_filter: document.getElementById('member-cleanup-age-filter')?.value || '',
    };
  },

  makeMemberCleanupSelectionKey(item) {
    return [
      String(item?.item_type || ''),
      Number(item?.account_id || 0),
      String(item?.workspace_id || ''),
      String(item?.user_id || item?.remote_invite_id || item?.email || ''),
    ].join('::');
  },

  normalizeMemberCleanupData(data) {
    const items = (Array.isArray(data?.items) ? data.items : []).map(item => ({
      ...item,
      selection_key: this.makeMemberCleanupSelectionKey(item),
    }));

    return {
      ...data,
      items,
      summary: data?.summary || {},
      filters: data?.filters || {},
    };
  },

  updateMemberCleanupActionButtons() {
    const meta = document.getElementById('member-cleanup-meta');
    const btnSelectAll = document.getElementById('btn-member-cleanup-select-all');
    const btnClear = document.getElementById('btn-member-cleanup-clear-selection');
    const btnKick = document.getElementById('btn-member-cleanup-kick-selected');
    const btnRevoke = document.getElementById('btn-member-cleanup-revoke-selected');

    const items = Array.isArray(this.memberCleanupData?.items) ? this.memberCleanupData.items : [];
    const selectableItems = items.filter(item => (
      (item.item_type === 'member' && !item.is_owner && item.account_id && item.user_id) ||
      (item.item_type === 'pending' && item.account_id && item.email)
    ));
    const selectedItems = items.filter(item => this.memberCleanupSelection.has(item.selection_key));
    const selectedMembers = selectedItems.filter(item => item.item_type === 'member' && !item.is_owner && item.account_id && item.user_id);
    const selectedPending = selectedItems.filter(item => item.item_type === 'pending' && item.account_id && item.email);
    const allSelected = selectableItems.length > 0 && selectedItems.length === selectableItems.length;

    if (meta) {
      if (this.memberCleanupLoading && !this.memberCleanupData) {
        meta.textContent = '正在读取成员与待邀请...';
      } else {
        meta.textContent = `当前 ${items.length} 条 · 成员 ${items.filter(item => item.item_type === 'member').length} · 待邀请 ${items.filter(item => item.item_type === 'pending').length} · 已选 ${selectedItems.length}`;
      }
    }

    if (btnSelectAll) {
      btnSelectAll.disabled = selectableItems.length === 0;
      btnSelectAll.innerHTML = `<span>${allSelected ? '取消全选' : `全选当前筛选${selectableItems.length > 0 ? ` (${selectableItems.length})` : ''}`}</span>`;
    }
    if (btnClear) {
      btnClear.disabled = this.memberCleanupSelection.size === 0;
    }
    if (btnKick) {
      btnKick.disabled = selectedMembers.length === 0;
      btnKick.innerHTML = `<span>一键踢人${selectedMembers.length > 0 ? ` (${selectedMembers.length})` : ''}</span>`;
    }
    if (btnRevoke) {
      btnRevoke.disabled = selectedPending.length === 0;
      btnRevoke.innerHTML = `<span>撤销待邀请${selectedPending.length > 0 ? ` (${selectedPending.length})` : ''}</span>`;
    }
  },

  renderMemberCleanup() {
    const summaryHost = document.getElementById('member-cleanup-summary');
    const table = document.getElementById('member-cleanup-table');
    const tbody = document.getElementById('member-cleanup-tbody');
    const empty = document.getElementById('member-cleanup-empty');

    if (!summaryHost || !table || !tbody || !empty) {
      return;
    }

    if (this.memberCleanupLoading && !this.memberCleanupData) {
      summaryHost.innerHTML = '';
      table.classList.add('hidden');
      empty.classList.remove('hidden');
      empty.innerHTML = '<p>正在读取成员与待邀请...</p>';
      this.updateMemberCleanupActionButtons();
      return;
    }

    if (!this.memberCleanupData) {
      summaryHost.innerHTML = '';
      table.classList.add('hidden');
      empty.classList.remove('hidden');
      empty.innerHTML = '<p>暂无成员快照，请先同步工作区</p>';
      this.updateMemberCleanupActionButtons();
      return;
    }

    const summary = this.memberCleanupData.summary || {};
    summaryHost.innerHTML = [
      Components.workspaceSummaryCard('当前记录', summary.total || 0, 'neutral', '当前筛选结果'),
      Components.workspaceSummaryCard('成员', summary.members || 0, (summary.members || 0) > 0 ? 'accent' : 'neutral', '已在工作区中的成员'),
      Components.workspaceSummaryCard('待邀请', summary.pending || 0, (summary.pending || 0) > 0 ? 'warning' : 'neutral', '尚未接受的邀请'),
      Components.workspaceSummaryCard('可踢成员', summary.removable_members || 0, (summary.removable_members || 0) > 0 ? 'danger' : 'neutral', '所有者已自动排除'),
      Components.workspaceSummaryCard('可撤销', summary.revocable_pending || 0, (summary.revocable_pending || 0) > 0 ? 'warning' : 'neutral', '待邀请可直接撤销'),
    ].join('');

    const items = Array.isArray(this.memberCleanupData.items) ? this.memberCleanupData.items : [];
    if (items.length === 0) {
      table.classList.add('hidden');
      empty.classList.remove('hidden');
      empty.innerHTML = '<p>当前筛选下没有成员或待邀请</p>';
      tbody.innerHTML = '';
      this.updateMemberCleanupActionButtons();
      return;
    }

    table.classList.remove('hidden');
    empty.classList.add('hidden');
    tbody.innerHTML = items.map(item => Components.memberCleanupRow(item, this.memberCleanupSelection.has(item.selection_key))).join('');
    this.updateMemberCleanupActionButtons();
  },

  async loadMemberCleanup(options = {}) {
    const filters = this.getMemberCleanupFilters();
    const requestKey = `member-cleanup:${JSON.stringify(filters)}`;
    this.memberCleanupLoading = true;
    this.renderMemberCleanup();

    return this.runSingleFlight(requestKey, async () => {
      try {
        const result = await API.getMemberCleanup(filters);
        this.memberCleanupData = this.normalizeMemberCleanupData(result);
        const validKeys = new Set(this.memberCleanupData.items.map(item => item.selection_key));
        this.memberCleanupSelection = new Set(
          [...this.memberCleanupSelection].filter(key => validKeys.has(key))
        );
      } catch (err) {
        console.error('Failed to load member cleanup data:', err);
        this.memberCleanupData = null;
        if (!options.silent) {
          this.toast(`成员清理列表加载失败: ${err.message}`, 'error');
        }
      } finally {
        this.memberCleanupLoading = false;
        this.renderMemberCleanup();
      }
    });
  },

  getUntrackedMembersFilters() {
    return {
      search: document.getElementById('untracked-members-search-input')?.value.trim() || '',
    };
  },

  makeUntrackedMembersSelectionKey(item) {
    return [
      String(item?.item_type || 'member'),
      Number(item?.account_id || 0),
      String(item?.workspace_id || ''),
      String(item?.user_id || item?.email || ''),
    ].join('::');
  },

  normalizeUntrackedMembersData(data) {
    const items = (Array.isArray(data?.items) ? data.items : []).map(item => ({
      ...item,
      selection_key: this.makeUntrackedMembersSelectionKey(item),
    }));

    return {
      ...data,
      items,
      summary: data?.summary || {},
      filters: data?.filters || {},
    };
  },

  updateUntrackedMembersActionButtons() {
    const meta = document.getElementById('untracked-members-meta');
    const btnSelectAll = document.getElementById('btn-untracked-members-select-all');
    const btnClear = document.getElementById('btn-untracked-members-clear-selection');
    const btnKick = document.getElementById('btn-untracked-members-kick-selected');
    const items = Array.isArray(this.untrackedMembersData?.items) ? this.untrackedMembersData.items : [];
    const selectableItems = items.filter(item => (
      (item.item_type === 'pending' && item.account_id && item.email) ||
      (item.item_type !== 'pending' && !Number(item.is_owner || 0) && item.account_id && item.user_id)
    ));
    const selectedItems = items.filter(item => this.untrackedMembersSelection.has(item.selection_key));
    const allSelected = selectableItems.length > 0 && selectableItems.every(item => this.untrackedMembersSelection.has(item.selection_key));

    if (meta) {
      if (this.untrackedMembersLoading && !this.untrackedMembersData) {
        meta.textContent = '正在读取没有来源记录的成员...';
      } else {
        meta.textContent = `当前 ${items.length} 条没有来源记录的成员 · 可踢出 ${selectableItems.length} · 已选 ${selectedItems.length}`;
      }
    }

    if (btnSelectAll) {
      btnSelectAll.disabled = selectableItems.length === 0;
      btnSelectAll.innerHTML = `<span>${allSelected ? '取消全选' : `全选当前筛选${selectableItems.length > 0 ? ` (${selectableItems.length})` : ''}`}</span>`;
    }
    if (btnClear) {
      btnClear.disabled = this.untrackedMembersSelection.size === 0;
    }
    if (btnKick) {
      btnKick.disabled = selectedItems.length === 0;
      btnKick.innerHTML = `<span>踢出已选${selectedItems.length > 0 ? ` (${selectedItems.length})` : ''}</span>`;
    }
  },

  renderUntrackedMembers() {
    const summaryHost = document.getElementById('untracked-members-summary');
    const table = document.getElementById('untracked-members-table');
    const tbody = document.getElementById('untracked-members-tbody');
    const empty = document.getElementById('untracked-members-empty');
    const meta = document.getElementById('untracked-members-meta');

    if (!summaryHost || !table || !tbody || !empty) {
      return;
    }

    if (this.untrackedMembersLoading && !this.untrackedMembersData) {
      summaryHost.innerHTML = '';
      table.classList.add('hidden');
      empty.classList.remove('hidden');
      empty.innerHTML = '<p>正在读取没有来源记录的成员...</p>';
      if (meta) meta.textContent = '正在读取没有来源记录的成员...';
      return;
    }

    if (!this.untrackedMembersData) {
      summaryHost.innerHTML = '';
      table.classList.add('hidden');
      empty.classList.remove('hidden');
      empty.innerHTML = '<p>暂无数据，请先同步工作区</p>';
      if (meta) meta.textContent = '暂无没有来源记录的数据';
      return;
    }

    const summary = this.untrackedMembersData.summary || {};
    const items = Array.isArray(this.untrackedMembersData.items) ? this.untrackedMembersData.items : [];

    summaryHost.innerHTML = [
      Components.workspaceSummaryCard('没有来源记录', summary.total || items.length || 0, (summary.total || items.length || 0) > 0 ? 'warning' : 'success', '未匹配到来源的成员'),
      Components.workspaceSummaryCard('涉及工作区', summary.workspaces || 0, (summary.workspaces || 0) > 0 ? 'accent' : 'neutral', '按工作区去重'),
      Components.workspaceSummaryCard('涉及账号', summary.accounts || 0, (summary.accounts || 0) > 0 ? 'accent' : 'neutral', '按所属账号去重'),
    ].join('');

    if (meta) {
      meta.textContent = `当前 ${items.length} 条没有来源记录的成员`;
    }

    if (items.length === 0) {
      table.classList.add('hidden');
      empty.classList.remove('hidden');
      empty.innerHTML = '<p>当前没有发现无来源记录的成员</p>';
      tbody.innerHTML = '';
      return;
    }

    table.classList.remove('hidden');
    empty.classList.add('hidden');
    tbody.innerHTML = items.map(item => Components.untrackedMemberRow(item)).join('');
  },

  async loadUntrackedMembers(options = {}) {
    const filters = this.getUntrackedMembersFilters();
    const requestKey = `untracked-members:${JSON.stringify(filters)}`;
    this.untrackedMembersLoading = true;
    this.renderUntrackedMembers();

    return this.runSingleFlight(requestKey, async () => {
      try {
        this.untrackedMembersData = await API.getUntrackedMembers(filters);
      } catch (err) {
        console.error('Failed to load untracked members:', err);
        this.untrackedMembersData = null;
        if (!options.silent) {
          this.toast(`没有记录来源列表加载失败: ${err.message}`, 'error');
        }
      } finally {
        this.untrackedMembersLoading = false;
        this.renderUntrackedMembers();
      }
    });
  },

  renderUntrackedMembers() {
    const summaryHost = document.getElementById('untracked-members-summary');
    const table = document.getElementById('untracked-members-table');
    const tbody = document.getElementById('untracked-members-tbody');
    const empty = document.getElementById('untracked-members-empty');

    if (!summaryHost || !table || !tbody || !empty) {
      return;
    }

    if (this.untrackedMembersLoading && !this.untrackedMembersData) {
      summaryHost.innerHTML = '';
      table.classList.add('hidden');
      empty.classList.remove('hidden');
      empty.innerHTML = '<p>正在读取没有来源记录的成员...</p>';
      this.updateUntrackedMembersActionButtons();
      return;
    }

    if (!this.untrackedMembersData) {
      summaryHost.innerHTML = '';
      table.classList.add('hidden');
      empty.classList.remove('hidden');
      empty.innerHTML = '<p>暂无数据，请先同步工作区</p>';
      this.updateUntrackedMembersActionButtons();
      return;
    }

    const summary = this.untrackedMembersData.summary || {};
    const items = Array.isArray(this.untrackedMembersData.items) ? this.untrackedMembersData.items : [];
    const total = summary.total || items.length || 0;

    summaryHost.innerHTML = [
      Components.workspaceSummaryCard('没有来源记录', total, total > 0 ? 'warning' : 'success', '未匹配到来源的成员'),
      Components.workspaceSummaryCard('可踢出成员', summary.removable_members || 0, (summary.removable_members || 0) > 0 ? 'danger' : 'neutral', '已自动排除所有者'),
      Components.workspaceSummaryCard('涉及工作区', summary.workspaces || 0, (summary.workspaces || 0) > 0 ? 'accent' : 'neutral', '按工作区去重'),
      Components.workspaceSummaryCard('涉及账号', summary.accounts || 0, (summary.accounts || 0) > 0 ? 'accent' : 'neutral', '按所属账号去重'),
    ].join('');

    if (items.length === 0) {
      table.classList.add('hidden');
      empty.classList.remove('hidden');
      empty.innerHTML = '<p>当前没有发现无来源记录的成员</p>';
      tbody.innerHTML = '';
      this.updateUntrackedMembersActionButtons();
      return;
    }

    table.classList.remove('hidden');
    empty.classList.add('hidden');
    tbody.innerHTML = items
      .map(item => Components.untrackedMemberRow(item, this.untrackedMembersSelection.has(item.selection_key)))
      .join('');
    this.updateUntrackedMembersActionButtons();
  },

  async loadUntrackedMembers(options = {}) {
    const filters = this.getUntrackedMembersFilters();
    const requestKey = `untracked-members:${JSON.stringify(filters)}`;
    this.untrackedMembersLoading = true;
    this.renderUntrackedMembers();

    return this.runSingleFlight(requestKey, async () => {
      try {
        this.untrackedMembersData = this.normalizeUntrackedMembersData(await API.getUntrackedMembers(filters));
        const validKeys = new Set(this.untrackedMembersData.items.map(item => item.selection_key));
        this.untrackedMembersSelection = new Set(
          [...this.untrackedMembersSelection].filter(key => validKeys.has(key))
        );
      } catch (err) {
        console.error('Failed to load untracked members:', err);
        this.untrackedMembersData = null;
        if (!options.silent) {
          this.toast(`没有记录来源列表加载失败: ${err.message}`, 'error');
        }
      } finally {
        this.untrackedMembersLoading = false;
        this.renderUntrackedMembers();
      }
    });
  },

  toggleUntrackedMembersSelection(key, checked) {
    if (!key) {
      return;
    }

    if (checked) {
      this.untrackedMembersSelection.add(key);
    } else {
      this.untrackedMembersSelection.delete(key);
    }

    this.renderUntrackedMembers();
  },

  toggleUntrackedMembersSelectAll() {
    const items = (Array.isArray(this.untrackedMembersData?.items) ? this.untrackedMembersData.items : [])
      .filter(item => (
        (item.item_type === 'pending' && item.account_id && item.email) ||
        (item.item_type !== 'pending' && !Number(item.is_owner || 0) && item.account_id && item.user_id)
      ));

    const allSelected = items.length > 0 && items.every(item => this.untrackedMembersSelection.has(item.selection_key));
    if (allSelected) {
      items.forEach(item => this.untrackedMembersSelection.delete(item.selection_key));
    } else {
      items.forEach(item => this.untrackedMembersSelection.add(item.selection_key));
    }

    this.renderUntrackedMembers();
  },

  clearUntrackedMembersSelection() {
    this.untrackedMembersSelection = new Set();
    this.renderUntrackedMembers();
  },

  async refreshUntrackedMembersSurfaces(workspaceRowIds = []) {
    await this.syncMemberCleanupWorkspaces(workspaceRowIds);
    await Promise.all([
      this.loadUntrackedMembers({ silent: true }),
      this.loadAccounts(this.currentAccountsPage),
      this.loadStats(),
      this.loadWorkspaces(this.currentWorkspacesPage),
      this.loadWorkspaceDashboard(),
    ]);
  },

  async removeUntrackedMemberItem(accountId, userId, workspaceId = '', workspaceName = '', planType = '', memberEmail = '', workspaceRowId = 0) {
    const label = memberEmail || userId;
    const workspaceLabel = workspaceName || workspaceId || '当前工作区';
    if (!confirm(`确定要把 ${label} 从 ${workspaceLabel} 踢出吗？`)) {
      return;
    }

    try {
      await API.removeMember(accountId, userId, {
        workspace_id: workspaceId,
        workspace_name: workspaceName,
        plan_type: planType,
        skip_sync: '1',
      });
      this.untrackedMembersSelection = new Set();
      this.toast(`已移出 ${label}`, 'success');
      await this.refreshUntrackedMembersSurfaces([workspaceRowId]);
    } catch (err) {
      this.toast(`踢出成员失败: ${err.message}`, 'error');
    }
  },

  async revokeUntrackedPendingInvite(accountId, email, workspaceId = '', workspaceName = '', planType = '', workspaceRowId = 0, remoteInviteId = '') {
    const label = email || remoteInviteId;
    const workspaceLabel = workspaceName || workspaceId || 'current workspace';
    if (!confirm(`确认撤销 ${workspaceLabel} 里的无来源待邀请 ${label} 吗？`)) {
      return;
    }

    try {
      await API.revokePendingInvite(accountId, {
        email,
        remote_invite_id: remoteInviteId,
        workspace_id: workspaceId,
        workspace_name: workspaceName,
        plan_type: planType,
        skip_sync: '1',
      });
      this.untrackedMembersSelection = new Set();
      this.toast(`已撤销 ${label} 的待邀请`, 'success');
      await this.refreshUntrackedMembersSurfaces([workspaceRowId]);
    } catch (err) {
      this.toast(`撤销待邀请失败: ${err.message}`, 'error');
    }
  },

  async removeSelectedUntrackedMembers() {
    const selectedItems = (Array.isArray(this.untrackedMembersData?.items) ? this.untrackedMembersData.items : [])
      .filter(item => this.untrackedMembersSelection.has(item.selection_key));
    const members = selectedItems
      .filter(item => item.item_type !== 'pending' && !Number(item.is_owner || 0) && item.account_id && item.user_id);
    const pendingInvites = selectedItems
      .filter(item => item.item_type === 'pending' && item.account_id && item.email);
    const totalSelected = members.length + pendingInvites.length;

    if (totalSelected === 0) {
      this.toast('请先勾选要踢出的成员', 'warning');
      return;
    }

    if (!confirm(`确定处理已选中的 ${totalSelected} 个没有来源记录的成员/待邀请吗？`)) {
      return;
    }

    const button = document.getElementById('btn-untracked-members-kick-selected');
    if (button) {
      button.disabled = true;
      button.classList.add('loading');
    }

    let successCount = 0;
    const failed = [];
    const workspaceRows = new Set();

    try {
      [...members, ...pendingInvites].forEach(member => {
        if (member.workspace_row_id) {
          workspaceRows.add(Number(member.workspace_row_id));
        }
      });

      if (members.length > 0) {
        const result = await API.removeMembersBatch(
          members.map((member, index) => ({
            client_index: index,
            account_id: member.account_id,
            user_id: member.user_id,
            workspace_id: member.workspace_id,
            workspace_name: member.workspace_name || member.workspace_id,
            plan_type: member.plan_type || '',
            email: member.email || '',
            workspace_row_id: member.workspace_row_id || 0,
          })),
          {
            workspace_concurrency: 2,
            member_concurrency: 4,
          }
        );

        successCount += Number(result.removed || 0);
        (Array.isArray(result.results) ? result.results : [])
          .filter(item => !item.success)
          .forEach(item => failed.push(`${item.email || item.userId || item.user_id || '-'}: ${item.message || 'Remove failed'}`));
      }

      for (const invite of pendingInvites) {
        try {
          await API.revokePendingInvite(invite.account_id, {
            email: invite.email || '',
            remote_invite_id: invite.remote_invite_id || '',
            workspace_id: invite.workspace_id || '',
            workspace_name: invite.workspace_name || invite.workspace_id,
            plan_type: invite.plan_type || '',
            skip_sync: '1',
          });
          successCount += 1;
        } catch (err) {
          failed.push(`${invite.email || '-'}: ${err.message || 'Revoke failed'}`);
        }
      }

      this.untrackedMembersSelection = new Set();
      await this.refreshUntrackedMembersSurfaces(Array.from(workspaceRows));

      if (failed.length === 0) {
        this.toast(`踢出完成，成功 ${successCount} 个`, 'success');
      } else {
        this.toast(`踢出完成，成功 ${successCount} 个，失败 ${failed.length} 个`, 'warning');
        console.warn('Untracked member bulk remove failures:', failed);
      }
    } finally {
      if (button) {
        button.classList.remove('loading');
      }
      this.renderUntrackedMembers();
    }
  },

  async runUntrackedAutoKickNow() {
    if (!confirm('确定立即执行一次“没有来源记录自动踢人”吗？')) {
      return;
    }

    const button = document.getElementById('btn-run-untracked-auto-kick');
    if (button) {
      button.disabled = true;
      button.classList.add('loading');
    }

    try {
      const result = await API.runUntrackedAutoKick();
      this.untrackedMembersSelection = new Set();
      await this.loadUntrackedMembers({ silent: true });
      this.toast(`自动踢人完成：成功 ${result.removed || 0} 个，失败 ${result.failed || 0} 个`, result.failed ? 'warning' : 'success');
    } catch (err) {
      this.toast(`自动踢人失败: ${err.message}`, 'error');
    } finally {
      if (button) {
        button.classList.remove('loading');
      }
      this.renderUntrackedMembers();
    }
  },

  toggleMemberCleanupSelection(key, checked) {
    if (!key) {
      return;
    }

    if (checked) {
      this.memberCleanupSelection.add(key);
    } else {
      this.memberCleanupSelection.delete(key);
    }

    this.renderMemberCleanup();
  },

  toggleMemberCleanupSelectAll() {
    const items = (Array.isArray(this.memberCleanupData?.items) ? this.memberCleanupData.items : [])
      .filter(item => (
        (item.item_type === 'member' && !item.is_owner && item.account_id && item.user_id) ||
        (item.item_type === 'pending' && item.account_id && item.email)
      ));

    const allSelected = items.length > 0 && items.every(item => this.memberCleanupSelection.has(item.selection_key));
    if (allSelected) {
      items.forEach(item => this.memberCleanupSelection.delete(item.selection_key));
    } else {
      items.forEach(item => this.memberCleanupSelection.add(item.selection_key));
    }

    this.renderMemberCleanup();
  },

  clearMemberCleanupSelection() {
    this.memberCleanupSelection = new Set();
    this.renderMemberCleanup();
  },

  async syncMemberCleanupWorkspaces(workspaceRowIds = []) {
    const rows = Array.from(new Set((workspaceRowIds || []).map(value => Number(value || 0)).filter(Boolean)));
    for (const workspaceRowId of rows) {
      await API.syncWorkspace(workspaceRowId).catch(err => {
        console.warn('Failed to sync workspace after member cleanup action:', err);
      });
    }
  },

  async refreshMemberCleanupSurfaces() {
    const refreshes = [
      this.loadMemberCleanup({ silent: true }),
      this.loadAccounts(this.currentAccountsPage),
      this.loadStats(),
      this.loadWorkspaces(this.currentWorkspacesPage),
      this.loadWorkspaceDashboard(),
      this.loadInvites(this.currentInvitesPage),
    ];

    if (this.auditData?.email) {
      refreshes.push(this.runEmailAudit({ email: this.auditData.email, silent: true }));
    }

    await Promise.all(refreshes);
  },

  async removeMemberCleanupItem(accountId, userId, workspaceId = '', workspaceName = '', planType = '', memberEmail = '', workspaceRowId = 0) {
    const label = memberEmail || userId;
    const workspaceLabel = workspaceName || workspaceId || '当前工作区';
    if (!confirm(`确定要把 ${label} 从 ${workspaceLabel} 踢出去吗？`)) {
      return;
    }

    try {
      await API.removeMember(accountId, userId, {
        workspace_id: workspaceId,
        workspace_name: workspaceName,
        plan_type: planType,
        skip_sync: '1',
      });

      await this.syncMemberCleanupWorkspaces([workspaceRowId]);
      this.memberCleanupSelection = new Set();
      this.toast(`已移出 ${label}`, 'success');
      await this.refreshMemberCleanupSurfaces();
    } catch (err) {
      this.toast(`踢出成员失败: ${err.message}`, 'error');
    }
  },

  async revokeMemberCleanupInvite(accountId, email, workspaceId = '', workspaceName = '', planType = '', workspaceRowId = 0, remoteInviteId = '') {
    const label = email || remoteInviteId;
    const workspaceLabel = workspaceName || workspaceId || '当前工作区';
    if (!confirm(`确定要撤销 ${workspaceLabel} 里的待邀请 ${label} 吗？`)) {
      return;
    }

    try {
      await API.revokePendingInvite(accountId, {
        email,
        remote_invite_id: remoteInviteId,
        workspace_id: workspaceId,
        workspace_name: workspaceName,
        plan_type: planType,
        skip_sync: '1',
      });

      await this.syncMemberCleanupWorkspaces([workspaceRowId]);
      this.memberCleanupSelection = new Set();
      this.toast(`已撤销 ${label} 的待邀请`, 'success');
      await this.refreshMemberCleanupSurfaces();
    } catch (err) {
      this.toast(`撤销待邀请失败: ${err.message}`, 'error');
    }
  },

  async removeSelectedMemberCleanupMembers() {
    const members = (Array.isArray(this.memberCleanupData?.items) ? this.memberCleanupData.items : [])
      .filter(item => this.memberCleanupSelection.has(item.selection_key))
      .filter(item => item.item_type === 'member' && !item.is_owner && item.account_id && item.user_id);

    if (members.length === 0) {
      this.toast('请先勾选要踢出的成员', 'warning');
      return;
    }

    if (!confirm(`确定一键踢出已选中的 ${members.length} 个成员吗？`)) {
      return;
    }

    const button = document.getElementById('btn-member-cleanup-kick-selected');
    if (button) {
      button.disabled = true;
      button.classList.add('loading');
    }

    let successCount = 0;
    const failed = [];
    const workspaceRows = new Set();

    try {
      members.forEach(member => {
        if (member.workspace_row_id) {
          workspaceRows.add(Number(member.workspace_row_id));
        }
      });

      const result = await API.removeMembersBatch(
        members.map((member, index) => ({
          client_index: index,
          account_id: member.account_id,
          user_id: member.user_id,
          workspace_id: member.workspace_id,
          workspace_name: member.workspace_name || member.workspace_id,
          plan_type: member.plan_type || '',
          email: member.email || '',
          workspace_row_id: member.workspace_row_id || 0,
        })),
        {
          workspace_concurrency: 2,
          member_concurrency: 4,
        }
      );

      successCount = Number(result.removed || 0);
      (Array.isArray(result.results) ? result.results : [])
        .filter(item => !item.success)
        .forEach(item => failed.push(`${item.email || item.userId || item.user_id || '-'}: ${item.message || 'Remove failed'}`));

      await this.syncMemberCleanupWorkspaces(Array.from(workspaceRows));
      this.memberCleanupSelection = new Set();
      await this.refreshMemberCleanupSurfaces();

      if (failed.length === 0) {
        this.toast(`一键踢人完成，成功 ${successCount} 个`, 'success');
      } else {
        this.toast(`一键踢人完成，成功 ${successCount} 个，失败 ${failed.length} 个`, 'warning');
        console.warn('Member cleanup bulk remove failures:', failed);
      }
    } finally {
      if (button) {
        button.classList.remove('loading');
      }
      this.renderMemberCleanup();
    }
  },

  async revokeSelectedMemberCleanupInvites() {
    const invites = (Array.isArray(this.memberCleanupData?.items) ? this.memberCleanupData.items : [])
      .filter(item => this.memberCleanupSelection.has(item.selection_key))
      .filter(item => item.item_type === 'pending' && item.account_id && item.email);

    if (invites.length === 0) {
      this.toast('请先勾选要撤销的待邀请', 'warning');
      return;
    }

    if (!confirm(`确定撤销已选中的 ${invites.length} 条待邀请吗？`)) {
      return;
    }

    const button = document.getElementById('btn-member-cleanup-revoke-selected');
    if (button) {
      button.disabled = true;
      button.classList.add('loading');
    }

    let successCount = 0;
    const failed = [];
    const workspaceRows = new Set();

    try {
      for (const invite of invites) {
        try {
          await API.revokePendingInvite(invite.account_id, {
            email: invite.email,
            remote_invite_id: invite.remote_invite_id || '',
            workspace_id: invite.workspace_id,
            workspace_name: invite.workspace_name || invite.workspace_id,
            plan_type: invite.plan_type || '',
            skip_sync: '1',
          });
          if (invite.workspace_row_id) {
            workspaceRows.add(Number(invite.workspace_row_id));
          }
          successCount += 1;
        } catch (err) {
          failed.push(`${invite.email || invite.remote_invite_id}: ${err.message}`);
        }
      }

      await this.syncMemberCleanupWorkspaces(Array.from(workspaceRows));
      this.memberCleanupSelection = new Set();
      await this.refreshMemberCleanupSurfaces();

      if (failed.length === 0) {
        this.toast(`待邀请撤销完成，成功 ${successCount} 条`, 'success');
      } else {
        this.toast(`待邀请撤销完成，成功 ${successCount} 条，失败 ${failed.length} 条`, 'warning');
        console.warn('Member cleanup bulk revoke failures:', failed);
      }
    } finally {
      if (button) {
        button.classList.remove('loading');
      }
      this.renderMemberCleanup();
    }
  },

  renderCheckoutTools() {
    const summaryHost = document.getElementById('checkout-tools-summary');
    const table = document.getElementById('checkout-tools-table');
    const tbody = document.getElementById('checkout-tools-tbody');
    const empty = document.getElementById('checkout-tools-empty');
    const resultHost = document.getElementById('checkout-tool-result');
    const summary = this.checkoutToolsData?.summary || {};
    const items = Array.isArray(this.checkoutToolsData?.items) ? this.checkoutToolsData.items : [];

    if (summaryHost) {
      summaryHost.innerHTML = [
        Components.workspaceSummaryCard('总记录', summary.total_records || 0, 'neutral', '当前筛选结果'),
        Components.workspaceSummaryCard('可用链接', summary.parsed_links || 0, (summary.parsed_links || 0) > 0 ? 'success' : 'neutral', '识别出有效 cs_id'),
        Components.workspaceSummaryCard('卡密记录', summary.code_entries || 0, (summary.code_entries || 0) > 0 ? 'accent' : 'neutral', '含卡密或链接+卡密'),
        Components.workspaceSummaryCard('需人工看', summary.risky_entries || 0, (summary.risky_entries || 0) > 0 ? 'warning' : 'neutral', '未识别或只识别一部分'),
      ].join('');
    }

    if (resultHost) {
      resultHost.innerHTML = Components.checkoutResultCard(this.lastCheckoutToolResult);
    }

    if (!table || !tbody || !empty) {
      return;
    }

    if (items.length === 0) {
      table.classList.add('hidden');
      empty.classList.remove('hidden');
      tbody.innerHTML = '';
      return;
    }

    table.classList.remove('hidden');
    empty.classList.add('hidden');
    tbody.innerHTML = items.map(item => Components.checkoutHistoryRow(item)).join('');
  },

  async loadCheckoutTools() {
    const params = this.getCheckoutToolFilters();
    const requestKey = `checkout-tools:${JSON.stringify(params)}`;

    return this.runSingleFlight(requestKey, async () => {
      try {
        this.checkoutToolsData = await API.getCheckoutTools(params);
        this.renderCheckoutTools();
      } catch (err) {
        console.error('Failed to load checkout tools:', err);
        this.toast(`结账工具历史加载失败: ${err.message}`, 'error');
      }
    });
  },

  async parseCheckoutTool() {
    const input = document.getElementById('checkout-tool-input')?.value.trim() || '';
    const redeemCode = document.getElementById('checkout-redeem-code')?.value.trim() || '';
    const note = document.getElementById('checkout-tool-note')?.value.trim() || '';
    const mode = document.getElementById('checkout-tool-mode')?.value || 'api';
    const ccNumber = document.getElementById('checkout-cc-number')?.value.trim() || '';
    const ccExp = document.getElementById('checkout-cc-exp')?.value.trim() || '';
    const ccCvv = document.getElementById('checkout-cc-cvv')?.value.trim() || '';
    const ccNeeds3ds = !!document.getElementById('checkout-cc-needs-3ds')?.checked;

    if (!input && !redeemCode && mode === 'api') {
      this.toast('卡密模式下请先输入结账链接、cs_id 或卡密', 'warning');
      return;
    }
    if (!input && mode === 'card') {
      this.toast('信用卡模式下必须输入 cs_id 或链接', 'warning');
      return;
    }

    try {
      const autoSub = !!document.getElementById('checkout-auto-sub')?.checked;
      const payload = {
        input: input,
        redeem_code: redeemCode,
        note,
        mode
      };
      if (mode === 'card') {
        payload.cc_number = ccNumber;
        payload.cc_exp = ccExp;
        payload.cc_cvv = ccCvv;
        payload.cc_needs_3ds = ccNeeds3ds;
      }

      const result = await API.parseCheckoutTool(payload);
      const item = result.item || null;
      this.lastCheckoutToolResult = item;
      
      if (autoSub && item && (item.session_id || item.raw_input)) {
        this.executeAutoSub(item.id);
      }
      
      await this.loadCheckoutTools();
      this.renderCheckoutTools();
      this.toast(result.message || '已保存', 'success');
      // Clear specific inputs
      document.getElementById('checkout-tool-input').value = '';
      if (mode === 'card') {
        document.getElementById('checkout-cc-number').value = '';
        document.getElementById('checkout-cc-exp').value = '';
        document.getElementById('checkout-cc-cvv').value = '';
      } else {
        document.getElementById('checkout-redeem-code').value = '';
      }
    } catch (err) {
      this.toast(`解析失败: ${err.message}`, 'error');
    }
  },

  async executeAutoSub(id) {
    this.clearAutoSubPoller(id);
    this.toast('已启动后台自动订阅流程...', 'info');

    try {
      await API.autosubCheckoutTool(id);
      await this.loadCheckoutTools();
      this.renderCheckoutTools();

      let attempts = 0;
      const maxAttempts = 60;
      const pollInterval = setInterval(async () => {
        attempts += 1;

        try {
          await this.loadCheckoutTools();
          this.renderCheckoutTools();
          const item = (this.checkoutToolsData.items || []).find((t) => t.id === id);

          if (item && (item.autosub_status === 'success' || item.autosub_status === 'failed')) {
            this.clearAutoSubPoller(id);
            if (item.autosub_status === 'success') {
              this.toast('扣款成功！', 'success');
            } else {
              this.toast(`协议订阅失败: ${item.autosub_error || '未知错误'}`, 'error');
            }
            return;
          }

          if (attempts >= maxAttempts) {
            this.clearAutoSubPoller(id);
            this.toast('协议订阅仍在处理中，请稍后手动刷新查看结果', 'warning');
          }
        } catch (err) {
          this.clearAutoSubPoller(id);
          this.toast(`轮询订阅状态失败: ${err.message}`, 'error');
        }
      }, 2000);

      this.autosubPollers.set(id, pollInterval);
    } catch (err) {
      this.toast(`协议订阅启动失败: ${err.message}`, 'error');
    }
  },

  // Removed fake SMS Modal - Actual 3DS is handled in Puppeteer Chrome window

  // submitSmsCode removed

  async copyText(value) {
    const text = String(value || '');
    if (!text) return false;

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (err) {
      console.warn('Clipboard API failed, falling back:', err);
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    textarea.remove();
    return ok;
  },

  async copyCheckoutTool(id, kind, value) {
    const ok = await this.copyText(value);
    if (!ok) {
      this.toast('复制失败，请手动复制', 'error');
      return;
    }

    try {
      await API.touchCheckoutTool(id, `copy_${kind}`);
    } catch (err) {
      console.warn('Failed to touch checkout tool:', err);
    }

    this.toast(kind === 'session' ? 'Session ID 已复制' : '链接已复制', 'success');
    await this.loadCheckoutTools();
    this.renderCheckoutTools();
  },

  async openCheckoutTool(id, url) {
    if (!url) {
      this.toast('这条记录没有可打开的标准链接', 'warning');
      return;
    }

    window.open(url, '_blank', 'noopener,noreferrer');

    try {
      await API.touchCheckoutTool(id, 'open_link');
    } catch (err) {
      console.warn('Failed to touch checkout tool:', err);
    }

    await this.loadCheckoutTools();
    this.renderCheckoutTools();
  },

  async deleteCheckoutTool(id) {
    if (!confirm('确定删除这条结账工具记录吗？')) {
      return;
    }

    try {
      await API.deleteCheckoutTool(id);
      if (this.lastCheckoutToolResult?.id === id) {
        this.lastCheckoutToolResult = null;
      }
      await this.loadCheckoutTools();
      this.renderCheckoutTools();
      this.toast('记录已删除', 'success');
    } catch (err) {
      this.toast(`删除失败: ${err.message}`, 'error');
    }
  },

  getCdkFilters() {
    return {
      search: document.getElementById('cdk-search-input')?.value.trim() || '',
      status: document.getElementById('cdk-status-filter')?.value || 'all',
    };
  },

  cdkStatusLabel(status) {
    const labels = {
      unused: '未使用',
      processing: '处理中',
      used: '已使用',
      expired: '已过期',
      pending: '排队中',
      PROCESSING: '处理中',
      SUCCESS: '成功',
      FAILED: '失败',
      delivered: '已发码',
      paid: '已支付',
      failed: '失败',
    };
    return labels[status] || status || '未知';
  },

  cdkStatusTone(status) {
    if (['SUCCESS', 'used', 'delivered', 'paid'].includes(status)) return 'success';
    if (['FAILED', 'failed', 'expired'].includes(status)) return 'danger';
    if (['PROCESSING', 'processing', 'pending'].includes(status)) return 'warning';
    return 'neutral';
  },

  cdkPlanLabel(plan) {
    const labels = {
      team_invite: 'Team 邀请',
      plus_monthly: 'Plus 月付',
      plus_yearly: 'Plus 年付',
      pro_monthly: 'Pro 月付',
    };
    return labels[plan] || plan || '-';
  },

  cdkPill(label, tone = 'neutral', title = '') {
    return Components.quotaPill(label, tone, title);
  },

  renderCdkPagination(containerId, data, type) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const total = Number(data?.total || 0);
    const limit = Number(data?.limit || this.cdkPageLimit || 10);
    const currentPage = Math.max(1, Number(data?.page || 1));
    const totalPages = Math.max(1, Math.ceil(total / limit));

    if (total === 0) {
      container.innerHTML = '';
      return;
    }

    const meta = `<span class="pagination-meta">\u7b2c ${currentPage} / ${totalPages} \u9875 \u00b7 \u5171 ${total} \u6761</span>`;
    if (totalPages <= 1) {
      container.innerHTML = meta;
      return;
    }

    const buttons = [];
    buttons.push(`<button ${currentPage <= 1 ? 'disabled' : ''} onclick="App.goToCdkPage('${type}', ${currentPage - 1})">&lt;</button>`);
    for (let i = 1; i <= totalPages; i += 1) {
      if (i === 1 || i === totalPages || (i >= currentPage - 2 && i <= currentPage + 2)) {
        buttons.push(`<button class="page-btn ${i === currentPage ? 'active' : ''}" ${i === currentPage ? '' : `onclick="App.goToCdkPage('${type}', ${i})"`}>${i}</button>`);
      } else if (i === currentPage - 3 || i === currentPage + 3) {
        buttons.push('<span class="page-dots">...</span>');
      }
    }
    buttons.push(`<button ${currentPage >= totalPages ? 'disabled' : ''} onclick="App.goToCdkPage('${type}', ${currentPage + 1})">&gt;</button>`);
    container.innerHTML = `${meta}${buttons.join('')}`;
  },

  goToCdkPage(type, page) {
    const safePage = Math.max(1, parseInt(page, 10) || 1);
    if (type === 'orders') {
      this.currentCdkOrdersPage = safePage;
    } else if (type === 'cards') {
      this.currentCdkCardsPage = safePage;
    } else if (type === 'tasks') {
      this.currentCdkTasksPage = safePage;
    }
    this.loadCdkPage();
  },

  async loadCdkPage(options = {}) {
    if (options.resetPages) {
      this.currentCdkCardsPage = 1;
      this.currentCdkOrdersPage = 1;
      this.currentCdkTasksPage = 1;
    }

    const filters = this.getCdkFilters();
    const cardsPage = Math.max(1, parseInt(options.cardsPage || this.currentCdkCardsPage || 1, 10));
    const ordersPage = Math.max(1, parseInt(options.ordersPage || this.currentCdkOrdersPage || 1, 10));
    const tasksPage = Math.max(1, parseInt(options.tasksPage || this.currentCdkTasksPage || 1, 10));
    const limit = this.cdkPageLimit;
    this.currentCdkCardsPage = cardsPage;
    this.currentCdkOrdersPage = ordersPage;
    this.currentCdkTasksPage = tasksPage;

    const requestKey = `cdk-page:${JSON.stringify({ filters, cardsPage, ordersPage, tasksPage, limit })}`;

    return this.runSingleFlight(requestKey, async () => {
      try {
        const [cards, tasks, orders] = await Promise.all([
          API.getCdkList({ ...filters, page: cardsPage, limit }),
          API.getCdkTasks({ page: tasksPage, limit }),
          API.getPaymentOrders({ page: ordersPage, limit }),
        ]);

        this.cdkCardsData = cards || { items: [], summary: {} };
        this.cdkTasksData = tasks || { tasks: [] };
        this.cdkOrdersData = orders || { orders: [], summary: {} };
        this.renderCdkPage();
      } catch (err) {
        console.error('Failed to load CDK page:', err);
        this.toast(`CDK 功能台加载失败: ${err.message}`, 'error');
      }
    });
  },

  renderCdkPage() {
    this.renderCdkSummary();
    this.renderCdkOrders();
    this.renderCdkCards();
    this.renderCdkTasks();
    this.renderCdkTrace();
  },

  renderCdkSummary() {
    const host = document.getElementById('cdk-summary');
    if (!host) return;

    const cardSummary = this.cdkCardsData?.summary || {};
    const orderSummary = this.cdkOrdersData?.summary || {};
    host.innerHTML = [
      Components.workspaceSummaryCard('CDK 总数', cardSummary.total || 0, 'neutral', '当前库存总量'),
      Components.workspaceSummaryCard('未使用', cardSummary.unused || 0, (cardSummary.unused || 0) > 0 ? 'success' : 'neutral', '可发放或可激活'),
      Components.workspaceSummaryCard('处理中', cardSummary.processing || 0, (cardSummary.processing || 0) > 0 ? 'warning' : 'neutral', '正在激活或等待任务完成'),
      Components.workspaceSummaryCard('已发码订单', orderSummary.delivered || 0, (orderSummary.delivered || 0) > 0 ? 'accent' : 'neutral', '支付成功并已生成 CDK'),
    ].join('');
  },

  renderCdkOrders() {
    const table = document.getElementById('cdk-orders-table');
    const tbody = document.getElementById('cdk-orders-tbody');
    const empty = document.getElementById('cdk-orders-empty');
    const orders = Array.isArray(this.cdkOrdersData?.orders) ? this.cdkOrdersData.orders : [];
    if (!table || !tbody || !empty) return;
    this.renderCdkPagination('cdk-orders-pagination', this.cdkOrdersData, 'orders');

    if (orders.length === 0) {
      table.classList.add('hidden');
      empty.classList.remove('hidden');
      tbody.innerHTML = '';
      return;
    }

    table.classList.remove('hidden');
    empty.classList.add('hidden');
    tbody.innerHTML = orders.map(order => `
      <tr>
        <td>
          <div class="stack-col-sm">
            <code>${Components.escapeHtml(order.orderNo || '')}</code>
            <button class="member-inline-btn" onclick="App.traceCdk(${Components.jsString(order.orderNo || '')})">追踪</button>
          </div>
        </td>
        <td>${Components.escapeHtml(order.buyerEmail || '')}</td>
        <td>${this.cdkPill(this.cdkStatusLabel(order.status), this.cdkStatusTone(order.status))}</td>
        <td>
          <div class="stack-col-sm">
            <span>${Components.escapeHtml(order.amountText || '')}</span>
            ${order.matchStatus ? `<span class="text-muted text-xs">匹配: ${Components.escapeHtml(order.matchStatus)}</span>` : ''}
            ${order.paidAmountText ? `<span class="text-muted text-xs">实收: ${Components.escapeHtml(order.paidAmountText)}</span>` : ''}
            ${order.payerName ? `<span class="text-muted text-xs">付款: ${Components.escapeHtml(order.payerName)}</span>` : ''}
          </div>
        </td>
        <td>
          <div class="stack-col-sm">
            <code>${Components.escapeHtml(order.cdkCode || '-')}</code>
            ${order.cdkCode ? `<button class="member-inline-btn" onclick="App.copyText(${Components.jsString(order.cdkCode)})">复制</button>` : ''}
          </div>
        </td>
        <td>
          <div class="stack-col-sm">
            <span>${Components.timeAgo(order.updatedAt || order.createdAt)}</span>
            <span class="text-muted text-xs">${Components.escapeHtml(Components.formatDateTime(order.updatedAt || order.createdAt))}</span>
          </div>
        </td>
        <td>
          <div class="action-btns">
            ${order.status === 'pending' && order.paymentMethod === 'alipay' ? `
              <button class="action-btn tone-green" title="确认收款并发码" onclick="App.manualDeliverOrder(${Components.jsString(order.orderNo || '')})">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
              </button>
            ` : ''}
            <button class="action-btn tone-blue" title="追踪" onclick="App.traceCdk(${Components.jsString(order.orderNo || '')})">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            </button>
          </div>
        </td>
      </tr>
    `).join('');
  },

  renderCdkCards() {
    const table = document.getElementById('cdk-table');
    const tbody = document.getElementById('cdk-tbody');
    const empty = document.getElementById('cdk-empty');
    const cards = Array.isArray(this.cdkCardsData?.items) ? this.cdkCardsData.items : [];
    if (!table || !tbody || !empty) return;
    this.renderCdkPagination('cdk-pagination', this.cdkCardsData, 'cards');

    if (cards.length === 0) {
      table.classList.add('hidden');
      empty.classList.remove('hidden');
      tbody.innerHTML = '';
      return;
    }

    table.classList.remove('hidden');
    empty.classList.add('hidden');
    tbody.innerHTML = cards.map(card => `
      <tr>
        <td>
          <div class="stack-col-sm">
            <code>${Components.escapeHtml(card.code || '')}</code>
            ${card.source_order_no ? `<span class="text-muted text-xs">订单: ${Components.escapeHtml(card.source_order_no)}</span>` : ''}
          </div>
        </td>
        <td>${this.cdkPill(this.cdkStatusLabel(card.status), this.cdkStatusTone(card.status))}</td>
        <td>${Components.escapeHtml(this.cdkPlanLabel(card.plan_type))}</td>
        <td>
          <div class="stack-col-sm">
            <span>${Components.escapeHtml(card.assigned_email || '-')}</span>
            ${card.buyer_email ? `<span class="text-muted text-xs">购买: ${Components.escapeHtml(card.buyer_email)}</span>` : ''}
          </div>
        </td>
        <td>${Components.timeAgo(card.created_at)}</td>
        <td>
          <div class="action-btns">
            <button class="action-btn tone-blue" title="追踪" onclick="App.traceCdk(${Components.jsString(card.code || '')})">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            </button>
            <button class="action-btn tone-green" title="复制" onclick="App.copyText(${Components.jsString(card.code || '')})">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            </button>
            <button class="action-btn danger" title="删除" onclick="App.deleteCdk(${card.id})">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
            </button>
          </div>
        </td>
      </tr>
    `).join('');
  },

  renderCdkTasks() {
    const table = document.getElementById('cdk-tasks-table');
    const tbody = document.getElementById('cdk-tasks-tbody');
    const empty = document.getElementById('cdk-tasks-empty');
    const tasks = Array.isArray(this.cdkTasksData?.tasks) ? this.cdkTasksData.tasks : [];
    if (!table || !tbody || !empty) return;
    this.renderCdkPagination('cdk-tasks-pagination', this.cdkTasksData, 'tasks');

    if (tasks.length === 0) {
      table.classList.add('hidden');
      empty.classList.remove('hidden');
      tbody.innerHTML = '';
      return;
    }

    table.classList.remove('hidden');
    empty.classList.add('hidden');
    tbody.innerHTML = tasks.map(task => `
      <tr>
        <td>
          <div class="stack-col-sm">
            <code title="${Components.escapeHtml(task.id || '')}">${Components.escapeHtml(Components.shortId(task.id || ''))}</code>
            <button class="member-inline-btn" onclick="App.traceCdk(${Components.jsString(task.id || '')})">追踪</button>
          </div>
        </td>
        <td><code title="${Components.escapeHtml(task.cdk_code || '')}">${Components.escapeHtml(task.cdk_code || '-')}</code></td>
        <td>${Components.escapeHtml(task.account_email || '-')}</td>
        <td>
          <div class="stack-col-sm">
            ${this.cdkPill(this.cdkStatusLabel(task.status), this.cdkStatusTone(task.status))}
            <span class="text-muted text-xs">${Components.escapeHtml(task.task_type || 'plus_checkout')}</span>
          </div>
        </td>
        <td>
          <div class="stack-col-sm">
            <span>${Components.escapeHtml(task.status_message || '-')}</span>
            ${task.error_message ? `<span class="text-muted text-xs cell-note-warning">${Components.escapeHtml(task.error_message)}</span>` : ''}
          </div>
        </td>
        <td>${Components.timeAgo(task.updated_at || task.created_at)}</td>
      </tr>
    `).join('');
  },

  renderCdkTrace() {
    const host = document.getElementById('cdk-trace-result');
    if (!host) return;

    const data = this.cdkTraceData;
    if (!data) {
      host.innerHTML = '<div class="dashboard-alert-item neutral"><div class="dashboard-alert-detail">输入订单号、CDK、邮箱或任务 ID 后，可以看到完整处理链路。</div></div>';
      return;
    }

    const section = (title, rows, renderRow) => `
      <div class="dashboard-alert-item accent">
        <div class="dashboard-alert-head"><strong>${Components.escapeHtml(title)}</strong><span>${rows.length}</span></div>
        <div class="dashboard-alert-detail">
          ${rows.length ? rows.map(renderRow).join('') : '<span class="text-muted">暂无记录</span>'}
        </div>
      </div>
    `;

    host.innerHTML = `
      <div class="dashboard-alert-item ${data.diagnosis && data.diagnosis.includes('失败') ? 'warning' : 'success'}">
        <div class="dashboard-alert-head"><strong>诊断</strong></div>
        <div class="dashboard-alert-detail">${Components.escapeHtml(data.diagnosis || '')}</div>
      </div>
      ${section('订单', data.orders || [], order => `
        <div class="checkout-result-line"><span class="checkout-result-label">${Components.escapeHtml(order.status)}</span><code>${Components.escapeHtml(order.order_no || '')}</code><span>${Components.escapeHtml(order.buyer_email || '')}</span><code>${Components.escapeHtml(order.cdk_code || '-')}</code></div>
      `)}
      ${section('CDK', data.cards || [], card => `
        <div class="checkout-result-line"><span class="checkout-result-label">${Components.escapeHtml(card.status)}</span><code>${Components.escapeHtml(card.code || '')}</code><span>${Components.escapeHtml(card.assigned_email || card.buyer_email || '-')}</span></div>
      `)}
      ${section('激活任务', data.tasks || [], task => `
        <div class="checkout-result-line"><span class="checkout-result-label">${Components.escapeHtml(task.status)}</span><code title="${Components.escapeHtml(task.id || '')}">${Components.escapeHtml(Components.shortId(task.id || ''))}</code><span>${Components.escapeHtml(task.account_email || '')}</span><span>${Components.escapeHtml(task.error_message || task.status_message || '')}</span></div>
      `)}
      ${section('邀请记录', data.invites || [], invite => `
        <div class="checkout-result-line"><span class="checkout-result-label">${Components.escapeHtml(invite.status)}</span><span>${Components.escapeHtml(invite.target_email || '')}</span><span>${Components.escapeHtml(invite.workspace_name || invite.workspace_id || '默认工作区')}</span><span>${Components.escapeHtml(invite.message || '')}</span></div>
      `)}
      ${section('运行日志', data.logs || [], log => `
        <div class="checkout-result-line"><span class="checkout-result-label">${Components.escapeHtml(log.status || '')}</span><span>${Components.escapeHtml(log.email || '')}</span><span>${Components.escapeHtml(log.message || '')}</span><span>${Components.escapeHtml(Components.timeAgo(log.checked_at))}</span></div>
      `)}
    `;
  },

  async generateCdk() {
    const count = parseInt(document.getElementById('cdk-gen-count')?.value || '1', 10);
    const planType = document.getElementById('cdk-gen-plan')?.value || 'team_invite';
    const resultHost = document.getElementById('cdk-gen-result');

    try {
      const result = await API.generateCdk({ count, plan_type: planType });
      if (resultHost) {
        resultHost.innerHTML = `
          <div class="dashboard-alert-item success">
            <div class="dashboard-alert-head"><strong>${Components.escapeHtml(result.message || '生成成功')}</strong></div>
            <div class="dashboard-alert-detail cdk-generated-list">${(result.codes || []).map(code => `
              <div class="cdk-generated-item">
                <code>${Components.escapeHtml(code)}</code>
              </div>
            `).join('')}</div>
          </div>
        `;
      }
      await this.loadCdkPage({ resetPages: true });
      this.toast('CDK 已生成', 'success');
    } catch (err) {
      this.toast(`生成 CDK 失败: ${err.message}`, 'error');
    }
  },

  async deleteCdk(id) {
    if (!confirm('确定删除这张 CDK 吗？')) {
      return;
    }

    try {
      await API.deleteCdk(id);
      await this.loadCdkPage();
      this.toast('CDK 已删除', 'success');
    } catch (err) {
      this.toast(`删除 CDK 失败: ${err.message}`, 'error');
    }
  },

  async batchDeleteCdk(status = 'used') {
    if (!confirm(`确定删除所有${this.cdkStatusLabel(status)} CDK 吗？`)) {
      return;
    }

    try {
      const result = await API.batchDeleteCdk(status);
      await this.loadCdkPage({ resetPages: true });
      this.toast(result.message || '已批量清理', 'success');
    } catch (err) {
      this.toast(`批量清理失败: ${err.message}`, 'error');
    }
  },

  async manualDeliverOrder(orderNo) {
    if (!orderNo) return;
    const note = '确认前请核对支付宝到账金额和订单备注。确认后系统会立刻生成 CDK。';
    if (!confirm(`${note}\n\n订单：${orderNo}\n\n确定已经收到正确金额吗？`)) {
      return;
    }

    try {
      const result = await API.manualDeliverPaymentOrder(orderNo);
      await this.loadCdkPage();
      const code = result?.order?.cdkCode || '';
      this.toast(code ? `已确认收款并发码: ${code}` : '已确认收款并发码', 'success');
      if (code) {
        await this.copyText(code);
      }
    } catch (err) {
      this.toast(`确认收款失败: ${err.message}`, 'error');
    }
  },

  async traceCdk(value = '') {
    const input = document.getElementById('cdk-trace-input');
    const search = String(value || input?.value || '').trim();
    if (!search) {
      this.toast('请输入订单号、CDK、邮箱或任务 ID', 'warning');
      return;
    }
    if (input && input.value !== search) {
      input.value = search;
    }

    try {
      this.cdkTraceData = await API.traceCdk(search);
      this.renderCdkTrace();
    } catch (err) {
      this.cdkTraceData = {
        diagnosis: `追踪失败: ${err.message}`,
        orders: [],
        cards: [],
        tasks: [],
        invites: [],
        logs: [],
      };
      this.renderCdkTrace();
      this.toast(`追踪失败: ${err.message}`, 'error');
    }
  },

  // ===== VPS Monitor =====
  updateSystemMonitorPolling(page) {
    if (page === 'system-monitor') {
      this.startSystemMonitorPolling();
      return;
    }

    this.stopSystemMonitorPolling();
  },

  startSystemMonitorPolling() {
    if (this.systemMetricsTimer) {
      return;
    }

    this.systemMetricsTimer = setInterval(() => {
      if (this.currentPage !== 'system-monitor') {
        this.stopSystemMonitorPolling();
        return;
      }

      this.loadSystemMetrics({ silent: true }).catch(err => {
        console.error('System metrics refresh failed:', err);
      });
    }, 2000);
  },

  stopSystemMonitorPolling() {
    if (!this.systemMetricsTimer) {
      return;
    }

    clearInterval(this.systemMetricsTimer);
    this.systemMetricsTimer = null;
  },

  formatBytes(bytes = 0) {
    const value = Number(bytes || 0);
    if (!Number.isFinite(value) || value <= 0) {
      return '0 B';
    }

    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
    const normalized = value / (1024 ** index);
    return `${normalized >= 10 || index === 0 ? normalized.toFixed(0) : normalized.toFixed(1)} ${units[index]}`;
  },

  formatDuration(seconds = 0) {
    const total = Math.max(0, Math.floor(Number(seconds || 0)));
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);

    if (days > 0) {
      return `${days}天 ${hours}小时`;
    }
    if (hours > 0) {
      return `${hours}小时 ${minutes}分钟`;
    }
    return `${minutes}分钟`;
  },

  pushSystemMetric(metric) {
    const cpu = Number(metric?.cpu?.usage_percent || 0);
    const memory = Number(metric?.memory?.usage_percent || 0);
    this.systemMetricsHistory.cpu.push(cpu);
    this.systemMetricsHistory.memory.push(memory);

    while (this.systemMetricsHistory.cpu.length > this.systemMetricsMaxPoints) {
      this.systemMetricsHistory.cpu.shift();
    }
    while (this.systemMetricsHistory.memory.length > this.systemMetricsMaxPoints) {
      this.systemMetricsHistory.memory.shift();
    }
  },

  drawSystemChart(canvasId, values = [], options = {}) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) {
      return;
    }

    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(320, canvas.clientWidth || canvas.parentElement?.clientWidth || 640);
    const height = Number(canvas.getAttribute('height')) || 220;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const padding = { top: 18, right: 16, bottom: 26, left: 38 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;
    const lineColor = options.lineColor || '#5fd6c1';
    const fillColor = options.fillColor || 'rgba(95, 214, 193, 0.16)';
    const gridColor = 'rgba(126, 173, 169, 0.12)';
    const textColor = 'rgba(199, 218, 216, 0.78)';

    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    ctx.font = '12px Sora, sans-serif';
    ctx.fillStyle = textColor;

    [0, 25, 50, 75, 100].forEach(mark => {
      const y = padding.top + chartHeight - (mark / 100) * chartHeight;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(width - padding.right, y);
      ctx.stroke();
      ctx.fillText(`${mark}%`, 6, y + 4);
    });

    if (!values.length) {
      ctx.fillText('等待数据...', padding.left + 10, padding.top + chartHeight / 2);
      return;
    }

    const step = values.length > 1 ? chartWidth / (values.length - 1) : chartWidth;
    const points = values.map((value, index) => ({
      x: padding.left + step * index,
      y: padding.top + chartHeight - (Math.max(0, Math.min(100, value)) / 100) * chartHeight,
    }));

    ctx.beginPath();
    points.forEach((point, index) => {
      if (index === 0) {
        ctx.moveTo(point.x, point.y);
      } else {
        ctx.lineTo(point.x, point.y);
      }
    });
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = lineColor;
    ctx.stroke();

    ctx.lineTo(points[points.length - 1].x, padding.top + chartHeight);
    ctx.lineTo(points[0].x, padding.top + chartHeight);
    ctx.closePath();
    ctx.fillStyle = fillColor;
    ctx.fill();

    const latest = values[values.length - 1];
    const latestPoint = points[points.length - 1];
    ctx.beginPath();
    ctx.arc(latestPoint.x, latestPoint.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = lineColor;
    ctx.fill();
    ctx.fillStyle = textColor;
    ctx.fillText(`当前 ${Number(latest || 0).toFixed(1)}%`, padding.left, height - 8);
  },

  renderSystemMetrics(metric) {
    if (!metric) {
      return;
    }

    const cpuUsage = Number(metric.cpu?.usage_percent || 0);
    const memoryUsage = Number(metric.memory?.usage_percent || 0);
    const loadavg = Array.isArray(metric.loadavg) ? metric.loadavg : [];

    this.setText('system-cpu-usage', `${cpuUsage.toFixed(1)}%`);
    this.setText('system-cpu-meta', `${metric.cpu?.cores || 0} 核 · ${loadavg[0] ?? '--'} 当前负载`);
    this.setText('system-memory-usage', `${memoryUsage.toFixed(1)}%`);
    this.setText('system-memory-meta', `${this.formatBytes(metric.memory?.used)} / ${this.formatBytes(metric.memory?.total)}`);
    this.setText('system-loadavg', loadavg.map(value => Number(value || 0).toFixed(2)).join(' / ') || '--');
    this.setText('system-process-memory', this.formatBytes(metric.process?.memory_rss));
    this.setText('system-process-meta', `Heap ${this.formatBytes(metric.process?.memory_heap_used)} / ${this.formatBytes(metric.process?.memory_heap_total)}`);
    this.setText('system-cpu-cores', `${metric.cpu?.cores || 0} 核`);
    this.setText('system-cpu-model', metric.cpu?.model || '--');
    this.setText('system-memory-total', this.formatBytes(metric.memory?.total));
    this.setText('system-uptime', this.formatDuration(metric.uptime_seconds));
    this.setText('system-process-pid', metric.process?.pid ? `PID ${metric.process.pid}` : '--');
    this.setText('system-process-uptime', this.formatDuration(metric.process?.uptime_seconds));
    this.setText('system-last-updated', metric.timestamp ? new Date(metric.timestamp).toLocaleTimeString('zh-CN', { hour12: false }) : '--');

    this.drawSystemChart('system-cpu-chart', this.systemMetricsHistory.cpu, {
      lineColor: '#58c7ff',
      fillColor: 'rgba(88, 199, 255, 0.16)',
    });
    this.drawSystemChart('system-memory-chart', this.systemMetricsHistory.memory, {
      lineColor: '#8ff5e1',
      fillColor: 'rgba(143, 245, 225, 0.16)',
    });
  },

  async loadSystemMetrics(options = {}) {
    return this.runSingleFlight('system-metrics', async () => {
      try {
        const metric = await API.getSystemMetrics();
        this.pushSystemMetric(metric);
        this.renderSystemMetrics(metric);
      } catch (err) {
        this.setText('system-cpu-meta', `读取失败: ${err.message}`);
        if (!options.silent) {
          this.toast(`读取 VPS 监控失败: ${err.message}`, 'error');
        }
        throw err;
      }
    });
  },

  // ===== Toast =====
  toast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const icons = {
      success: '✅',
      error: '❌',
      warning: '⚠️',
      info: 'ℹ️',
    };

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<span>${icons[type] || ''}</span><span>${message}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('toast-exit');
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  },

  // ===== Auto Refresh =====
  startAutoRefresh() {
    if (this.autoRefreshInterval) {
      return;
    }

    this.autoRefreshInterval = setInterval(() => {
      this.refreshCurrentPage({ silent: true }).catch(err => {
        console.error('Auto refresh failed:', err);
      });
    }, 30000); // 30 seconds
  },

  // ===== Events =====
  bindEvents() {
    // Navigation
    document.querySelectorAll('.nav-item').forEach(el => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        this.navigateTo(el.dataset.page);
      });
    });

    // Mobile menu
    document.getElementById('menu-toggle').addEventListener('click', () => {
      document.getElementById('sidebar').classList.toggle('open');
    });

    // Header actions
    document.getElementById('btn-refresh').addEventListener('click', async () => {
      await this.refreshCurrentPage();
      this.toast('数据已刷新', 'info');
    });

    document.querySelectorAll('[data-dashboard-action]').forEach(card => {
      const run = () => this.handleDashboardStatAction(card.dataset.dashboardAction || '');
      card.addEventListener('click', run);
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          run();
        }
      });
    });

    document.getElementById('btn-check-all').addEventListener('click', () => {
      this.runFullCheck();
    });

    const btnSyncQuotas = document.getElementById('btn-sync-quotas');
    if (btnSyncQuotas) {
      btnSyncQuotas.addEventListener('click', () => {
        this.syncAllQuotas();
      });
    }

    const btnInviteHealth = document.getElementById('btn-invite-health');
    if (btnInviteHealth) {
      btnInviteHealth.addEventListener('click', () => {
        this.openInviteHealthModal();
      });
    }

    const btnRefreshOverflowRecords = document.getElementById('btn-refresh-overflow-records');
    if (btnRefreshOverflowRecords) {
      btnRefreshOverflowRecords.addEventListener('click', () => {
        this.loadOverflowRebalanceRecords();
      });
    }

    // Account actions
    document.getElementById('btn-add-account').addEventListener('click', () => {
      this.showAddModal();
    });

    const btnBulkAutoInvite = document.getElementById('btn-bulk-auto-invite');
    if (btnBulkAutoInvite) {
      btnBulkAutoInvite.addEventListener('click', () => {
        this.openBulkAutoInviteModal();
      });
    }

    const btnAutoInvite = document.getElementById('btn-auto-invite');
    if (btnAutoInvite) {
      btnAutoInvite.addEventListener('click', () => {
        this.openAutoInviteModal();
      });
    }

    document.getElementById('btn-import').addEventListener('click', () => {
      this.showImportModal();
    });

    // Search
    document.getElementById('search-input').addEventListener('input', () => {
      clearTimeout(this.searchTimeout);
      this.searchTimeout = setTimeout(() => this.loadAccounts(1), 300);
    });

    // Status filter
    document.getElementById('status-filter').addEventListener('change', () => {
      this.loadAccounts(1);
    });

    // Select all checkbox
    document.getElementById('select-all-checkbox').addEventListener('change', (e) => {
      const checkboxes = document.querySelectorAll('.account-checkbox');
      this.selectedIds.clear();
      checkboxes.forEach(cb => {
        cb.checked = e.target.checked;
        if (e.target.checked) {
          this.selectedIds.add(parseInt(cb.dataset.id));
        }
      });
      this.updateBulkActions();
    });

    // Delegate account checkbox clicks
    document.getElementById('accounts-tbody').addEventListener('change', (e) => {
      if (e.target.classList.contains('account-checkbox')) {
        const id = parseInt(e.target.dataset.id);
        if (e.target.checked) {
          this.selectedIds.add(id);
        } else {
          this.selectedIds.delete(id);
        }
        this.updateBulkActions();
      }
    });

    // Bulk delete
    document.getElementById('btn-bulk-delete').addEventListener('click', () => {
      this.bulkDelete();
    });

    // Modal close
    document.getElementById('modal-close').addEventListener('click', () => {
      this.closeModal();
    });
    document.getElementById('modal-overlay').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) this.closeModal();
    });

    // Settings
    document.getElementById('btn-save-telegram').addEventListener('click', () => {
      this.saveSettings('telegram');
    });
    document.getElementById('btn-test-telegram').addEventListener('click', () => {
      this.testTelegram();
    });
    document.getElementById('btn-save-schedule').addEventListener('click', () => {
      this.saveSettings('schedule');
    });
    document.getElementById('btn-save-public-tunnel').addEventListener('click', () => {
      this.saveSettings('public-tunnel');
    });
    document.getElementById('btn-save-dashboard-cdk-price').addEventListener('click', () => {
      this.saveCdkPriceSetting();
    });

    // Invites
    const searchInvitesInput = document.getElementById('search-invites-input');
    if (searchInvitesInput) {
      let timeout = null;
      searchInvitesInput.addEventListener('input', () => {
        clearTimeout(timeout);
        timeout = setTimeout(() => this.loadInvites(1), 500);
      });
    }

    const btnRefreshInvites = document.getElementById('btn-refresh-invites');
    if (btnRefreshInvites) {
      btnRefreshInvites.addEventListener('click', () => {
        this.loadInvites(this.currentInvitesPage);
      });
    }

    const btnSyncWorkspaces = document.getElementById('btn-sync-workspaces');
    if (btnSyncWorkspaces) {
      btnSyncWorkspaces.addEventListener('click', () => {
        this.syncAllWorkspaces();
      });
    }

    const searchWorkspacesInput = document.getElementById('search-workspaces-input');
    if (searchWorkspacesInput) {
      let timeout = null;
      searchWorkspacesInput.addEventListener('input', () => {
        clearTimeout(timeout);
        timeout = setTimeout(() => this.loadWorkspaces(1), 400);
      });
    }

    const workspaceSyncFilter = document.getElementById('workspace-sync-filter');
    if (workspaceSyncFilter) {
      workspaceSyncFilter.addEventListener('change', () => {
        this.loadWorkspaces(1);
      });
    }

    const workspaceCapacityFilter = document.getElementById('workspace-capacity-filter');
    if (workspaceCapacityFilter) {
      workspaceCapacityFilter.addEventListener('change', () => {
        this.loadWorkspaces(1);
      });
    }

    const workspaceSortBy = document.getElementById('workspace-sort-by');
    if (workspaceSortBy) {
      workspaceSortBy.addEventListener('change', () => {
        this.loadWorkspaces(1);
      });
    }

    const workspaceSortDirection = document.getElementById('workspace-sort-direction');
    if (workspaceSortDirection) {
      workspaceSortDirection.addEventListener('change', () => {
        this.loadWorkspaces(1);
      });
    }

    const btnResetWorkspaceFilters = document.getElementById('btn-reset-workspace-filters');
    if (btnResetWorkspaceFilters) {
      btnResetWorkspaceFilters.addEventListener('click', () => {
        this.resetWorkspaceFilters();
      });
    }

    const btnWorkspaceMemberSearch = document.getElementById('btn-workspace-member-search');
    if (btnWorkspaceMemberSearch) {
      btnWorkspaceMemberSearch.addEventListener('click', () => {
        this.searchWorkspaceMembers();
      });
    }

    const workspaceMemberSearchInput = document.getElementById('workspace-member-search-input');
    if (workspaceMemberSearchInput) {
      workspaceMemberSearchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          this.searchWorkspaceMembers();
        }
      });
    }

    const btnRunAudit = document.getElementById('btn-run-audit');
    if (btnRunAudit) {
      btnRunAudit.addEventListener('click', () => {
        this.runEmailAudit();
      });
    }

    const btnOpenBatchAudit = document.getElementById('btn-open-batch-audit');
    if (btnOpenBatchAudit) {
      btnOpenBatchAudit.addEventListener('click', () => {
        this.openBatchAuditModal();
      });
    }

    const auditEmailInput = document.getElementById('audit-email-input');
    if (auditEmailInput) {
      auditEmailInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          this.runEmailAudit();
        }
      });
    }

    const auditRecommendationFilter = document.getElementById('audit-recommendation-filter');
    if (auditRecommendationFilter) {
      auditRecommendationFilter.addEventListener('change', () => {
        this.renderAudit();
      });
    }

    const auditPresenceFilter = document.getElementById('audit-presence-filter');
    if (auditPresenceFilter) {
      auditPresenceFilter.addEventListener('change', () => {
        this.renderAudit();
      });
    }

    const auditHistoryFilter = document.getElementById('audit-history-filter');
    if (auditHistoryFilter) {
      auditHistoryFilter.addEventListener('change', () => {
        this.renderAudit();
      });
    }

    const btnClearAudit = document.getElementById('btn-clear-audit');
    if (btnClearAudit) {
      btnClearAudit.addEventListener('click', () => {
        this.clearAudit();
      });
    }

    const btnAuditBulkRemove = document.getElementById('btn-audit-bulk-remove');
    if (btnAuditBulkRemove) {
      btnAuditBulkRemove.addEventListener('click', () => {
        this.removeAuditMembersBatch();
      });
    }

    const memberCleanupSearchInput = document.getElementById('member-cleanup-search-input');
    if (memberCleanupSearchInput) {
      memberCleanupSearchInput.addEventListener('input', () => {
        clearTimeout(this.memberCleanupSearchTimeout);
        this.memberCleanupSearchTimeout = setTimeout(() => {
          this.memberCleanupSelection = new Set();
          this.loadMemberCleanup();
        }, 300);
      });
    }

    const memberCleanupTypeFilter = document.getElementById('member-cleanup-type-filter');
    if (memberCleanupTypeFilter) {
      memberCleanupTypeFilter.addEventListener('change', () => {
        this.memberCleanupSelection = new Set();
        this.loadMemberCleanup();
      });
    }

    const memberCleanupDateFilter = document.getElementById('member-cleanup-date-filter');
    if (memberCleanupDateFilter) {
      memberCleanupDateFilter.addEventListener('change', () => {
        this.memberCleanupSelection = new Set();
        this.loadMemberCleanup();
      });
    }

    const memberCleanupAgeFilter = document.getElementById('member-cleanup-age-filter');
    if (memberCleanupAgeFilter) {
      memberCleanupAgeFilter.addEventListener('change', () => {
        this.memberCleanupSelection = new Set();
        this.loadMemberCleanup();
      });
    }

    const btnResetMemberCleanup = document.getElementById('btn-reset-member-cleanup');
    if (btnResetMemberCleanup) {
      btnResetMemberCleanup.addEventListener('click', () => {
        const searchInput = document.getElementById('member-cleanup-search-input');
        const typeFilter = document.getElementById('member-cleanup-type-filter');
        const dateFilter = document.getElementById('member-cleanup-date-filter');
        const ageFilter = document.getElementById('member-cleanup-age-filter');
        if (searchInput) searchInput.value = '';
        if (typeFilter) typeFilter.value = 'all';
        if (dateFilter) dateFilter.value = '';
        if (ageFilter) ageFilter.value = '';
        this.memberCleanupSelection = new Set();
        this.loadMemberCleanup();
      });
    }

    const btnRefreshMemberCleanup = document.getElementById('btn-refresh-member-cleanup');
    if (btnRefreshMemberCleanup) {
      btnRefreshMemberCleanup.addEventListener('click', () => {
        this.loadMemberCleanup();
      });
    }

    const btnSyncMemberCleanup = document.getElementById('btn-sync-member-cleanup');
    if (btnSyncMemberCleanup) {
      btnSyncMemberCleanup.addEventListener('click', async () => {
        await this.syncAllWorkspaces();
        await this.loadMemberCleanup();
      });
    }

    const btnMemberCleanupSelectAll = document.getElementById('btn-member-cleanup-select-all');
    if (btnMemberCleanupSelectAll) {
      btnMemberCleanupSelectAll.addEventListener('click', () => {
        this.toggleMemberCleanupSelectAll();
      });
    }

    const btnMemberCleanupClearSelection = document.getElementById('btn-member-cleanup-clear-selection');
    if (btnMemberCleanupClearSelection) {
      btnMemberCleanupClearSelection.addEventListener('click', () => {
        this.clearMemberCleanupSelection();
      });
    }

    const btnMemberCleanupKickSelected = document.getElementById('btn-member-cleanup-kick-selected');
    if (btnMemberCleanupKickSelected) {
      btnMemberCleanupKickSelected.addEventListener('click', () => {
        this.removeSelectedMemberCleanupMembers();
      });
    }

    const btnMemberCleanupRevokeSelected = document.getElementById('btn-member-cleanup-revoke-selected');
    if (btnMemberCleanupRevokeSelected) {
      btnMemberCleanupRevokeSelected.addEventListener('click', () => {
        this.revokeSelectedMemberCleanupInvites();
      });
    }

    const staleMembersAutoKickEnabled = document.getElementById('stale-members-auto-kick-enabled');
    if (staleMembersAutoKickEnabled) {
      staleMembersAutoKickEnabled.addEventListener('change', () => {
        this.saveStaleMemberAutoKickSetting();
      });
    }

    const staleMembersAutoKickHours = document.getElementById('stale-members-auto-kick-hours');
    if (staleMembersAutoKickHours) {
      staleMembersAutoKickHours.addEventListener('change', () => {
        this.saveStaleMemberAutoKickSetting();
      });
    }

    const btnSaveStaleMemberAutoKick = document.getElementById('btn-save-stale-member-auto-kick');
    if (btnSaveStaleMemberAutoKick) {
      btnSaveStaleMemberAutoKick.addEventListener('click', () => {
        this.saveStaleMemberAutoKickSetting();
      });
    }

    const btnRunStaleMemberAutoKick = document.getElementById('btn-run-stale-member-auto-kick');
    if (btnRunStaleMemberAutoKick) {
      btnRunStaleMemberAutoKick.addEventListener('click', () => {
        this.runStaleMemberAutoKickNow();
      });
    }

    const untrackedMembersSearchInput = document.getElementById('untracked-members-search-input');
    if (untrackedMembersSearchInput) {
      untrackedMembersSearchInput.addEventListener('input', () => {
        clearTimeout(this.untrackedMembersSearchTimeout);
        this.untrackedMembersSearchTimeout = setTimeout(() => {
          this.untrackedMembersSelection = new Set();
          this.loadUntrackedMembers();
        }, 300);
      });
    }

    const btnRefreshUntrackedMembers = document.getElementById('btn-refresh-untracked-members');
    if (btnRefreshUntrackedMembers) {
      btnRefreshUntrackedMembers.addEventListener('click', () => {
        this.loadUntrackedMembers();
      });
    }

    const btnSyncUntrackedMembers = document.getElementById('btn-sync-untracked-members');
    if (btnSyncUntrackedMembers) {
      btnSyncUntrackedMembers.addEventListener('click', async () => {
        await this.syncAllWorkspaces();
        await this.loadUntrackedMembers();
      });
    }

    const untrackedAutoKickEnabled = document.getElementById('untracked-auto-kick-enabled');
    if (untrackedAutoKickEnabled) {
      untrackedAutoKickEnabled.addEventListener('change', () => {
        this.saveUntrackedAutoKickSetting();
      });
    }

    const btnRunUntrackedAutoKick = document.getElementById('btn-run-untracked-auto-kick');
    if (btnRunUntrackedAutoKick) {
      btnRunUntrackedAutoKick.addEventListener('click', () => {
        this.runUntrackedAutoKickNow();
      });
    }

    const btnUntrackedMembersSelectAll = document.getElementById('btn-untracked-members-select-all');
    if (btnUntrackedMembersSelectAll) {
      btnUntrackedMembersSelectAll.addEventListener('click', () => {
        this.toggleUntrackedMembersSelectAll();
      });
    }

    const btnUntrackedMembersClearSelection = document.getElementById('btn-untracked-members-clear-selection');
    if (btnUntrackedMembersClearSelection) {
      btnUntrackedMembersClearSelection.addEventListener('click', () => {
        this.clearUntrackedMembersSelection();
      });
    }

    const btnUntrackedMembersKickSelected = document.getElementById('btn-untracked-members-kick-selected');
    if (btnUntrackedMembersKickSelected) {
      btnUntrackedMembersKickSelected.addEventListener('click', () => {
        this.removeSelectedUntrackedMembers();
      });
    }

    const btnParseCheckoutTool = document.getElementById('btn-parse-checkout-tool');
    if (btnParseCheckoutTool) {
      btnParseCheckoutTool.addEventListener('click', () => {
        this.parseCheckoutTool();
      });
    }

    const modeSelect = document.getElementById('checkout-tool-mode');
    if (modeSelect) {
      modeSelect.addEventListener('change', (e) => {
        const mode = e.target.value;
        const apiGroup = document.getElementById('checkout-tool-api-group');
        const cardGroup = document.getElementById('checkout-tool-card-group');
        if (mode === 'api') {
          apiGroup.classList.remove('hidden');
          cardGroup.classList.add('hidden');
        } else {
          apiGroup.classList.add('hidden');
          cardGroup.classList.remove('hidden');
        }
      });
    }

    const btnClearCheckoutTool = document.getElementById('btn-clear-checkout-tool');
    if (btnClearCheckoutTool) {
      btnClearCheckoutTool.addEventListener('click', () => {
        this.clearCheckoutToolForm();
      });
    }

    const searchCheckoutToolsInput = document.getElementById('search-checkout-tools-input');
    if (searchCheckoutToolsInput) {
      let timeout = null;
      searchCheckoutToolsInput.addEventListener('input', () => {
        clearTimeout(timeout);
        timeout = setTimeout(() => this.loadCheckoutTools(), 300);
      });
    }

    const btnRefreshCheckoutTools = document.getElementById('btn-refresh-checkout-tools');
    if (btnRefreshCheckoutTools) {
      btnRefreshCheckoutTools.addEventListener('click', () => {
        this.loadCheckoutTools();
      });
    }

    ['checkout-tool-input', 'checkout-redeem-code', 'checkout-tool-note'].forEach(id => {
      const element = document.getElementById(id);
      if (!element) return;
      element.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.parseCheckoutTool();
        }
      });
    });

    const btnCdkGenerate = document.getElementById('btn-cdk-generate');
    if (btnCdkGenerate) {
      btnCdkGenerate.addEventListener('click', () => {
        this.generateCdk();
      });
    }

    const btnRefreshCdk = document.getElementById('btn-refresh-cdk');
    if (btnRefreshCdk) {
      btnRefreshCdk.addEventListener('click', () => {
        this.loadCdkPage();
      });
    }

    const btnCdkDeleteUsed = document.getElementById('btn-cdk-delete-used');
    if (btnCdkDeleteUsed) {
      btnCdkDeleteUsed.addEventListener('click', () => {
        this.batchDeleteCdk('used');
      });
    }

    const cdkStatusFilter = document.getElementById('cdk-status-filter');
    if (cdkStatusFilter) {
      cdkStatusFilter.addEventListener('change', () => {
        this.loadCdkPage({ resetPages: true });
      });
    }

    const cdkSearchInput = document.getElementById('cdk-search-input');
    if (cdkSearchInput) {
      let timeout = null;
      cdkSearchInput.addEventListener('input', () => {
        clearTimeout(timeout);
        timeout = setTimeout(() => this.loadCdkPage({ resetPages: true }), 300);
      });
    }

    const btnCdkTrace = document.getElementById('btn-cdk-trace');
    if (btnCdkTrace) {
      btnCdkTrace.addEventListener('click', () => {
        this.traceCdk();
      });
    }

    const cdkTraceInput = document.getElementById('cdk-trace-input');
    if (cdkTraceInput) {
      cdkTraceInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          this.traceCdk();
        }
      });
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closeModal();
    });
  },
};

App.oauthAccount = async function(id) {
  this.toast('正在启动 OAuth 授权...', 'info');
  try {
    const account = Array.isArray(this.accounts)
      ? this.accounts.find(item => Number(item.id) === Number(id))
      : null;
    const result = await API.startOAuth(id);
    const popup = window.open(result.authUrl, '_blank', 'noopener,noreferrer');
    this.showModal('完成 OAuth 授权', Components.oauthAssistModal(account, result.authUrl), { type: 'oauth' });
    document.getElementById('oauth-callback-url')?.focus();
    this.toast(
      popup
        ? '授权页已打开，完成登录后把 localhost 回调链接贴回弹窗即可完成授权'
        : '浏览器拦截了新标签页，请点击弹窗里的“打开授权页”继续授权',
      popup ? 'info' : 'warning'
    );
    setTimeout(() => this.loadAccounts(), 5000);
    setTimeout(() => this.loadAccounts(), 15000);
    setTimeout(() => this.loadAccounts(), 30000);
  } catch (err) {
    this.toast(`OAuth 启动失败: ${err.message}`, 'error');
  }
};

App.completeOAuthFromCallback = async function() {
  const input = document.getElementById('oauth-callback-url');
  const button = document.getElementById('btn-complete-oauth');
  const callbackUrl = String(input?.value || '').trim();

  if (!callbackUrl) {
    this.toast('请先粘贴完整的回调链接', 'warning');
    input?.focus();
    return;
  }

  if (!/^https?:\/\/localhost:1455\/auth\/callback/i.test(callbackUrl)) {
    this.toast('请粘贴完整的 localhost:1455/auth/callback 回调地址', 'warning');
    input?.focus();
    return;
  }

  if (button) {
    button.disabled = true;
    button.textContent = '正在完成授权...';
  }

  try {
    const result = await API.completeOAuth(callbackUrl);
    this.toast(result.message || 'OAuth 授权已完成', 'success');
    this.closeModal();
    await this.refreshWorkspaceChangeSurfaces({
      includeLogs: this.currentPage === 'dashboard',
      includeCurrentPage: true,
    });
  } catch (err) {
    this.toast(`OAuth 完成失败: ${err.message}`, 'error');
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = '完成授权';
    }
  }
};

// Start the app
document.addEventListener('DOMContentLoaded', () => App.init());

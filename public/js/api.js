// API Client for OpenAI Monitor

const API = {
  base: '',

  async request(url, options = {}) {
    const res = await fetch(this.base + url, {
      headers: { 'Content-Type': 'application/json', ...options.headers },
      ...options,
    });

    const contentType = res.headers.get('content-type') || '';
    const isJson = contentType.includes('application/json');
    const rawText = await res.text();
    const data = !rawText
      ? null
      : isJson
        ? JSON.parse(rawText)
        : { error: rawText };

    if (!res.ok) {
      throw new Error(data?.error || rawText || `HTTP ${res.status}`);
    }

    return data || {};
  },

  // Accounts
  getAccounts(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.request(`/api/accounts?${qs}`);
  },

  getOverflowRebalanceRecords(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.request(`/api/accounts/overflow-rebalance-records${qs ? `?${qs}` : ''}`);
  },

  getStats() {
    return this.request('/api/accounts/stats');
  },

  getSystemMetrics() {
    return this.request('/api/system/metrics');
  },

  getInvalidAccounts() {
    return this.request('/api/accounts/invalid-credentials');
  },

  getInviteHealth(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.request(`/api/accounts/invite-health${qs ? `?${qs}` : ''}`);
  },

  restoreInviteHealth(id) {
    return this.request(`/api/accounts/${id}/restore-invite-health`, {
      method: 'POST',
    });
  },

  restoreAllInviteHealth() {
    return this.request('/api/accounts/restore-invite-health', {
      method: 'POST',
    });
  },

  syncAllQuotas() {
    return this.request('/api/accounts/sync-quotas', {
      method: 'POST',
    });
  },

  addAccount(data) {
    return this.request('/api/accounts', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  batchImport(accounts) {
    return this.request('/api/accounts/batch', {
      method: 'POST',
      body: JSON.stringify({ accounts }),
    });
  },

  updateAccount(id, data) {
    return this.request(`/api/accounts/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },

  syncAccountQuota(id) {
    return this.request(`/api/accounts/${id}/sync-quota`, {
      method: 'POST',
    });
  },

  getAccountWorkspaces(id) {
    return this.request(`/api/accounts/${id}/workspaces`);
  },

  inviteAccount(id, email, options = {}) {
    return this.request(`/api/accounts/${id}/invite`, {
      method: 'POST',
      body: JSON.stringify({ email, ...options }),
    });
  },

  autoInvite(email) {
    return this.request('/api/accounts/auto-invite', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
  },

  deleteAccount(id) {
    return this.request(`/api/accounts/${id}`, {
      method: 'DELETE',
    });
  },

  deleteAccounts(ids) {
    return this.request('/api/accounts', {
      method: 'DELETE',
      body: JSON.stringify({ ids }),
    });
  },

  getMembers(accountId, params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.request(`/api/members/${accountId}${qs ? `?${qs}` : ''}`);
  },

  getMemberDetail(accountId, userId, params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.request(`/api/members/${accountId}/${encodeURIComponent(userId)}/detail${qs ? `?${qs}` : ''}`);
  },

  updateMember(accountId, userId, data, params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.request(`/api/members/${accountId}/${encodeURIComponent(userId)}${qs ? `?${qs}` : ''}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  },

  removeMember(accountId, userId, params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.request(`/api/members/${accountId}/${encodeURIComponent(userId)}${qs ? `?${qs}` : ''}`, {
      method: 'DELETE',
    });
  },

  removeMembersBatch(members = [], options = {}) {
    return this.request('/api/members/batch-remove', {
      method: 'POST',
      body: JSON.stringify({ members, ...options }),
    });
  },

  logoutMember(accountId, userId, params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.request(`/api/members/${accountId}/${encodeURIComponent(userId)}/logout${qs ? `?${qs}` : ''}`, {
      method: 'POST',
    });
  },

  getInvites(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.request(`/api/invites?${qs}`);
  },

  deleteInvite(id) {
    return this.request(`/api/invites/${id}`, {
      method: 'DELETE',
    });
  },

  getWorkspaceDashboard() {
    return this.request('/api/workspaces/dashboard');
  },

  getWorkspaces(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.request(`/api/workspaces${qs ? `?${qs}` : ''}`);
  },

  getMemberCleanup(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.request(`/api/workspaces/member-cleanup${qs ? `?${qs}` : ''}`);
  },

  getUntrackedMembers(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.request(`/api/workspaces/untracked-members${qs ? `?${qs}` : ''}`);
  },

  runUntrackedAutoKick(limit = 100) {
    return this.request('/api/workspaces/untracked-members/auto-kick', {
      method: 'POST',
      body: JSON.stringify({ limit }),
    });
  },

  runStaleMemberAutoKick(hours, limit = 100) {
    return this.request('/api/workspaces/member-cleanup/stale-auto-kick', {
      method: 'POST',
      body: JSON.stringify({ hours, limit }),
    });
  },

  syncAllWorkspaces() {
    return this.request('/api/workspaces/sync', {
      method: 'POST',
    });
  },

  syncWorkspace(id) {
    return this.request(`/api/workspaces/${id}/sync`, {
      method: 'POST',
    });
  },

  setWorkspaceInviteLock(id, inviteLocked) {
    return this.request(`/api/workspaces/${id}/lock`, {
      method: 'POST',
      body: JSON.stringify({ invite_locked: inviteLocked }),
    });
  },

  getWorkspaceExportUrl(id) {
    return `/api/workspaces/${id}/export`;
  },

  searchWorkspaceMembers(query) {
    const qs = new URLSearchParams({ query }).toString();
    return this.request(`/api/workspaces/member-search?${qs}`);
  },

  getWorkspaceRecommendations(email) {
    const qs = new URLSearchParams({ email }).toString();
    return this.request(`/api/workspaces/recommend?${qs}`);
  },

  getEmailAudit(email) {
    const qs = new URLSearchParams({ email }).toString();
    return this.request(`/api/workspaces/audit?${qs}`);
  },

  batchEmailAudit(emails) {
    return this.request('/api/workspaces/batch-audit', {
      method: 'POST',
      body: JSON.stringify({ emails }),
    });
  },

  revokePendingInvite(accountId, data = {}) {
    return this.request(`/api/members/${accountId}/pending-invites/revoke`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  getCheckoutTools(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.request(`/api/checkout-tools${qs ? `?${qs}` : ''}`);
  },

  parseCheckoutTool(data) {
    return this.request('/api/checkout-tools/parse', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  touchCheckoutTool(id, action) {
    return this.request(`/api/checkout-tools/${id}/touch`, {
      method: 'POST',
      body: JSON.stringify({ action }),
    });
  },

  deleteCheckoutTool(id) {
    return this.request(`/api/checkout-tools/${id}`, {
      method: 'DELETE',
    });
  },

  autosubCheckoutTool(id) {
    return this.request(`/api/checkout-tools/${id}/autosub`, {
      method: 'POST',
    });
  },

  // CDK
  getCdkList(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.request(`/api/cdk/list${qs ? `?${qs}` : ''}`);
  },

  generateCdk(data) {
    return this.request('/api/cdk/generate', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  deleteCdk(id) {
    return this.request(`/api/cdk/${id}`, {
      method: 'DELETE',
    });
  },

  batchDeleteCdk(status) {
    return this.request('/api/cdk/batch-delete', {
      method: 'POST',
      body: JSON.stringify({ status }),
    });
  },

  getCdkTasks(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.request(`/api/cdk/tasks${qs ? `?${qs}` : ''}`);
  },

  traceCdk(search) {
    const qs = new URLSearchParams({ search }).toString();
    return this.request(`/api/cdk/trace?${qs}`);
  },

  getPaymentOrders(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.request(`/api/payments/orders${qs ? `?${qs}` : ''}`);
  },

  manualDeliverPaymentOrder(orderNo, data = {}) {
    return this.request(`/api/payments/orders/${encodeURIComponent(orderNo)}/manual-deliver`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  // Checks
  runCheckAll() {
    return this.request('/api/checks/run', { method: 'POST' });
  },

  checkAccount(id) {
    return this.request(`/api/checks/${id}`, { method: 'POST' });
  },

  getCheckStatus() {
    return this.request('/api/checks/status');
  },

  startOAuth(id) {
    return this.request(`/api/checks/oauth/start/${id}`, { method: 'POST' });
  },

  completeOAuth(callbackUrl) {
    return this.request('/api/checks/oauth/complete', {
      method: 'POST',
      body: JSON.stringify({ callback_url: callbackUrl }),
    });
  },

  getLogs(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.request(`/api/checks/logs?${qs}`);
  },

  // Settings
  getSettings() {
    return this.request('/api/settings');
  },

  updateSettings(data) {
    return this.request('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },

  testTelegram() {
    return this.request('/api/settings/test-telegram', { method: 'POST' });
  },
};

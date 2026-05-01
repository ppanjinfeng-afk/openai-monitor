// UI Components

const Components = {
  statusLabels: {
    active: '\u6d3b\u8dc3',
    banned: '\u5c01\u7981',
    invalid_credentials: '\u4ee4\u724c\u65e0\u6548',
    rate_limited: '\u9650\u6d41',
    error: '\u9519\u8bef',
    unknown: '\u672a\u77e5',
    no_password: '\u65e0\u5bc6\u7801',
    sent: '\u5df2\u53d1\u9001',
    accepted: '\u5df2\u63a5\u53d7',
  },

  quotaSyncLabels: {
    success: '\u540c\u6b65\u6210\u529f',
    error: '\u540c\u6b65\u5931\u8d25',
    skipped: '\u5df2\u8df3\u8fc7',
    running: '\u540c\u6b65\u4e2d',
    never: '\u672a\u540c\u6b65',
  },

  memberRoleLabels: {
    'account-owner': '\u6240\u6709\u8005',
    'account-admin': '\u7ba1\u7406\u5458',
    'standard-user': '\u666e\u901a\u6210\u5458',
    'analytics-viewer': '\u5206\u6790\u67e5\u770b\u8005',
  },

  seatTypeLabels: {
    default: '\u9ed8\u8ba4\u5e2d\u4f4d',
    flexible: '\u5f39\u6027\u5e2d\u4f4d',
    none: '\u4e0d\u5360\u5e2d',
  },

  statusBadge(status) {
    const label = this.statusLabels[status] || status;
    return `<span class="status-badge ${status}">${this.escapeHtml(label)}</span>`;
  },

  quotaSyncBadge(status) {
    const normalized = status || 'never';
    const label = this.quotaSyncLabels[normalized] || normalized;
    return `<span class="quota-sync-badge ${normalized}">${this.escapeHtml(label)}</span>`;
  },

  workspaceSyncBadge(status) {
    const labels = {
      success: '\u540c\u6b65\u6210\u529f',
      error: '\u540c\u6b65\u5931\u8d25',
      stale: '\u672a\u518d\u8fd4\u56de',
      never: '\u672a\u540c\u6b65',
    };
    const normalized = status || 'never';
    return `<span class="quota-sync-badge ${normalized}">${this.escapeHtml(labels[normalized] || normalized)}</span>`;
  },

  alertTypeLabel(type) {
    const labels = {
      full_quota: '\u6ee1\u989d\u9884\u8b66',
      over_quota: '\u8d85\u989d\u9884\u8b66',
      sync_error: '\u540c\u6b65\u5f02\u5e38',
      health: '\u5065\u5eb7\u9884\u8b66',
    };
    return labels[type] || type || '\u9884\u8b66';
  },

  healthBadge(score, label) {
    const safeScore = Number(score || 0);
    let tone = 'danger';
    if (safeScore >= 85) tone = 'success';
    else if (safeScore >= 65) tone = 'accent';
    else if (safeScore >= 40) tone = 'warning';

    return this.quotaPill(`${label || '\u5065\u5eb7'} ${safeScore}`, tone, '\u8d26\u53f7\u72b6\u6001\u3001\u540c\u6b65\u7ed3\u679c\u3001\u5269\u4f59\u540d\u989d\u548c\u6700\u8fd1\u9519\u8bef\u5171\u540c\u8ba1\u7b97');
  },

  inviteHealthBadge(account) {
    if (!account?.access_token) {
      return '';
    }

    const status = account.invite_health_status || 'healthy';
    const label = account.invite_health_label || (status === 'degraded' ? '坏号' : status === 'warning' ? '待观察' : '正常');
    const materializeFailures = Number(account.recent_materialize_failures || 0);
    const retryFailures = Number(account.recent_retry_failures || 0);
    const recentSuccesses = Number(account.recent_invite_successes || 0);

    let tone = 'success';
    if (status === 'degraded') tone = 'danger';
    else if (status === 'warning') tone = 'warning';

    const title = [
      `假成功未落地: ${materializeFailures}`,
      `补发/撤销异常: ${retryFailures}`,
      `最近成功邀请: ${recentSuccesses}`,
    ].join(' · ');

    return this.quotaPill(`邀请${label}`, tone, title);
  },

  invitePauseBadge(account) {
    if (!Number(account?.invite_paused || 0)) {
      return '';
    }

    return this.quotaPill('已暂停邀请', 'danger', account.invite_pause_reason || '该账号已被系统暂停邀请');
  },

  overflowRebalanceBadges(account) {
    const overflow = Number(account?.workspace_overflow_count || 0);
    const status = String(account?.overflow_rebalance_status || '').trim().toLowerCase();
    const message = String(account?.overflow_rebalance_message || '').trim();
    const checkedAt = String(account?.overflow_rebalance_checked_at || '').trim();
    const tooltipParts = [];

    if (message) {
      tooltipParts.push(message);
    }
    if (checkedAt) {
      tooltipParts.push(`最近处理 ${this.timeAgo(checkedAt)} · ${this.formatDateTime(checkedAt)}`);
    }

    const tooltip = tooltipParts.join(' | ');

    if (overflow > 0) {
      return `
        <div class="quota-breakdown">
          ${this.quotaPill(`超员 ${overflow}`, 'danger', `当前成员总数超出上限 ${overflow} 人`)}
          ${this.quotaPill(status === 'error' ? '待迁移修复' : '自动迁移中', status === 'error' ? 'warning' : 'accent', tooltip || '系统会自动把超出的成员迁移到其他可用账号')}
        </div>
      `;
    }

    if (status === 'active' && checkedAt && this.isRecent(checkedAt, 12)) {
      return `
        <div class="quota-breakdown">
          ${this.quotaPill('最近已迁移', 'success', tooltip || '最近一次超员成员自动迁移已完成')}
        </div>
      `;
    }

    return '';
  },

  shortId(value) {
    if (!value) return '';
    const str = String(value);
    if (str.length <= 16) return str;
    return `${str.slice(0, 8)}...${str.slice(-6)}`;
  },

  jsString(value) {
    return JSON.stringify(value == null ? '' : String(value))
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  },

  memberRoleLabel(role) {
    return this.memberRoleLabels[role] || role || '\u672a\u8bbe\u7f6e';
  },

  seatTypeLabel(seatType) {
    return this.seatTypeLabels[seatType] || seatType || '\u672a\u77e5';
  },

  inviteModeLabel(invite) {
    return invite.delivery_type === 'resend' ? '\u8865\u53d1' : '\u53d1\u9001';
  },

  inviteWorkspaceLabel(invite) {
    return invite.workspace_name || invite.workspace_id || '\u9ed8\u8ba4\u5de5\u4f5c\u533a';
  },

  recommendationLabel(state) {
    const labels = {
      available: '\u53ef\u9080\u8bf7',
      pending: '\u5f85\u63a5\u53d7',
      member: '\u5df2\u5728\u56e2\u5185',
      cooldown: '\u51b7\u5374\u4e2d',
      locked: '\u5df2\u9501\u5b9a',
      full: '\u5df2\u6ee1',
    };
    return labels[state] || state || '\u672a\u77e5';
  },

  quotaPill(label, tone = 'neutral', title = '') {
    const titleAttr = title ? ` title="${this.escapeHtml(title)}"` : '';
    return `<span class="quota-pill ${tone}"${titleAttr}>${this.escapeHtml(label)}</span>`;
  },

  inviteProgress(used, total) {
    const safeUsed = Number(used || 0);
    const safeTotal = Number(total || 0);
    const rawPct = safeTotal > 0 ? (safeUsed / safeTotal) * 100 : 0;
    const pct = Math.max(0, Math.min(rawPct, 100));

    let level = 'low';
    if (safeUsed > safeTotal) level = 'over';
    else if (rawPct >= 75) level = 'high';
    else if (rawPct >= 50) level = 'medium';

    return `
      <div class="invite-progress">
        <div class="invite-bar">
          <div class="invite-bar-fill ${level}" style="width:${pct}%"></div>
        </div>
        <span class="invite-text ${level === 'over' ? 'over' : ''}">${safeUsed}/${safeTotal}</span>
      </div>
    `;
  },

  accountQuotaNumbers(account) {
    const syncSuccess = account.quota_sync_status === 'success';
    const localOccupied = Number(account.invited_count || 0);
    const accountOccupied = syncSuccess ? Number(account.quota_member_seats || localOccupied) : localOccupied;
    const accountPending = syncSuccess ? Number(account.quota_pending_invites || 0) : 0;
    const accountTotalUsers = syncSuccess ? Number(account.quota_total_users || 0) : 0;
    const accountTotal = Number(account.invite_total || 0);

    const workspaceOccupied = Number(account.workspace_occupied_seats || 0);
    const workspacePending = Number(account.workspace_pending_invites || 0);
    const workspaceMembers = Number(account.workspace_member_count || 0);
    const workspaceTotal = Number(account.workspace_invite_total_hint || 0);

    const occupied = Math.max(accountOccupied, workspaceOccupied);
    const pendingKnown = syncSuccess || accountPending > 0 || workspacePending > 0;
    const pending = pendingKnown ? Math.max(accountPending, workspacePending) : null;
    const totalUsers = (syncSuccess || workspaceMembers > 0)
      ? Math.max(accountTotalUsers, workspaceMembers)
      : null;
    const total = Math.max(accountTotal, workspaceTotal);
    const reserved = occupied + (pending || 0);

    return {
      occupied,
      pending,
      totalUsers,
      total,
      reserved,
      memberSlots: total - occupied,
      saleableRemaining: total - reserved,
    };
  },

  parseDate(dateStr) {
    if (!dateStr) return null;

    const value = String(dateStr).trim();
    if (!value) return null;

    const normalized = value.includes('T') ? value : value.replace(' ', 'T');
    const hasTimezone = /(?:Z|[+-]\d\d:\d\d)$/i.test(normalized);
    const date = new Date(hasTimezone ? normalized : `${normalized}Z`);
    return Number.isNaN(date.getTime()) ? null : date;
  },

  formatDateTime(dateStr) {
    const date = this.parseDate(dateStr);
    if (!date) return '\u672a\u77e5';

    return date.toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).replace(/\//g, '-');
  },

  timeAgo(dateStr) {
    const date = this.parseDate(dateStr);
    if (!date) return '\u4ece\u672a';

    const now = new Date();
    const diff = Math.floor((now - date) / 1000);

    if (diff < 60) return '\u521a\u521a';
    if (diff < 3600) return `${Math.floor(diff / 60)} \u5206\u949f\u524d`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} \u5c0f\u65f6\u524d`;
    if (diff < 604800) return `${Math.floor(diff / 86400)} \u5929\u524d`;
    return this.formatDate(dateStr);
  },

  isRecent(dateStr, hours = 12) {
    const date = this.parseDate(dateStr);
    if (!date) return false;
    return (Date.now() - date.getTime()) <= hours * 60 * 60 * 1000;
  },

  formatDate(dateStr) {
    const date = this.parseDate(dateStr);
    if (!date) return '\u672a\u77e5';
    return date.toLocaleDateString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  },

  quotaBreakdown(account) {
    const quota = this.accountQuotaNumbers(account);
    const { occupied, pending, totalUsers, reserved, memberSlots, saleableRemaining } = quota;

    const pills = [
      totalUsers === null
        ? this.quotaPill('\u6210\u5458\u603b\u6570 -', 'neutral', '\u9700\u8981\u5148\u540c\u6b65\u540d\u989d')
        : this.quotaPill(`\u6210\u5458\u603b\u6570 ${totalUsers}`, 'neutral', '\u5bf9\u9f50 OpenAI \u7ba1\u7406\u9875\u9876\u90e8\u201cBusiness \u00b7 N \u4f4d\u6210\u5458\u201d'),
      this.quotaPill(`\u5360\u4f4d\u6210\u5458 ${occupied}`, 'neutral', '\u6309 OpenAI /users \u63a5\u53e3\u8fd4\u56de\u7684 seat_type=default \u7edf\u8ba1'),
      pending === null
        ? this.quotaPill('\u5f85\u5904\u7406\u9080\u8bf7 -', 'neutral', '\u9700\u8981\u5148\u540c\u6b65\u540d\u989d')
        : this.quotaPill(`\u5f85\u5904\u7406\u9080\u8bf7 ${pending}`, pending > 0 ? 'accent' : 'neutral', '\u5bf9\u9f50 OpenAI \u7ba1\u7406\u9875\u201c\u5f85\u5904\u7406\u9080\u8bf7\u201d'),
    ];

    if (pending !== null && pending > 0) {
      const reserveTone = saleableRemaining < 0 ? 'danger' : (saleableRemaining === 0 ? 'warning' : 'accent');
      const reserveTitle = saleableRemaining < 0
        ? `\u6309\u603b\u9884\u5360\u8ba1\u7b97\uff0c\u5df2\u8d85\u989d ${Math.abs(saleableRemaining)}`
        : `\u6309\u603b\u9884\u5360\u8ba1\u7b97\uff0c\u53ef\u552e\u4f59\u91cf ${saleableRemaining}`;
      pills.push(this.quotaPill(`\u603b\u9884\u5360 ${reserved}`, reserveTone, reserveTitle));
    }

    if (saleableRemaining < 0) {
      pills.push(this.quotaPill(`\u8d85\u989d ${Math.abs(saleableRemaining)}`, 'danger', '\u5360\u4f4d\u6210\u5458 + \u5f85\u5904\u7406\u9080\u8bf7\u5df2\u7ecf\u8d85\u8fc7\u4e0a\u9650'));
    } else if (saleableRemaining === 0) {
      pills.push(this.quotaPill('\u53ef\u552e\u4f59\u91cf 0', 'warning', '\u6263\u6389\u5f85\u5904\u7406\u9080\u8bf7\u540e\uff0c\u4e0d\u5e94\u518d\u5356'));
    } else {
      pills.push(this.quotaPill(`\u53ef\u552e\u4f59\u91cf ${saleableRemaining}`, saleableRemaining <= 1 ? 'warning' : 'success'));
    }

    if (memberSlots < 0) {
      pills.push(this.quotaPill(`\u6210\u5458\u8d85\u989d ${Math.abs(memberSlots)}`, 'danger', '\u53ea\u770b\u5df2\u5165\u56e2\u6210\u5458\uff0c\u4e0d\u6263\u5f85\u5904\u7406\u9080\u8bf7'));
    } else {
      pills.push(this.quotaPill(`\u6210\u5458\u7a7a\u4f4d ${memberSlots}`, memberSlots <= 1 ? 'warning' : 'neutral', '\u53ea\u770b\u5df2\u5165\u56e2\u6210\u5458\uff0c\u4e0d\u6263\u5f85\u5904\u7406\u9080\u8bf7'));
    }

    return `<div class="quota-breakdown">${pills.join('')}</div>`;
  },

  quotaSyncMeta(account) {
    const syncTime = this.timeAgo(account.quota_last_synced_at);
    const message = account.quota_sync_message || '';
    const workspaceBits = [];

    if (account.quota_workspace_name) {
      workspaceBits.push(account.quota_workspace_name);
    }
    if (account.quota_plan_type) {
      workspaceBits.push(account.quota_plan_type);
    }

    return `
      <div class="sync-meta">
        <span class="text-muted">\u68c0\u67e5: ${this.timeAgo(account.last_checked)}</span>
        <div class="quota-sync-line">
          ${this.quotaSyncBadge(account.quota_sync_status)}
          <span class="text-muted">\u914d\u989d: ${syncTime}</span>
        </div>
        ${workspaceBits.length > 0 ? `<span class="text-muted quota-sync-extra">${this.escapeHtml(workspaceBits.join(' \u00b7 '))}</span>` : ''}
        ${message ? `<span class="quota-sync-message" title="${this.escapeHtml(message)}">${this.escapeHtml(message)}</span>` : ''}
      </div>
    `;
  },

  accountRow(account) {
    const quota = this.accountQuotaNumbers(account);
    const { occupied, reserved, total } = quota;
    const rowClasses = [];

    if (reserved > total || occupied > total) {
      rowClasses.push('over-quota-row');
    }
    if (account.quota_sync_status === 'error') {
      rowClasses.push('quota-sync-error-row');
    }

    return `
      <tr data-id="${account.id}" class="${rowClasses.join(' ')}">
        <td><input type="checkbox" class="account-checkbox" data-id="${account.id}"></td>
        <td>
          <div class="stack-col">
            <span class="cell-title">${this.escapeHtml(account.email)}</span>
            ${account.password ? '<span class="text-muted text-xs">已配置密码</span>' : ''}
            ${account.access_token ? '<span class="text-muted text-xs cell-note-success">已授权</span>' : '<span class="text-muted text-xs cell-note-warning">未授权</span>'}
          </div>
        </td>
        <td><span class="text-muted">${this.escapeHtml(account.label || '-')}</span></td>
        <td>
          <div class="stack-col-md stack-col-start">
            ${this.statusBadge(account.status)}
            ${this.overflowRebalanceBadges(account)}
            ${Number(account.invite_paused || 0) ? this.invitePauseBadge(account) : this.inviteHealthBadge(account)}
          </div>
        </td>
        <td>
          <div class="quota-cell">
            ${this.inviteProgress(reserved, total)}
            ${this.quotaBreakdown(account)}
          </div>
        </td>
        <td>${this.quotaSyncMeta(account)}</td>
        <td>
          <div class="action-btns">
            <button class="action-btn tone-blue" title="发送邀请" onclick="App.openInviteModal(${account.id})">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
            </button>
            <button class="action-btn tone-purple" title="同步名额" onclick="App.syncAccountQuota(${account.id})">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2v6h-6"/><path d="M3 22v-6h6"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L3 8"/><path d="M3.51 15a9 9 0 0 0 14.85 3.36L21 16"/></svg>
            </button>
            <button class="action-btn tone-yellow" title="成员管理" onclick="App.openMembersModal(${account.id})">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><path d="M20 8v6"/><path d="M23 11h-6"/></svg>
            </button>
            <button class="action-btn tone-orange" title="坏号检测" onclick="App.inspectInviteHealth(${account.id})">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><path d="M11 8v3"/><path d="M11 16h.01"/></svg>
            </button>
            ${Number(account.invite_paused || 0) ? `
            <button class="action-btn tone-green" title="恢复邀请" onclick="App.restoreInviteHealth(${account.id})">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 3-6.7"/><polyline points="3 3 3 9 9 9"/></svg>
            </button>
            ` : ''}
            <button class="action-btn tone-green" title="账号授权" onclick="App.oauthAccount(${account.id})">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            </button>
            <button class="action-btn" title="\u7f16\u8f91" onclick="App.editAccount(${account.id})">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="action-btn" title="\u7acb\u5373\u68c0\u67e5" onclick="App.checkSingle(${account.id})">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
            </button>
            <button class="action-btn danger" title="\u5220\u9664" onclick="App.deleteAccount(${account.id})">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </div>
        </td>
      </tr>
    `;
  },

  overflowRebalanceRecord(record) {
    const tone = String(record?.tone || 'neutral').trim();
    const memberEmail = String(record?.member_email || '').trim();
    const title = memberEmail || String(record?.summary || '迁移记录').trim() || '迁移记录';
    const sourceLabel = record?.source_account_email
      ? `${record.source_account_email} / ${record.source_workspace || '默认工作区'}`
      : '';
    const targetLabel = record?.target_account_email
      ? `${record.target_account_email} / ${record.target_workspace || '默认工作区'}`
      : '';

    let detail = String(record?.detail || '').trim();
    if (!detail && !memberEmail) {
      detail = String(record?.summary || record?.message || '').trim();
    }

    return `
      <article class="overflow-record-card ${tone}">
        <div class="overflow-record-top">
          ${this.quotaPill(record?.status_label || '迁移记录', tone, record?.message || '')}
          <span class="text-muted text-xs">${this.escapeHtml(this.timeAgo(record?.checked_at))}</span>
        </div>
        <div class="overflow-record-title">${this.escapeHtml(title)}</div>
        ${sourceLabel || targetLabel ? `
          <div class="overflow-record-route">
            ${sourceLabel ? `<span>源：${this.escapeHtml(sourceLabel)}</span>` : ''}
            ${targetLabel ? `<span>目标：${this.escapeHtml(targetLabel)}</span>` : ''}
          </div>
        ` : ''}
        ${detail ? `<div class="overflow-record-detail">${this.escapeHtml(detail)}</div>` : ''}
        <div class="overflow-record-time">${this.escapeHtml(this.formatDateTime(record?.checked_at))}</div>
      </article>
    `;
  },

  logEntry(log) {
    return `
      <div class="log-entry">
        <div class="log-dot ${log.status}"></div>
        <div class="log-info">
          <div class="log-email">${this.escapeHtml(log.email || '')} ${log.label ? `<span class="text-muted">(${this.escapeHtml(log.label)})</span>` : ''}</div>
          <div class="log-message">${this.escapeHtml(log.message || '')}</div>
        </div>
        <div class="log-time">${this.timeAgo(log.checked_at)}</div>
      </div>
    `;
  },

  inviteRow(invite) {
    const requestedAccountEmail = invite.requested_account_email || '';
    const fallbackFromAccountEmail = invite.fallback_from_account_email || '';
    const showRequested = requestedAccountEmail && requestedAccountEmail !== invite.account_email;
    const remoteInviteId = invite.remote_invite_id || invite.remoteInviteId || '';
    const workspaceLabel = this.inviteWorkspaceLabel(invite);

    return `
      <tr data-id="${invite.id}">
        <td><span class="cell-title">${this.escapeHtml(invite.target_email)}</span></td>
        <td>
          <div class="stack-col">
            <span class="text-sm text-strong">${this.escapeHtml(invite.account_email)}</span>
            <span class="text-muted text-xs">${this.escapeHtml(invite.account_label || '')}</span>
            ${showRequested ? `<span class="text-muted text-xs">请求账号: ${this.escapeHtml(requestedAccountEmail)}</span>` : ''}
            ${fallbackFromAccountEmail ? `<span class="text-muted text-xs cell-note-warning">回退自: ${this.escapeHtml(fallbackFromAccountEmail)}</span>` : ''}
          </div>
        </td>
        <td>
          <div class="stack-col">
            ${this.statusBadge(invite.status)}
            <div class="surface-chip-row">
              <span class="surface-chip text-muted text-xs" title="${this.escapeHtml(workspaceLabel)}">工作区: ${this.escapeHtml(workspaceLabel)}</span>
              <span class="surface-chip text-muted text-xs">模式: ${this.escapeHtml(this.inviteModeLabel(invite))}</span>
              ${remoteInviteId ? `<span class="surface-chip text-muted text-xs" title="${this.escapeHtml(remoteInviteId)}">远端ID: ${this.escapeHtml(this.shortId(remoteInviteId))}</span>` : ''}
            </div>
            <span class="text-muted text-xs truncate-line" title="${this.escapeHtml(invite.message)}">${this.escapeHtml(invite.message)}</span>
          </div>
        </td>
        <td>
          <div class="stack-col">
            <span class="text-muted">${this.timeAgo(invite.created_at)}</span>
            <span class="text-muted text-xs">${this.escapeHtml(this.formatDateTime(invite.created_at))}</span>
          </div>
        </td>
        <td>
          <div class="action-btns">
            <button class="action-btn tone-blue" title="补发邀请" onclick="App.resendInvite(${invite.account_id}, ${this.jsString(invite.target_email)}, ${this.jsString(invite.workspace_id || '')}, ${this.jsString(invite.workspace_name || '')})">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><polyline points="23 20 23 14 17 14"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/></svg>
            </button>
            <button class="action-btn danger" title="删除记录" onclick="App.deleteInvite(${invite.id})">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </div>
        </td>
      </tr>
    `;
  },

  workspaceRow(workspace) {
    const occupied = Number(workspace.occupied_seats || 0);
    const pending = Number(workspace.pending_invites || 0);
    const total = Number(workspace.invite_total_hint || 0);
    const projectedRaw = Number(workspace.projected_remaining_seats);
    const memberSlotsRaw = Number(workspace.remaining_seats);
    const projectedRemaining = Number.isFinite(projectedRaw) ? projectedRaw : total - occupied - pending;
    const memberSlots = Number.isFinite(memberSlotsRaw) ? memberSlotsRaw : total - occupied;
    const capacity = `${occupied + pending}/${total}`;
    const saleableText = projectedRemaining < 0
      ? `\u8d85\u989d ${Math.abs(projectedRemaining)}`
      : `\u53ef\u552e\u4f59\u91cf ${projectedRemaining}`;
    const saleableTone = projectedRemaining < 0 ? 'danger' : (projectedRemaining === 0 ? 'warning' : 'success');
    const memberSlotsText = memberSlots < 0
      ? `\u6210\u5458\u8d85\u989d ${Math.abs(memberSlots)}`
      : `\u6210\u5458\u7a7a\u4f4d ${memberSlots}`;

    return `
      <tr data-id="${workspace.id}">
        <td>
          <div class="stack-col-sm">
            <span class="cell-title">${this.escapeHtml(workspace.workspace_name || workspace.workspace_id)}</span>
            <span class="text-muted text-xs">${this.escapeHtml(workspace.workspace_id)}</span>
          </div>
        </td>
        <td>
          <div class="stack-col-sm">
            <span>${this.escapeHtml(workspace.account_email || '')}</span>
            <span class="text-muted text-xs">${this.escapeHtml(workspace.plan_type || '')}</span>
          </div>
        </td>
        <td>
          <div class="surface-chip-row">
            ${this.workspaceSyncBadge(workspace.sync_status)}
            ${this.healthBadge(workspace.health_score, workspace.health_label)}
          </div>
        </td>
        <td>
          <div class="stack-col-md">
            ${this.quotaPill(`成员 ${workspace.member_count || 0}`, 'neutral')}
            ${this.quotaPill(`占位 ${workspace.occupied_seats || 0}`, 'neutral')}
            ${this.quotaPill(`待接受 ${workspace.pending_invites || 0}`, Number(workspace.pending_invites || 0) > 0 ? 'accent' : 'neutral')}
            ${this.quotaPill(`${saleableText}`, saleableTone)}
            ${this.quotaPill(`${memberSlotsText}`, memberSlots <= 1 ? 'warning' : 'neutral')}
          </div>
        </td>
        <td>
          <div class="stack-col-sm">
            <span>${this.escapeHtml(capacity)}</span>
            <span class="text-muted text-xs">最近同步 ${this.timeAgo(workspace.last_synced_at)}</span>
            ${workspace.sync_message ? `<span class="quota-sync-message" title="${this.escapeHtml(workspace.sync_message)}">${this.escapeHtml(workspace.sync_message)}</span>` : ''}
          </div>
        </td>
        <td>
          <div class="action-btns">
            <button class="action-btn tone-yellow" title="查看这个工作区的成员" onclick="App.openWorkspaceMembers(${workspace.account_id}, ${this.jsString(workspace.workspace_id)}, ${this.jsString(workspace.workspace_name || workspace.workspace_id)}, ${this.jsString(workspace.plan_type || '')}, ${this.jsString(workspace.account_email || '')})">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            </button>
            <button class="action-btn tone-blue" title="发送邀请到这个工作区" onclick="App.openWorkspaceInvite(${workspace.account_id}, ${this.jsString(workspace.workspace_id)}, ${this.jsString(workspace.workspace_name || workspace.workspace_id)})">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
            </button>
            <button class="action-btn tone-purple" title="同步工作区" onclick="App.syncWorkspace(${workspace.id})">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2v6h-6"/><path d="M3 22v-6h6"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L3 8"/><path d="M3.51 15a9 9 0 0 0 14.85 3.36L21 16"/></svg>
            </button>
            <button class="action-btn tone-green" title="导出成员" onclick="App.exportWorkspace(${workspace.id})">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            </button>
          </div>
        </td>
      </tr>
    `;
  },

  workspaceRowWithLock(workspace) {
    const occupied = Number(workspace.occupied_seats || 0);
    const pending = Number(workspace.pending_invites || 0);
    const total = Number(workspace.invite_total_hint || 0);
    const manualInviteLocked = Number(workspace.invite_locked || 0) === 1;
    const autoInviteLocked = Number(workspace.auto_invite_locked || 0) === 1;
    const inviteLocked = manualInviteLocked || autoInviteLocked;
    const projectedRaw = Number(workspace.projected_remaining_seats);
    const memberSlotsRaw = Number(workspace.remaining_seats);
    const projectedRemaining = Number.isFinite(projectedRaw) ? projectedRaw : total - occupied - pending;
    const memberSlots = Number.isFinite(memberSlotsRaw) ? memberSlotsRaw : total - occupied;
    const capacity = `${occupied + pending}/${total}`;
    const saleableText = projectedRemaining < 0
      ? `超额 ${Math.abs(projectedRemaining)}`
      : `可售余量 ${projectedRemaining}`;
    const saleableTone = projectedRemaining < 0 ? 'danger' : (projectedRemaining === 0 ? 'warning' : 'success');
    const memberSlotsText = memberSlots < 0
      ? `成员超额 ${Math.abs(memberSlots)}`
      : `成员空位 ${memberSlots}`;
    const lockTitle = inviteLocked ? '已锁定，当前空间不会参与邀请分配' : '点击锁定后，这个空间不会再参与邀请分配';
    const inviteButtonTitle = inviteLocked ? '该工作区已锁定，不能再选中邀请' : '发送邀请到这个工作区';

    return `
      <tr data-id="${workspace.id}">
        <td>
          <button
            class="action-btn ${inviteLocked ? 'tone-red' : 'tone-green'} workspace-lock-btn"
            title="${this.escapeHtml(lockTitle)}"
            aria-label="${this.escapeHtml(inviteLocked ? '解锁空间' : '锁定空间')}"
            onclick="App.toggleWorkspaceInviteLock(${workspace.id}, ${inviteLocked ? 'false' : 'true'})"
          >
            ${inviteLocked
              ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 1 1 8 0v3"/></svg>'
              : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.75-1"/></svg>'}
          </button>
        </td>
        <td>
          <div class="stack-col-sm">
            <span class="cell-title">${this.escapeHtml(workspace.workspace_name || workspace.workspace_id)}</span>
            <span class="text-muted text-xs">${this.escapeHtml(workspace.workspace_id)}</span>
            <div class="surface-chip-row">
              ${inviteLocked
                ? this.quotaPill('已锁定', 'warning', '锁定后自动邀请和手动选择都会跳过这个空间')
                : this.quotaPill('未锁定', 'neutral', '当前空间会参与邀请分配')}
            </div>
          </div>
        </td>
        <td>
          <div class="stack-col-sm">
            <span>${this.escapeHtml(workspace.account_email || '')}</span>
            <span class="text-muted text-xs">${this.escapeHtml(workspace.plan_type || '')}</span>
          </div>
        </td>
        <td>
          <div class="surface-chip-row">
            ${this.workspaceSyncBadge(workspace.sync_status)}
            ${this.healthBadge(workspace.health_score, workspace.health_label)}
          </div>
        </td>
        <td>
          <div class="stack-col-md">
            ${this.quotaPill(`成员 ${workspace.member_count || 0}`, 'neutral')}
            ${this.quotaPill(`占位 ${workspace.occupied_seats || 0}`, 'neutral')}
            ${this.quotaPill(`待邀请 ${workspace.pending_invites || 0}`, Number(workspace.pending_invites || 0) > 0 ? 'accent' : 'neutral')}
            ${this.quotaPill(saleableText, saleableTone)}
            ${this.quotaPill(memberSlotsText, memberSlots <= 1 ? 'warning' : 'neutral')}
          </div>
        </td>
        <td>
          <div class="stack-col-sm">
            <span>${this.escapeHtml(capacity)}</span>
            <span class="text-muted text-xs">最近同步 ${this.timeAgo(workspace.last_synced_at)}</span>
            ${workspace.sync_message ? `<span class="quota-sync-message" title="${this.escapeHtml(workspace.sync_message)}">${this.escapeHtml(workspace.sync_message)}</span>` : ''}
          </div>
        </td>
        <td>
          <div class="action-btns">
            <button class="action-btn tone-yellow" title="查看这个工作区的成员" onclick="App.openWorkspaceMembers(${workspace.account_id}, ${this.jsString(workspace.workspace_id)}, ${this.jsString(workspace.workspace_name || workspace.workspace_id)}, ${this.jsString(workspace.plan_type || '')}, ${this.jsString(workspace.account_email || '')})">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            </button>
            <button class="action-btn tone-blue ${inviteLocked ? 'disabled' : ''}" title="${this.escapeHtml(inviteButtonTitle)}" ${inviteLocked ? 'disabled' : `onclick="App.openWorkspaceInvite(${workspace.account_id}, ${this.jsString(workspace.workspace_id)}, ${this.jsString(workspace.workspace_name || workspace.workspace_id)})"`}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
            </button>
            <button class="action-btn tone-purple" title="同步工作区" onclick="App.syncWorkspace(${workspace.id})">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2v6h-6"/><path d="M3 22v-6h6"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L3 8"/><path d="M3.51 15a9 9 0 0 0 14.85 3.36L21 16"/></svg>
            </button>
            <button class="action-btn tone-green" title="导出成员" onclick="App.exportWorkspace(${workspace.id})">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            </button>
          </div>
        </td>
      </tr>
    `;
  },

  workspaceRowWithEffectiveLock(workspace) {
    const occupied = Number(workspace.occupied_seats || 0);
    const pending = Number(workspace.pending_invites || 0);
    const total = Number(workspace.invite_total_hint || 0);
    const manualInviteLocked = Number(workspace.invite_locked || 0) === 1;
    const autoInviteLocked = Number(workspace.auto_invite_locked || 0) === 1;
    const inviteLocked = manualInviteLocked || autoInviteLocked;
    const autoLockOnly = autoInviteLocked && !manualInviteLocked;
    const projectedRaw = Number(workspace.projected_remaining_seats);
    const memberSlotsRaw = Number(workspace.remaining_seats);
    const projectedRemaining = Number.isFinite(projectedRaw) ? projectedRaw : total - occupied - pending;
    const memberSlots = Number.isFinite(memberSlotsRaw) ? memberSlotsRaw : total - occupied;
    const capacity = `${occupied + pending}/${total}`;
    const saleableText = projectedRemaining < 0
      ? `超额 ${Math.abs(projectedRemaining)}`
      : `可售余量 ${projectedRemaining}`;
    const saleableTone = projectedRemaining < 0 ? 'danger' : (projectedRemaining === 0 ? 'warning' : 'success');
    const memberSlotsText = memberSlots < 0
      ? `成员超额 ${Math.abs(memberSlots)}`
      : `成员空位 ${memberSlots}`;
    const statusLabel = manualInviteLocked && autoInviteLocked
      ? '手动锁定 / 满员'
      : manualInviteLocked
        ? '手动锁定'
        : autoInviteLocked
          ? '满员锁定'
          : '未锁定';
    const statusTitle = manualInviteLocked && autoInviteLocked
      ? '这个空间同时处于手动锁定和满员自动锁定状态'
      : manualInviteLocked
        ? '你已手动锁定这个空间，邀请分配会跳过它'
        : autoInviteLocked
          ? '这个空间当前满员，系统已自动锁定，恢复余量后会自动解锁'
          : '当前空间会参与邀请分配';
    const lockTitle = autoLockOnly
      ? '该空间当前因满员自动锁定，恢复余量后会自动解锁'
      : (inviteLocked
        ? '已锁定，当前空间不会参与邀请分配'
        : '点击锁定后，这个空间不会再参与邀请分配');
    const inviteButtonTitle = inviteLocked ? '该工作区已锁定，不能再选中邀请' : '发送邀请到这个工作区';

    return `
      <tr data-id="${workspace.id}">
        <td>
          <button
            class="action-btn ${(manualInviteLocked || autoInviteLocked) ? 'tone-red' : 'tone-green'} workspace-lock-btn ${autoLockOnly ? 'disabled' : ''}"
            title="${this.escapeHtml(lockTitle)}"
            aria-label="${this.escapeHtml(inviteLocked ? '解锁空间' : '锁定空间')}"
            ${autoLockOnly ? 'disabled' : `onclick="App.toggleWorkspaceInviteLock(${workspace.id}, ${inviteLocked ? 'false' : 'true'})"`}
          >
            ${inviteLocked
              ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 1 1 8 0v3"/></svg>'
              : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.75-1"/></svg>'}
          </button>
        </td>
        <td>
          <div class="stack-col-sm">
            <span class="cell-title">${this.escapeHtml(workspace.workspace_name || workspace.workspace_id)}</span>
            <span class="text-muted text-xs">${this.escapeHtml(workspace.workspace_id)}</span>
            <div class="surface-chip-row">
              ${this.quotaPill(statusLabel, inviteLocked ? 'warning' : 'neutral', statusTitle)}
            </div>
          </div>
        </td>
        <td>
          <div class="stack-col-sm">
            <span>${this.escapeHtml(workspace.account_email || '')}</span>
            <span class="text-muted text-xs">${this.escapeHtml(workspace.plan_type || '')}</span>
          </div>
        </td>
        <td>
          <div class="surface-chip-row">
            ${this.workspaceSyncBadge(workspace.sync_status)}
            ${this.healthBadge(workspace.health_score, workspace.health_label)}
          </div>
        </td>
        <td>
          <div class="stack-col-md">
            ${this.quotaPill(`成员 ${workspace.member_count || 0}`, 'neutral')}
            ${this.quotaPill(`占位 ${workspace.occupied_seats || 0}`, 'neutral')}
            ${this.quotaPill(`待邀请 ${workspace.pending_invites || 0}`, Number(workspace.pending_invites || 0) > 0 ? 'accent' : 'neutral')}
            ${this.quotaPill(saleableText, saleableTone)}
            ${this.quotaPill(memberSlotsText, memberSlots <= 1 ? 'warning' : 'neutral')}
          </div>
        </td>
        <td>
          <div class="stack-col-sm">
            <span>${this.escapeHtml(capacity)}</span>
            <span class="text-muted text-xs">最近同步 ${this.timeAgo(workspace.last_synced_at)}</span>
            ${workspace.sync_message ? `<span class="quota-sync-message" title="${this.escapeHtml(workspace.sync_message)}">${this.escapeHtml(workspace.sync_message)}</span>` : ''}
          </div>
        </td>
        <td>
          <div class="action-btns">
            <button class="action-btn tone-yellow" title="查看这个工作区的成员" onclick="App.openWorkspaceMembers(${workspace.account_id}, ${this.jsString(workspace.workspace_id)}, ${this.jsString(workspace.workspace_name || workspace.workspace_id)}, ${this.jsString(workspace.plan_type || '')}, ${this.jsString(workspace.account_email || '')})">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            </button>
            <button class="action-btn tone-blue ${inviteLocked ? 'disabled' : ''}" title="${this.escapeHtml(inviteButtonTitle)}" ${inviteLocked ? 'disabled' : `onclick="App.openWorkspaceInvite(${workspace.account_id}, ${this.jsString(workspace.workspace_id)}, ${this.jsString(workspace.workspace_name || workspace.workspace_id)})"`}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
            </button>
            <button class="action-btn tone-purple" title="同步工作区" onclick="App.syncWorkspace(${workspace.id})">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2v6h-6"/><path d="M3 22v-6h6"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L3 8"/><path d="M3.51 15a9 9 0 0 0 14.85 3.36L21 16"/></svg>
            </button>
            <button class="action-btn tone-green" title="导出成员" onclick="App.exportWorkspace(${workspace.id})">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            </button>
          </div>
        </td>
      </tr>
    `;
  },

  dashboardAlertItem(alert) {
    const tone = alert.severity === 'high' ? 'danger' : (alert.severity === 'medium' ? 'warning' : 'accent');
    return `
      <div class="dashboard-alert-item ${tone}">
        <div class="dashboard-alert-head">
          <strong>${this.escapeHtml(alert.title || '')}</strong>
          ${this.quotaPill(this.alertTypeLabel(alert.type), tone)}
        </div>
        <div class="dashboard-alert-detail">${this.escapeHtml(alert.detail || '')}</div>
        <div class="dashboard-alert-meta">${this.escapeHtml([alert.account_email, alert.workspace_name].filter(Boolean).join(' · '))}</div>
      </div>
    `;
  },

  failureCategoryItem(item) {
    return `
      <div class="dashboard-failure-item">
        <span>${this.escapeHtml(item.label || item.category)}</span>
        <strong>${this.escapeHtml(item.count)}</strong>
      </div>
    `;
  },

  workspaceSummaryCard(label, value, tone = 'neutral', meta = '') {
    return `
      <div class="quota-overview-card ${tone}">
        <span class="quota-overview-label">${this.escapeHtml(label)}</span>
        <strong class="quota-overview-value">${this.escapeHtml(value)}</strong>
        ${meta ? `<span class="quota-overview-meta">${this.escapeHtml(meta)}</span>` : ''}
      </div>
    `;
  },

  checkoutTypeLabel(type) {
    const labels = {
      checkout: '结账链接',
      redeem_code: '卡密',
      checkout_and_code: '链接 + 卡密',
      unknown: '未识别',
    };
    return labels[type] || type || '未知';
  },

  checkoutStatusTone(status) {
    if (status === 'parsed' || status === 'code_only') return 'success';
    if (status === 'partial') return 'warning';
    return 'danger';
  },

  checkoutStatusLabel(status) {
    const labels = {
      parsed: '已解析',
      code_only: '仅卡密',
      partial: '部分识别',
      invalid: '未识别',
    };
    return labels[status] || status || '未知';
  },

  autosubStatusBadge(status, error) {
    const labels = {
      pending: '未开始',
      redeeming: '正在兑换',
      generating_address: '生成地址',
      binding: '协议绑卡',
      awaiting_human_verification: '待真人验证',
      awaiting_login: '待登录账号',
      filling_fields: '自动填表',
      awaiting_user_execution: '待手动提交',
      success: '订阅成功',
      failed: '失败',
    };
    const tones = {
      pending: 'neutral',
      redeeming: 'accent',
      generating_address: 'accent',
      binding: 'accent',
      awaiting_human_verification: 'warning',
      awaiting_login: 'warning',
      filling_fields: 'accent',
      awaiting_user_execution: 'warning',
      success: 'success',
      failed: 'danger',
    };
    const label = labels[status] || status || '未开始';
    const tone = tones[status] || 'neutral';
    return `<span class="quota-pill ${tone}" ${error ? `title="${this.escapeHtml(error)}"` : ''}>${this.escapeHtml(label)}</span>`;
  },

  checkoutHistoryRow(item) {
    const canOpen = !!item.normalized_link;
    const canCopyLink = !!item.normalized_link;
    const canCopySession = !!item.session_id;
    const resultBits = [];

    if (item.session_id) {
      resultBits.push(`<div class="checkout-result-line"><span class="checkout-result-label">Session</span><code>${this.escapeHtml(this.shortId(item.session_id))}</code></div>`);
    }
    if (item.normalized_link) {
      resultBits.push(`<div class="checkout-result-line"><span class="checkout-result-label">链接</span><span class="checkout-result-link" title="${this.escapeHtml(item.normalized_link)}">${this.escapeHtml(item.normalized_link)}</span></div>`);
    }
    if (item.redeem_code_masked) {
      resultBits.push(`<div class="checkout-result-line"><span class="checkout-result-label">卡密</span><code>${this.escapeHtml(item.redeem_code_masked)}</code></div>`);
    }
    if (!resultBits.length) {
      resultBits.push('<span class="text-muted">没有识别出有效结果</span>');
    }

    return `
      <tr>
        <td>
          <div class="stack-col">
            <span>${this.escapeHtml(this.timeAgo(item.created_at))}</span>
            <span class="text-muted text-xs">${this.escapeHtml(this.formatDate(item.created_at))}</span>
          </div>
        </td>
        <td>
          <div class="stack-col-md">
            ${this.quotaPill(this.checkoutTypeLabel(item.tool_type), 'neutral')}
            ${this.quotaPill(this.checkoutStatusLabel(item.status), this.checkoutStatusTone(item.status))}
          </div>
        </td>
        <td><div class="checkout-result-stack">${resultBits.join('')}</div></td>
        <td>
          <div class="stack-col-md">
            ${this.autosubStatusBadge(item.autosub_status, item.autosub_error)}
            ${item.card_last4 ? `<span class="text-muted text-xs">卡号末尾: ${this.escapeHtml(item.card_last4)}</span>` : ''}
          </div>
        </td>
        <td>
          <div class="stack-col">
            <span>${this.escapeHtml(item.source_domain || '手动输入')}</span>
            ${item.last_used_at ? `<span class="text-muted text-xs">最近操作: ${this.escapeHtml(item.last_action || '查看')} · ${this.escapeHtml(this.timeAgo(item.last_used_at))}</span>` : ''}
          </div>
        </td>
        <td><span class="text-muted">${this.escapeHtml(item.note || '-')}</span></td>
        <td>
          <div class="member-table-actions">
            <button class="member-inline-btn ${canCopyLink ? '' : 'disabled'}" ${canCopyLink ? `onclick="App.copyCheckoutTool(${item.id}, 'link', ${this.jsString(item.normalized_link)})"` : 'disabled'}>复制链接</button>
            <button class="member-inline-btn ${canCopySession ? '' : 'disabled'}" ${canCopySession ? `onclick="App.copyCheckoutTool(${item.id}, 'session', ${this.jsString(item.session_id)})"` : 'disabled'}>复制ID</button>
            <button class="member-inline-btn ${canOpen ? '' : 'disabled'}" ${canOpen ? `onclick="App.openCheckoutTool(${item.id}, ${this.jsString(item.normalized_link)})"` : 'disabled'}>打开</button>
            <button class="member-inline-btn accent" onclick="App.executeAutoSub(${item.id})">协议订阅</button>
            <button class="member-inline-btn danger" onclick="App.deleteCheckoutTool(${item.id})">删除</button>
          </div>
        </td>
      </tr>
    `;
  },

  inviteHealthModal(data) {
    const summary = data?.summary || {};
    const accounts = Array.isArray(data?.accounts) ? data.accounts : [];
    const cards = [
      this.workspaceSummaryCard('已暂停', summary.paused || 0, (summary.paused || 0) > 0 ? 'danger' : 'success', '已被系统暂停邀请的账号'),
      this.workspaceSummaryCard('已检测', summary.total || 0, 'neutral', '已授权活跃账号'),
      this.workspaceSummaryCard('坏号', summary.degraded || 0, (summary.degraded || 0) > 0 ? 'warning' : 'success', '近期出现邀请假成功'),
      this.workspaceSummaryCard('待观察', summary.warning || 0, (summary.warning || 0) > 0 ? 'accent' : 'neutral', '补发或撤销异常'),
      this.workspaceSummaryCard('健康', summary.healthy || 0, 'success', '近期无邀请异常'),
      this.workspaceSummaryCard('有余量', summary.hasCapacity || 0, 'accent', '仍可继续邀请'),
    ].join('');

    const rows = accounts.length > 0 ? accounts.map(account => `
      <tr>
        <td>${this.escapeHtml(account.email || '')}</td>
        <td>${Number(account.invite_paused || 0) ? this.invitePauseBadge(account) : this.inviteHealthBadge(account)}</td>
        <td>${this.escapeHtml(`${account.projected_remaining || 0}`)}</td>
        <td>${this.escapeHtml(`${account.recent_materialize_failures || 0} / ${account.recent_retry_failures || 0} / ${account.recent_invite_successes || 0}`)}</td>
        <td>${this.escapeHtml(this.timeAgo(account.last_invite_success_at || ''))}</td>
        <td>${this.escapeHtml(account.diagnosis || '')}</td>
        <td>
          <button class="member-inline-btn accent" onclick="App.restoreInviteHealth(${account.id})">修复</button>
        </td>
      </tr>
    `).join('') : `
      <tr>
        <td colspan="7" class="text-muted empty-cell">当前没有检测到账号数据</td>
      </tr>
    `;

    return `
      <div class="quota-overview">${cards}</div>
      <div class="filter-actions" style="justify-content: flex-end; margin: 12px 0;">
        <button class="btn-secondary btn-tone-blue" onclick="App.openInviteHealthModal()">刷新检测</button>
        <button class="btn-secondary btn-tone-warm" onclick="App.restoreAllInviteHealth()">一键修复邀请坏号</button>
      </div>
      <div class="table-section">
        <table class="accounts-table">
          <thead>
            <tr>
              <th>账号</th>
              <th>检测结果</th>
              <th>预估剩余</th>
              <th>异常/成功</th>
              <th>最近成功</th>
              <th>诊断</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
      <p class="text-muted section-note">异常/成功 = 近 ${this.escapeHtml(data?.window_hours || 24)} 小时的“假成功未落地 / 补发撤销异常 / 成功邀请”计数。</p>
    `;
  },

  invalidCredentialsModal(data) {
    const accounts = Array.isArray(data?.accounts) ? data.accounts : [];
    const total = Number(data?.total || accounts.length || 0);
    const checked = accounts.filter(account => account.last_checked).length;
    const withMessage = accounts.filter(account => account.last_message).length;
    const cards = [
      this.workspaceSummaryCard('令牌无效', total, total > 0 ? 'warning' : 'success', '这些账号已从账号管理页隐藏'),
      this.workspaceSummaryCard('有检查时间', checked, checked > 0 ? 'accent' : 'neutral', '最近执行过检查的隐藏账号'),
      this.workspaceSummaryCard('有错误信息', withMessage, withMessage > 0 ? 'warning' : 'neutral', '可直接看最近一次错误原因'),
    ].join('');

    const rows = accounts.length > 0 ? accounts.map(account => `
      <tr>
        <td>
          <div class="stack-col-sm">
            <strong>${this.escapeHtml(account.email || '')}</strong>
            <span class="text-muted">${this.escapeHtml(account.label || '-')}</span>
          </div>
        </td>
        <td>${this.statusBadge(account.status || 'invalid_credentials')}</td>
        <td>${this.escapeHtml(this.timeAgo(account.last_checked || account.updated_at || ''))}</td>
        <td>
          <div class="text-muted text-break">
            ${this.escapeHtml(account.last_message || '暂无错误详情')}
          </div>
        </td>
        <td>
          <div class="member-table-actions">
            <button class="member-inline-btn accent" onclick="App.recheckInvalidAccount(${account.id})">重新检查</button>
          </div>
        </td>
      </tr>
    `).join('') : `
      <tr>
        <td colspan="5" class="text-muted empty-cell">当前没有令牌无效账号</td>
      </tr>
    `;

    return `
      <div class="quota-overview">${cards}</div>
      <div class="table-section">
        <table class="accounts-table">
          <thead>
            <tr>
              <th>账号</th>
              <th>状态</th>
              <th>最后检查</th>
              <th>最近错误</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
      <p class="text-muted section-note">这里只展示隐藏账号，不会重新放回账号管理列表。</p>
    `;
  },

  checkoutResultCard(item) {
    if (!item) {
      return '<div class="empty-state"><p>先解析一条链接或卡密</p></div>';
    }

    const rows = [];
    rows.push(`<div class="checkout-result-line"><span class="checkout-result-label">状态</span>${this.quotaPill(this.checkoutStatusLabel(item.status), this.checkoutStatusTone(item.status))}</div>`);
    rows.push(`<div class="checkout-result-line"><span class="checkout-result-label">类型</span>${this.quotaPill(this.checkoutTypeLabel(item.tool_type), 'neutral')}</div>`);

    if (item.session_id) {
      rows.push(`<div class="checkout-result-line"><span class="checkout-result-label">Session ID</span><code>${this.escapeHtml(item.session_id)}</code></div>`);
    }
    if (item.normalized_link) {
      rows.push(`<div class="checkout-result-line"><span class="checkout-result-label">标准链接</span><span class="checkout-result-link">${this.escapeHtml(item.normalized_link)}</span></div>`);
    }
    if (item.redeem_code_masked) {
      rows.push(`<div class="checkout-result-line"><span class="checkout-result-label">卡密</span><code>${this.escapeHtml(item.redeem_code_masked)}</code></div>`);
    }
    if (item.note) {
      rows.push(`<div class="checkout-result-line"><span class="checkout-result-label">备注</span><span>${this.escapeHtml(item.note)}</span></div>`);
    }

    return `
      <div class="checkout-result-card">
        ${rows.join('')}
        <div class="member-table-actions section-spacer-top">
          ${item.normalized_link ? `<button class="member-inline-btn" onclick="App.copyCheckoutTool(${item.id}, 'link', ${this.jsString(item.normalized_link)})">复制链接</button>` : ''}
          ${item.session_id ? `<button class="member-inline-btn" onclick="App.copyCheckoutTool(${item.id}, 'session', ${this.jsString(item.session_id)})">复制 Session</button>` : ''}
          ${item.normalized_link ? `<button class="member-inline-btn" onclick="App.openCheckoutTool(${item.id}, ${this.jsString(item.normalized_link)})">打开链接</button>` : ''}
          <button class="member-inline-btn accent" onclick="App.executeAutoSub(${item.id})">尝试协议订阅</button>
        </div>
      </div>
    `;
  },

  auditPresenceItem(item) {
    const tone = item.kind === 'pending' ? 'warning' : 'accent';
    const statusLabel = item.kind === 'pending' ? '待邀请' : '成员';
    return `
      <div class="dashboard-alert-item ${tone}">
        <div class="dashboard-alert-head">
          <strong>${this.escapeHtml(item.title || '')}</strong>
          ${this.quotaPill(statusLabel, tone)}
        </div>
        <div class="dashboard-alert-detail">${this.escapeHtml(item.detail || '')}</div>
      </div>
    `;
  },

  auditPresenceCard(item) {
    const tone = item.kind === 'pending' ? 'warning' : 'accent';
    const statusLabel = item.kind === 'pending' ? '\u5f85\u9080\u8bf7' : '\u6210\u5458';
    const canLocate = Boolean(item.workspace_id);
    const canKick = item.kind === 'member' && !item.is_owner && item.account_id && item.user_id;
    const actions = [
      canLocate
        ? `<button class="member-inline-btn" onclick="App.jumpToWorkspace(${this.jsString(item.workspace_id)}, ${this.jsString(item.workspace_name || item.workspace_id)})">\u5b9a\u4f4d</button>`
        : '',
      canKick
        ? `<button class="member-inline-btn danger" onclick="App.removeAuditMember(${item.account_id}, ${this.jsString(item.user_id)}, ${this.jsString(item.workspace_id || '')}, ${this.jsString(item.workspace_name || item.workspace_id || '')}, ${this.jsString(item.plan_type || '')}, ${this.jsString(item.email || '')}, ${Number(item.workspace_row_id || 0)})">\u8e22\u51fa\u6210\u5458</button>`
        : '',
    ].filter(Boolean).join('');

    return `
      <div class="dashboard-alert-item ${tone}">
        <div class="dashboard-alert-head">
          <strong>${this.escapeHtml(item.title || item.workspace_name || item.workspace_id || '')}</strong>
          ${this.quotaPill(statusLabel, tone)}
        </div>
        <div class="dashboard-alert-detail">${this.escapeHtml(item.detail || '')}</div>
        ${item.kind === 'member' && item.is_owner ? `<div class="dashboard-alert-meta">所有者不可直接踢出</div>` : ''}
        ${actions ? `<div class="member-table-actions section-note-compact">${actions}</div>` : ''}
      </div>
    `;
  },

  batchAuditModal(prefill = '') {
    return `
      <div>
        <p class="text-soft text-sm section-spacer-tight">
          每行一个邮箱。批量审计后，可以勾选想踢掉的成员，再一次性处理。
        </p>
        <textarea id="batch-audit-emails" class="import-textarea" placeholder="a@example.com&#10;b@example.com&#10;c@example.com">${this.escapeHtml(prefill)}</textarea>
        <div class="member-table-actions section-spacer-tight">
          <button type="button" class="btn btn-secondary" onclick="App.closeModal()">取消</button>
          <button type="button" class="btn btn-primary" id="btn-run-batch-audit-modal">开始批量审计</button>
          <button type="button" class="btn btn-secondary" id="btn-batch-audit-select-all" disabled>全选可踢</button>
          <button type="button" class="btn btn-danger" id="btn-batch-audit-remove-selected" disabled>踢出已选</button>
        </div>
        <div id="batch-audit-results" class="section-spacer-top">
          <div class="empty-state"><p>先输入邮箱再开始批量审计</p></div>
        </div>
      </div>
    `;
  },

  batchAuditResults(data, selectedKeys, progress = null) {
    if (!data) {
      return '<div class="empty-state"><p>先输入邮箱再开始批量审计</p></div>';
    }

    const summary = data.summary || {};
    const emailSummaries = Array.isArray(data.email_summaries) ? data.email_summaries : [];
    const memberships = Array.isArray(data.memberships) ? data.memberships : [];
    const pendingInvites = Array.isArray(data.pending_invites) ? data.pending_invites : [];
    const removableRows = memberships.filter(item => !item.is_owner && item.account_id && item.user_id);
    const selectedCount = removableRows.filter(item => selectedKeys?.has(item.selection_key)).length;
    const allSelected = removableRows.length > 0 && selectedCount === removableRows.length;
    const progressPercent = progress?.total ? Math.max(0, Math.min(100, Math.round(((progress.completed || 0) / progress.total) * 100))) : 0;
    const progressHtml = progress ? `
      <div class="dashboard-alert-item ${progress.active ? 'accent' : (progress.failed > 0 ? 'warning' : 'accent')} section-spacer-top">
        <div class="dashboard-alert-head">
          <strong>${this.escapeHtml(progress.active ? '批量踢人进行中' : '批量踢人结果')}</strong>
          ${this.quotaPill(`${progress.completed || 0}/${progress.total || 0}`, progress.active ? 'accent' : (progress.failed > 0 ? 'warning' : 'success'))}
        </div>
        <div class="dashboard-alert-detail">${this.escapeHtml(progress.current || '等待开始')}</div>
        <div class="progress-shell">
          <div class="progress-fill" style="width:${progressPercent}%;"></div>
        </div>
        <div class="dashboard-alert-meta section-note-compact">
          删除成功 ${this.escapeHtml(progress.success || 0)} · 删除失败 ${this.escapeHtml(progress.failed || 0)}
          ${progress.sync_total ? ` · 工作区同步 ${this.escapeHtml(progress.sync_completed || 0)}/${this.escapeHtml(progress.sync_total || 0)}` : ''}
        </div>
      </div>
    ` : '';

    const cards = [
      this.workspaceSummaryCard('邮箱数', summary.emails || 0, 'neutral', '本次批量审计输入的邮箱'),
      this.workspaceSummaryCard('成员命中', summary.memberships || 0, (summary.memberships || 0) > 0 ? 'accent' : 'neutral', '已在工作区里的成员'),
      this.workspaceSummaryCard('可踢成员', summary.removable_memberships || 0, (summary.removable_memberships || 0) > 0 ? 'warning' : 'neutral', 'owner 已自动排除'),
      this.workspaceSummaryCard('待邀请', summary.pending || 0, (summary.pending || 0) > 0 ? 'accent' : 'neutral', '远端待接受邀请'),
    ].join('');

    const emailSummaryHtml = emailSummaries.length > 0
      ? `
        <div class="dashboard-alert-list dashboard-alert-list-spaced">
          ${emailSummaries.map(item => `
            <div class="dashboard-alert-item accent">
              <div class="dashboard-alert-head">
                <strong>${this.escapeHtml(item.email)}</strong>
                ${this.quotaPill(`可踢 ${item.removable_memberships || 0}`, (item.removable_memberships || 0) > 0 ? 'warning' : 'neutral')}
              </div>
              <div class="dashboard-alert-detail">成员 ${item.memberships || 0} · 待邀请 ${item.pending || 0} · 历史 ${item.history || 0}</div>
            </div>
          `).join('')}
        </div>
      `
      : '';

    const rows = memberships.length > 0 ? memberships.map(item => {
      const disabled = item.is_owner || !item.account_id || !item.user_id;
      const checked = !disabled && selectedKeys?.has(item.selection_key);
      return `
        <tr>
          <td>
            <input type="checkbox" ${checked ? 'checked' : ''} ${disabled || progress?.active ? 'disabled' : ''} onchange="App.toggleBatchAuditSelection(${this.jsString(item.selection_key)}, this.checked)">
          </td>
          <td>${this.escapeHtml(item.email || '')}</td>
          <td>${this.escapeHtml(item.workspace_name || item.workspace_id || '')}</td>
          <td>${this.escapeHtml(item.account_email || '')}</td>
          <td>${this.escapeHtml(this.memberRoleLabel(item.role))}</td>
          <td>${this.escapeHtml(this.seatTypeLabel(item.seat_type || 'none'))}</td>
          <td>${item.is_owner ? this.quotaPill('Owner', 'neutral') : this.quotaPill('可踢', 'warning')}</td>
        </tr>
      `;
    }).join('') : `
      <tr>
        <td colspan="7" class="text-muted empty-cell">没有命中的成员</td>
      </tr>
    `;

    const pendingHtml = pendingInvites.length > 0 ? `
      <div class="dashboard-alert-list dashboard-alert-list-spaced">
        ${pendingInvites.slice(0, 12).map(item => `
          <div class="dashboard-alert-item warning">
            <div class="dashboard-alert-head">
              <strong>${this.escapeHtml(item.email || '')}</strong>
              ${this.quotaPill('待邀请', 'warning')}
            </div>
            <div class="dashboard-alert-detail">${this.escapeHtml(`${item.workspace_name || item.workspace_id || ''} · ${item.account_email || ''}`)}</div>
          </div>
        `).join('')}
      </div>
    ` : '';

    return `
      <div class="quota-overview">${cards}</div>
      ${progressHtml}
      ${emailSummaryHtml}
      <div class="table-section">
        <div class="member-table-actions member-actions-between">
          <div class="text-muted">已选 ${selectedCount} / 可踢 ${removableRows.length}</div>
          <label class="text-soft text-sm inline-check-label">
            <input type="checkbox" ${allSelected ? 'checked' : ''} ${removableRows.length === 0 || progress?.active ? 'disabled' : ''} onchange="App.toggleBatchAuditSelectAll(this.checked)">
            <span>全选可踢</span>
          </label>
        </div>
        <table class="accounts-table">
          <thead>
            <tr>
              <th></th>
              <th>邮箱</th>
              <th>工作区</th>
              <th>账号</th>
              <th>角色</th>
              <th>席位</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
      ${pendingHtml}
    `;
  },

  recommendationRowWithLock(item) {
    const canInvite = item.recommendation_state === 'available' || item.recommendation_state === 'cooldown';
    const tone = item.recommendation_state === 'available'
      ? 'success'
      : (item.recommendation_state === 'full' || item.recommendation_state === 'locked' ? 'warning' : 'neutral');
    const inviteLabel = item.recommendation_state === 'locked'
      ? '已锁定'
      : (canInvite ? '发邀请' : '不可发');

    return `
      <tr>
        <td>${this.escapeHtml(item.workspace_name || item.workspace_id)}</td>
        <td>${this.escapeHtml(item.account_email || '')}</td>
        <td>${this.healthBadge(item.health_score, item.health_label)}</td>
        <td>${this.quotaPill(this.recommendationLabel(item.recommendation_state), tone)}</td>
        <td>${this.escapeHtml(`${item.projected_remaining_seats}`)}</td>
        <td>
          <div class="member-table-actions">
            <button class="member-inline-btn" onclick="App.jumpToWorkspace(${this.jsString(item.workspace_id)}, ${this.jsString(item.workspace_name || item.workspace_id)})">定位</button>
            <button class="member-inline-btn ${canInvite ? '' : 'disabled'}" ${canInvite ? `onclick="App.openWorkspaceInvite(${item.account_id}, ${this.jsString(item.workspace_id)}, ${this.jsString(item.workspace_name || item.workspace_id)})"` : 'disabled'}>${this.escapeHtml(inviteLabel)}</button>
          </div>
        </td>
      </tr>
    `;
  },

  accountWorkspaceInviteSummary(account) {
    const inviteable = String(account?.inviteable_workspace_names || '')
      .split('|')
      .map(item => String(item || '').trim())
      .filter(Boolean);
    const locked = String(account?.locked_workspace_names || '')
      .split('|')
      .map(item => String(item || '').trim())
      .filter(Boolean);
    const fullLocked = String(account?.full_locked_workspace_names || '')
      .split('|')
      .map(item => String(item || '').trim())
      .filter(Boolean);

    const lines = [];
    lines.push(`当前可邀请空间：${inviteable.length > 0 ? inviteable.join('、') : '无'}`);
    if (fullLocked.length > 0) {
      lines.push(`已满员锁定空间：${fullLocked.join('、')}`);
    } else if (locked.length > 0) {
      lines.push(`已锁定空间：${locked.join('、')}`);
    }

    return `
      <div class="stack-col-sm">
        ${lines.map(line => `<span class="text-muted text-xs">${this.escapeHtml(line)}</span>`).join('')}
      </div>
    `;
  },

  accountRow(account) {
    const quota = this.accountQuotaNumbers(account);
    const { occupied, reserved, total } = quota;
    const rowClasses = [];

    if (reserved > total || occupied > total) {
      rowClasses.push('over-quota-row');
    }
    if (account.quota_sync_status === 'error') {
      rowClasses.push('quota-sync-error-row');
    }

    return `
      <tr data-id="${account.id}" class="${rowClasses.join(' ')}">
        <td><input type="checkbox" class="account-checkbox" data-id="${account.id}"></td>
        <td>
          <div class="stack-col">
            <span class="cell-title">${this.escapeHtml(account.email)}</span>
            ${account.password ? '<span class="text-muted text-xs">已配置密码</span>' : ''}
            ${account.access_token ? '<span class="text-muted text-xs cell-note-success">已授权</span>' : '<span class="text-muted text-xs cell-note-warning">未授权</span>'}
          </div>
        </td>
        <td><span class="text-muted">${this.escapeHtml(account.label || '-')}</span></td>
        <td>
          <div class="stack-col-md stack-col-start">
            ${this.statusBadge(account.status)}
            ${this.overflowRebalanceBadges(account)}
            ${Number(account.invite_paused || 0) ? this.invitePauseBadge(account) : this.inviteHealthBadge(account)}
          </div>
        </td>
        <td>
          <div class="quota-cell">
            ${this.inviteProgress(reserved, total)}
            ${this.quotaBreakdown(account)}
            ${this.accountWorkspaceInviteSummary(account)}
          </div>
        </td>
        <td>${this.quotaSyncMeta(account)}</td>
        <td>
          <div class="action-btns">
            <button class="action-btn tone-blue" title="发送邀请" onclick="App.openInviteModal(${account.id})">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
            </button>
            <button class="action-btn tone-purple" title="同步名额" onclick="App.syncAccountQuota(${account.id})">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2v6h-6"/><path d="M3 22v-6h6"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L3 8"/><path d="M3.51 15a9 9 0 0 0 14.85 3.36L21 16"/></svg>
            </button>
            <button class="action-btn tone-yellow" title="成员管理" onclick="App.openMembersModal(${account.id})">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><path d="M20 8v6"/><path d="M23 11h-6"/></svg>
            </button>
            <button class="action-btn tone-orange" title="坏号检测" onclick="App.inspectInviteHealth(${account.id})">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><path d="M11 8v3"/><path d="M11 16h.01"/></svg>
            </button>
            ${Number(account.invite_paused || 0) ? `
            <button class="action-btn tone-green" title="恢复邀请" onclick="App.restoreInviteHealth(${account.id})">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 3-6.7"/><polyline points="3 3 3 9 9 9"/></svg>
            </button>
            ` : ''}
            <button class="action-btn tone-green" title="账号授权" onclick="App.oauthAccount(${account.id})">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            </button>
            <button class="action-btn" title="编辑" onclick="App.editAccount(${account.id})">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="action-btn" title="立即检查" onclick="App.checkSingle(${account.id})">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
            </button>
            <button class="action-btn danger" title="删除" onclick="App.deleteAccount(${account.id})">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </div>
        </td>
      </tr>
    `;
  },

  recommendationRowWithEffectiveLock(item) {
    const canInvite = item.recommendation_state === 'available' || item.recommendation_state === 'cooldown';
    const tone = item.recommendation_state === 'available'
      ? 'success'
      : (item.recommendation_state === 'full' || item.recommendation_state === 'locked' ? 'warning' : 'neutral');
    const inviteLabel = item.recommendation_state === 'locked'
      ? (Number(item.auto_invite_locked || 0) === 1 ? '满员锁定' : '已锁定')
      : (canInvite ? '发邀请' : '不可发');

    return `
      <tr>
        <td>${this.escapeHtml(item.workspace_name || item.workspace_id)}</td>
        <td>${this.escapeHtml(item.account_email || '')}</td>
        <td>${this.healthBadge(item.health_score, item.health_label)}</td>
        <td>${this.quotaPill(this.recommendationLabel(item.recommendation_state), tone)}</td>
        <td>${this.escapeHtml(`${item.projected_remaining_seats}`)}</td>
        <td>
          <div class="member-table-actions">
            <button class="member-inline-btn" onclick="App.jumpToWorkspace(${this.jsString(item.workspace_id)}, ${this.jsString(item.workspace_name || item.workspace_id)})">定位</button>
            <button class="member-inline-btn ${canInvite ? '' : 'disabled'}" ${canInvite ? `onclick="App.openWorkspaceInvite(${item.account_id}, ${this.jsString(item.workspace_id)}, ${this.jsString(item.workspace_name || item.workspace_id)})"` : 'disabled'}>${this.escapeHtml(inviteLabel)}</button>
          </div>
        </td>
      </tr>
    `;
  },

  recommendationRow(item) {
    const canInvite = item.recommendation_state === 'available' || item.recommendation_state === 'cooldown';
    return `
      <tr>
        <td>${this.escapeHtml(item.workspace_name || item.workspace_id)}</td>
        <td>${this.escapeHtml(item.account_email || '')}</td>
        <td>${this.healthBadge(item.health_score, item.health_label)}</td>
        <td>${this.quotaPill(this.recommendationLabel(item.recommendation_state), item.recommendation_state === 'available' ? 'success' : (item.recommendation_state === 'full' ? 'warning' : 'neutral'))}</td>
        <td>${this.escapeHtml(`${item.projected_remaining_seats}`)}</td>
        <td>
          <div class="member-table-actions">
            <button class="member-inline-btn" onclick="App.jumpToWorkspace(${this.jsString(item.workspace_id)}, ${this.jsString(item.workspace_name || item.workspace_id)})">定位</button>
            <button class="member-inline-btn ${canInvite ? '' : 'disabled'}" ${canInvite ? `onclick="App.openWorkspaceInvite(${item.account_id}, ${this.jsString(item.workspace_id)}, ${this.jsString(item.workspace_name || item.workspace_id)})"` : 'disabled'}>${canInvite ? '发邀请' : '不可发'}</button>
          </div>
        </td>
      </tr>
    `;
  },

  memberSearchRow(item) {
    return `
      <tr>
        <td>${this.escapeHtml(item.email || '')}</td>
        <td>${this.escapeHtml(item.name || '')}</td>
        <td>${this.escapeHtml(item.workspace_name || item.workspace_id)}</td>
        <td>${this.escapeHtml(item.account_email || '')}</td>
        <td>${this.escapeHtml(this.memberRoleLabel(item.role))}</td>
      </tr>
    `;
  },

  inviteRemoteStateLabel(state) {
    const labels = {
      member: '\u5df2\u6210\u6210\u5458',
      pending: '\u8fdc\u7aef\u5f85\u63a5\u53d7',
      missing: '\u8fdc\u7aef\u672a\u627e\u5230',
    };
    return labels[state] || '\u672a\u6821\u6b63';
  },

  addAccountModal(account = null) {
    const isEdit = !!account;
    return `
      <form id="account-form">
        <div class="form-group">
          <label for="acc-email">\u90ae\u7bb1 *</label>
          <input type="email" id="acc-email" class="form-input" required value="${isEdit ? this.escapeHtml(account.email) : ''}" placeholder="account@example.com">
        </div>
        <div class="form-group">
          <label for="acc-password">\u5bc6\u7801</label>
          <input type="password" id="acc-password" class="form-input" value="${isEdit ? this.escapeHtml(account.password) : ''}" placeholder="\u53ef\u9009">
        </div>
        <div class="form-group">
          <label for="acc-label">\u6807\u7b7e</label>
          <input type="text" id="acc-label" class="form-input" value="${isEdit ? this.escapeHtml(account.label) : ''}" placeholder="\u5907\u6ce8">
        </div>
        <div class="form-group">
          <label for="acc-invite-link">\u9080\u8bf7\u94fe\u63a5</label>
          <input type="text" id="acc-invite-link" class="form-input" value="${isEdit ? this.escapeHtml(account.invite_link) : ''}" placeholder="https://...">
        </div>
        <div class="grid-two">
          <div class="form-group">
            <label for="acc-invite-total">\u672c\u5730\u603b\u540d\u989d</label>
            <input type="number" id="acc-invite-total" class="form-input" min="0" max="100" value="${isEdit ? account.invite_total : 4}">
          </div>
          <div class="form-group">
            <label for="acc-invited-count">\u5360\u4f4d\u6210\u5458\u6570</label>
            <input type="number" id="acc-invited-count" class="form-input" min="0" max="100" value="${isEdit ? account.invited_count : 0}">
          </div>
        </div>
        <div class="form-actions">
          <button type="button" class="btn btn-secondary" onclick="App.closeModal()">\u53d6\u6d88</button>
          <button type="submit" class="btn btn-primary">${isEdit ? '\u4fdd\u5b58\u66f4\u6539' : '\u6dfb\u52a0\u8d26\u53f7'}</button>
        </div>
      </form>
    `;
  },

  oauthAssistModal(account = null, authUrl = '') {
    const accountName = this.escapeHtml(account?.email || '当前账号');
    const safeAuthUrl = this.escapeHtml(authUrl || '');
    return `
      <div>
        <p class="form-intro">
          已为 ${accountName} 生成新的 OAuth 授权链接。请先在新标签页完成 OpenAI 登录。
        </p>
        <div class="form-group">
          <label>第 1 步：打开授权页</label>
          <div class="form-help">
            如果浏览器没有自动打开，请点击下面这个按钮重新打开授权页。
          </div>
          <div class="form-actions form-actions-spaced">
            <a class="btn btn-primary" href="${safeAuthUrl}" target="_blank" rel="noopener noreferrer">打开授权页</a>
          </div>
        </div>
        <div class="form-group">
          <label for="oauth-callback-url">第 2 步：粘贴回调链接</label>
          <div class="form-help">
            如果授权完成后页面跳到 <code>http://localhost:1455/auth/callback...</code> 并提示无法访问，
            请把浏览器地址栏里的完整链接复制到下面，再点“完成授权”。
          </div>
          <textarea
            id="oauth-callback-url"
            class="form-input"
            rows="5"
            placeholder="http://localhost:1455/auth/callback?code=...&state=..."
            spellcheck="false"
          ></textarea>
        </div>
        <div class="form-actions form-actions-spaced">
          <button type="button" class="btn btn-secondary" onclick="App.closeModal()">取消</button>
          <button type="button" class="btn btn-primary" id="btn-complete-oauth" onclick="App.completeOAuthFromCallback()">完成授权</button>
        </div>
      </div>
    `;
  },

  importModal() {
    return `
      <div>
        <p class="form-intro">
          支持 JSON 或 CSV 导入，每行一个账号。
        </p>
        <textarea class="import-textarea" id="import-data" placeholder='[
  { "email": "user1@example.com", "password": "pass123", "label": "\u8d26\u53f71" },
  { "email": "user2@example.com", "password": "pass456", "label": "\u8d26\u53f72" }
]

\u6216\uff1a
email,password,label
user1@example.com,pass123,\u8d26\u53f71
user2@example.com,pass456,\u8d26\u53f72'></textarea>
        <div class="form-actions">
          <button type="button" class="btn btn-secondary" onclick="App.closeModal()">\u53d6\u6d88</button>
          <button type="button" class="btn btn-primary" onclick="App.handleImport()">\u5bfc\u5165</button>
        </div>
      </div>
    `;
  },

  escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
  },

  inviteModal(accountId, state = {}) {
    const workspaces = Array.isArray(state.workspaces) ? state.workspaces : [];
    const selectedWorkspaceId = state.selectedWorkspaceId || '';
    const workspaceOptions = workspaces.map(workspace => `
      <option value="${this.escapeHtml(workspace.id)}" ${workspace.id === selectedWorkspaceId ? 'selected' : ''}>
        ${this.escapeHtml(workspace.name || workspace.id)}${workspace.plan_type ? ` (${this.escapeHtml(workspace.plan_type)})` : ''}
      </option>
    `).join('');
    const workspaceSummary = state.loading
      ? '\u6b63\u5728\u8bfb\u53d6\u8d26\u53f7\u4e0b\u7684\u5de5\u4f5c\u533a...'
      : state.error
        ? this.escapeHtml(state.error)
        : workspaces.length === 0
          ? '\u672a\u627e\u5230\u53ef\u7528\u5de5\u4f5c\u533a'
          : workspaces.length === 1
            ? `\u5c06\u53d1\u9001\u5230\uff1a${this.escapeHtml(workspaces[0].name || workspaces[0].id)}`
            : `\u5f53\u524d\u8d26\u53f7\u6709 ${workspaces.length} \u4e2a\u56e2\uff0c\u53ef\u6307\u5b9a\u53d1\u9001\u5230\u5176\u4e2d\u4e00\u4e2a`;

    return `
      <div>
        <p class="form-intro">
          为账号 #${accountId} 发送官方团队邀请，支持在单号下选择不同工作区发送。
        </p>
        <div class="form-group">
          <label for="invite-email">\u76ee\u6807\u90ae\u7bb1 *</label>
          <input type="email" id="invite-email" class="form-input" placeholder="someone@example.com" required ${state.loading ? 'disabled' : ''}>
        </div>
        <div class="form-group">
          <label for="invite-workspace">\u53d1\u9001\u5230\u5de5\u4f5c\u533a</label>
          ${state.loading ? `
            <div class="form-input form-input-readonly">正在加载工作区...</div>
          ` : workspaces.length > 1 ? `
            <select id="invite-workspace" class="select-input">
              ${workspaceOptions}
            </select>
          ` : `
            <input type="text" id="invite-workspace-label" class="form-input" value="${this.escapeHtml(workspaces[0]?.name || workspaces[0]?.id || '\u672a\u77e5')}" disabled>
            <input type="hidden" id="invite-workspace" value="${this.escapeHtml(workspaces[0]?.id || '')}">
          `}
          <div class="form-help">${workspaceSummary}</div>
        </div>
        <div class="form-actions form-actions-spaced">
          <button type="button" class="btn btn-secondary" onclick="App.closeModal()">\u53d6\u6d88</button>
          <button type="button" class="btn btn-primary" id="btn-submit-invite" onclick="App.handleSendInvite(${accountId})" ${state.loading || state.error || workspaces.length === 0 ? 'disabled' : ''}>\u53d1\u9001\u9080\u8bf7</button>
        </div>
      </div>
    `;
  },

  autoInviteModal() {
    return `
      <div>
        <p class="form-intro">
          输入一个目标邮箱，系统会自动选择有可用预占余量的账号发送邀请。
        </p>
        <div class="form-group">
          <label for="auto-invite-email">\u76ee\u6807\u90ae\u7bb1 *</label>
          <input type="email" id="auto-invite-email" class="form-input" placeholder="someone@example.com" required>
        </div>
        <div class="form-actions form-actions-spaced">
          <button type="button" class="btn btn-secondary" onclick="App.closeModal()">\u53d6\u6d88</button>
          <button type="button" class="btn btn-primary" id="btn-submit-auto-invite" onclick="App.handleAutoInvite()">\u81ea\u52a8\u9080\u8bf7</button>
        </div>
      </div>
    `;
  },

  bulkAutoInviteModal() {
    return `
      <div>
        <p class="form-intro">
          粘贴多个邮箱，前端会排队逐个分配可用账号发送邀请。
        </p>
        <div class="form-group">
          <label for="bulk-invite-emails">\u76ee\u6807\u90ae\u7bb1 *</label>
          <textarea id="bulk-invite-emails" class="form-input" rows="6" placeholder="a@a.com&#10;b@b.com" required></textarea>
        </div>

        <div id="bulk-invite-progress-container" class="hidden progress-box">
          <h4 class="progress-title">发送进度 <span id="bulk-invite-status-text">0 / 0</span></h4>

          <div class="progress-track">
            <div id="bulk-invite-progress-bar" class="progress-track-fill"></div>
          </div>

          <div id="bulk-invite-logs" class="log-console">
          </div>
        </div>

        <div class="form-actions form-actions-spaced">
          <button type="button" class="btn btn-secondary" id="btn-bulk-cancel" onclick="App.closeModal()">\u53d6\u6d88</button>
          <button type="button" class="btn btn-primary" id="btn-submit-bulk-invite" onclick="App.handleBulkAutoInvite()">\u5f00\u59cb\u6279\u91cf\u9080\u8bf7</button>
        </div>
      </div>
    `;
  },

  memberRoleOptions(member) {
    const options = [
      ['standard-user', '\u666e\u901a\u6210\u5458'],
      ['account-admin', '\u7ba1\u7406\u5458'],
    ];

    if (member && member.role === 'analytics-viewer') {
      options.splice(1, 0, ['analytics-viewer', '\u5206\u6790\u67e5\u770b\u8005']);
    }

    return options;
  },

  renderMemberRoleControl(accountId, member) {
    if (member.is_owner) {
      return `<span class="member-role-badge owner">${this.escapeHtml(this.memberRoleLabel(member.role))}</span>`;
    }

    const options = this.memberRoleOptions(member).map(([value, label]) => `
      <option value="${this.escapeHtml(value)}" ${member.role === value ? 'selected' : ''}>${this.escapeHtml(label)}</option>
    `).join('');

    return `
      <select class="select-input member-role-select" onchange="App.updateMemberRole(${accountId}, ${this.jsString(member.id)}, this.value)">
        ${options}
      </select>
    `;
  },

  renderFeatureList(items = [], emptyText = '\u6682\u65e0') {
    if (!Array.isArray(items) || items.length === 0) {
      return `<div class="member-detail-empty">${this.escapeHtml(emptyText)}</div>`;
    }

    return `
      <div class="member-detail-tag-list">
        ${items.map(item => {
          const label = item?.name || item?.email || item?.id || JSON.stringify(item);
          const description = item?.description ? `<span class="member-detail-tag-desc">${this.escapeHtml(item.description)}</span>` : '';
          return `<div class="member-detail-tag"><span>${this.escapeHtml(label)}</span>${description}</div>`;
        }).join('')}
      </div>
    `;
  },

  renderCreditLimit(detail) {
    if (!detail) {
      return `<div class="member-detail-empty">\u6682\u65e0\u7528\u91cf\u989d\u5ea6\u6570\u636e</div>`;
    }

    if (!detail.supported) {
      return `<div class="member-detail-empty">${this.escapeHtml(detail.message || '\u5f53\u524d\u5de5\u4f5c\u533a\u4e0d\u652f\u6301\u7528\u91cf\u989d\u5ea6\u67e5\u770b')}</div>`;
    }

    if (!detail.has_credit_limit) {
      return `<div class="member-detail-empty">\u8fd9\u4e2a\u6210\u5458\u76ee\u524d\u6ca1\u6709\u5355\u72ec\u8bbe\u7f6e\u7528\u91cf\u989d\u5ea6</div>`;
    }

    const formatValue = value => value == null ? '\u672a\u8bbe\u7f6e' : `${value}`;
    return `
      <div class="member-credit-grid">
        <div class="member-credit-card">
          <span class="member-credit-label">\u63d0\u9192\u9608\u503c</span>
          <strong class="member-credit-value">${this.escapeHtml(formatValue(detail.soft_alert_credit_limit?.limit))}</strong>
        </div>
        <div class="member-credit-card">
          <span class="member-credit-label">\u786c\u4e0a\u9650</span>
          <strong class="member-credit-value">${this.escapeHtml(formatValue(detail.hard_cap_credit_limit?.limit))}</strong>
        </div>
      </div>
    `;
  },

  memberDetailPanel(state) {
    if (state.detailLoading) {
      return `
        <div class="member-detail-panel">
          <div class="member-detail-empty">\u6b63\u5728\u52a0\u8f7d\u6210\u5458\u8be6\u60c5...</div>
        </div>
      `;
    }

    if (state.detailError) {
      return `
        <div class="member-detail-panel">
          <div class="member-detail-empty">${this.escapeHtml(state.detailError)}</div>
        </div>
      `;
    }

    const detail = state.detail;
    if (!detail || !detail.member) {
      return `
        <div class="member-detail-panel">
          <div class="member-detail-empty">\u70b9\u51fb\u5217\u8868\u4e2d\u7684\u201c\u8be6\u60c5\u201d\u67e5\u770b\u81ea\u5b9a\u4e49\u89d2\u8272\u3001\u7528\u6237\u7ec4\u548c\u7528\u91cf\u989d\u5ea6\u3002</div>
        </div>
      `;
    }

    const member = detail.member;
    const roles = detail.detail?.roles;
    const groups = detail.detail?.groups;
    const creditLimit = detail.detail?.credit_limit;

    return `
      <div class="member-detail-panel">
        <div class="member-detail-header">
          <div>
            <h4>${this.escapeHtml(member.name || member.email || '\u6210\u5458\u8be6\u60c5')}</h4>
            <div class="member-detail-subtitle">${this.escapeHtml(member.email || '')}</div>
          </div>
          <span class="member-role-badge ${member.is_owner ? 'owner' : ''}">${this.escapeHtml(this.memberRoleLabel(member.role))}</span>
        </div>
        <div class="member-meta-grid">
          <div class="member-meta-card">
            <span class="member-meta-label">\u5e10\u53f7\u7c7b\u578b</span>
            <strong class="member-meta-value">${this.escapeHtml(this.memberRoleLabel(member.role))}</strong>
          </div>
          <div class="member-meta-card">
            <span class="member-meta-label">\u5e2d\u4f4d\u7c7b\u578b</span>
            <strong class="member-meta-value">${this.escapeHtml(this.seatTypeLabel(member.seat_type))}</strong>
          </div>
          <div class="member-meta-card">
            <span class="member-meta-label">\u52a0\u5165\u65f6\u95f4</span>
            <strong class="member-meta-value">${this.escapeHtml(this.formatDate(member.created_time))}</strong>
          </div>
          <div class="member-meta-card">
            <span class="member-meta-label">User ID</span>
            <strong class="member-meta-value member-code">${this.escapeHtml(this.shortId(member.id))}</strong>
          </div>
        </div>
        <div class="member-detail-section">
          <div class="member-detail-section-title">\u9ad8\u7ea7\u89d2\u8272</div>
          ${roles && roles.supported
            ? this.renderFeatureList(roles.items, '\u5f53\u524d\u6210\u5458\u6ca1\u6709\u989d\u5916\u81ea\u5b9a\u4e49\u89d2\u8272')
            : `<div class="member-detail-empty">\u8fd9\u91cc\u6307\u7684\u662f\u201cRBAC \u81ea\u5b9a\u4e49\u89d2\u8272\u201d\uff0c\u4e0d\u662f\u5de6\u4fa7\u90a3\u4e2a\u201c\u666e\u901a\u6210\u5458 / \u7ba1\u7406\u5458\u201d\u8d26\u53f7\u7c7b\u578b\u3002${this.escapeHtml(roles?.message || '\u5f53\u524d Team \u5de5\u4f5c\u533a\u672a\u5f00\u542f RBAC')}</div>`}
        </div>
        <div class="member-detail-section">
          <div class="member-detail-section-title">\u7528\u6237\u7ec4</div>
          ${groups && groups.supported
            ? this.renderFeatureList(groups.items, '\u5f53\u524d\u6210\u5458\u6ca1\u6709\u6240\u5c5e\u7528\u6237\u7ec4')
            : `<div class="member-detail-empty">\u7528\u6237\u7ec4\u662f Enterprise \u90a3\u5957\u7ec4\u7ec7\u80fd\u529b\u3002${this.escapeHtml(groups?.message || '\u5f53\u524d\u5957\u9910\u4e0d\u652f\u6301\u7528\u6237\u7ec4')}</div>`}
        </div>
        <div class="member-detail-section">
          <div class="member-detail-section-title">\u7528\u91cf\u989d\u5ea6</div>
          ${this.renderCreditLimit(creditLimit)}
        </div>
      </div>
    `;
  },

  memberSourceIdentity(item) {
    const cdk = String(item?.source_cdk_code || '').trim();
    const taskId = String(item?.source_cdk_task_id || '').trim();

    if (!cdk && !taskId) {
      return '<span class="text-muted text-xs">-</span>';
    }

    return `
      <div class="member-source-identity">
        ${this.quotaPill('CDK', 'success')}
        <strong title="${this.escapeHtml(cdk || '-')}">${this.escapeHtml(cdk || '-')}</strong>
        <span class="text-muted text-xs" title="${this.escapeHtml(taskId || '')}">
          专属ID：${this.escapeHtml(this.shortId(taskId || '-'))}
        </span>
      </div>
    `;
  },

  memberCleanupRow(item, selected = false) {
    const isMember = item.item_type === 'member';
    const canKick = isMember && !item.is_owner && item.account_id && item.user_id;
    const canRevoke = !isMember && item.account_id && item.email;
    const checkboxDisabled = !canKick && !canRevoke;
    const eventTime = isMember ? item.joined_at : item.invited_at;
    const timeLabel = isMember ? '加入日期' : '邀请日期';
    const statusPills = isMember
      ? [
          this.quotaPill('成员', 'accent'),
          item.is_owner ? this.quotaPill('所有者', 'warning') : '',
          item.role ? this.quotaPill(this.memberRoleLabel(item.role), 'neutral') : '',
        ].filter(Boolean).join('')
      : [
          this.quotaPill('待邀请', 'warning'),
          item.remote_invite_id ? this.quotaPill(`远端ID ${this.shortId(item.remote_invite_id)}`, 'neutral', item.remote_invite_id) : '',
        ].filter(Boolean).join('');

    const actionButtons = [
      item.workspace_id
        ? `<button class="member-inline-btn" onclick="App.jumpToWorkspace(${this.jsString(item.workspace_id)}, ${this.jsString(item.workspace_name || item.workspace_id || '')})">定位</button>`
        : '',
      canKick
        ? `<button class="member-inline-btn danger" onclick="App.removeMemberCleanupItem(${Number(item.account_id || 0)}, ${this.jsString(item.user_id || '')}, ${this.jsString(item.workspace_id || '')}, ${this.jsString(item.workspace_name || item.workspace_id || '')}, ${this.jsString(item.plan_type || '')}, ${this.jsString(item.email || '')}, ${Number(item.workspace_row_id || 0)})">踢出</button>`
        : '',
      canRevoke
        ? `<button class="member-inline-btn warn" onclick="App.revokeMemberCleanupInvite(${Number(item.account_id || 0)}, ${this.jsString(item.email || '')}, ${this.jsString(item.workspace_id || '')}, ${this.jsString(item.workspace_name || item.workspace_id || '')}, ${this.jsString(item.plan_type || '')}, ${Number(item.workspace_row_id || 0)}, ${this.jsString(item.remote_invite_id || '')})">撤销待邀请</button>`
        : '',
    ].filter(Boolean).join('');

    return `
      <tr class="${selected ? 'member-cleanup-row-selected' : ''}">
        <td>
          <input
            type="checkbox"
            ${selected ? 'checked' : ''}
            ${checkboxDisabled ? 'disabled' : ''}
            onchange="App.toggleMemberCleanupSelection(${this.jsString(item.selection_key)}, this.checked)"
          >
        </td>
        <td>${this.escapeHtml(isMember ? '成员' : '待邀请')}</td>
        <td>
          <div class="member-cleanup-email">
            <strong class="cell-title">${this.escapeHtml(item.email || '-')}</strong>
            <span class="text-muted text-xs">${this.escapeHtml(item.name || (isMember ? '未命名成员' : '待接受邀请'))}</span>
          </div>
        </td>
        <td>
          <div class="stack-col-sm">
            <span>${this.escapeHtml(item.account_email || '')}</span>
            <span class="text-muted text-xs">${this.escapeHtml(item.plan_type || '')}</span>
          </div>
        </td>
        <td>
          <div class="stack-col-sm">
            <span>${this.escapeHtml(item.workspace_name || item.workspace_id || '-')}</span>
            <span class="text-muted text-xs">${this.escapeHtml(item.workspace_id || '')}</span>
          </div>
        </td>
        <td>${this.memberSourceIdentity(item)}</td>
        <td>
          <div class="surface-chip-row member-cleanup-role">
            ${statusPills}
          </div>
        </td>
        <td>
          <div class="member-cleanup-time">
            <span class="text-muted">${this.escapeHtml(timeLabel)}</span>
            <strong>${this.escapeHtml(this.formatDateTime(eventTime))}</strong>
            <span class="text-muted text-xs">${this.escapeHtml(this.timeAgo(eventTime))}</span>
          </div>
        </td>
        <td>
          <div class="member-table-actions">
            ${actionButtons || `<span class="text-muted text-xs">${this.escapeHtml(isMember && item.is_owner ? '所有者不可移出' : '暂无操作')}</span>`}
          </div>
        </td>
      </tr>
    `;
  },

  untrackedMemberRow(item, selected = false) {
    const isPending = item.item_type === 'pending';
    const canKick = !isPending && !Number(item.is_owner || 0) && item.account_id && item.user_id;
    const canRevoke = isPending && item.account_id && item.email;
    const canSelect = canKick || canRevoke;
    const eventTime = isPending ? item.invited_at : item.joined_at;
    const roleParts = [
      isPending ? this.quotaPill('待邀请', 'warning') : '',
      item.role ? this.quotaPill(this.memberRoleLabel(item.role), 'neutral') : '',
      item.seat_type ? this.quotaPill(this.seatTypeLabel(item.seat_type), 'accent') : '',
    ].filter(Boolean).join('');

    const actionButtons = [
      item.workspace_id
        ? `<button class="member-inline-btn" onclick="App.jumpToWorkspace(${this.jsString(item.workspace_id)}, ${this.jsString(item.workspace_name || item.workspace_id || '')})">定位</button>`
        : '',
      canKick
        ? `<button class="member-inline-btn danger" onclick="App.removeUntrackedMemberItem(${Number(item.account_id || 0)}, ${this.jsString(item.user_id || '')}, ${this.jsString(item.workspace_id || '')}, ${this.jsString(item.workspace_name || item.workspace_id || '')}, ${this.jsString(item.plan_type || '')}, ${this.jsString(item.email || '')}, ${Number(item.workspace_row_id || 0)})">踢出</button>`
        : '',
      canRevoke
        ? `<button class="member-inline-btn warn" onclick="App.revokeUntrackedPendingInvite(${Number(item.account_id || 0)}, ${this.jsString(item.email || '')}, ${this.jsString(item.workspace_id || '')}, ${this.jsString(item.workspace_name || item.workspace_id || '')}, ${this.jsString(item.plan_type || '')}, ${Number(item.workspace_row_id || 0)}, ${this.jsString(item.remote_invite_id || '')})">撤销待邀请</button>`
        : '',
    ].filter(Boolean).join('');

    return `
      <tr class="${selected ? 'member-cleanup-row-selected' : ''}">
        <td>
          <input
            type="checkbox"
            ${selected ? 'checked' : ''}
            ${canSelect ? '' : 'disabled'}
            onchange="App.toggleUntrackedMembersSelection(${this.jsString(item.selection_key)}, this.checked)"
          >
        </td>
        <td>
          <div class="member-cleanup-email">
            <strong class="cell-title">${this.escapeHtml(item.email || '-')}</strong>
            <span class="text-muted text-xs">${this.escapeHtml(item.name || '未命名成员')}</span>
          </div>
        </td>
        <td>
          <div class="stack-col-sm">
            <span>${this.escapeHtml(item.account_email || '')}</span>
            <span class="text-muted text-xs">${this.escapeHtml(item.plan_type || '')}</span>
          </div>
        </td>
        <td>
          <div class="stack-col-sm">
            <span>${this.escapeHtml(item.workspace_name || item.workspace_id || '-')}</span>
            <span class="text-muted text-xs">${this.escapeHtml(item.workspace_id || '')}</span>
          </div>
        </td>
        <td>
          <div class="surface-chip-row member-cleanup-role">
            ${roleParts || this.quotaPill('成员', 'neutral')}
          </div>
        </td>
        <td>
          <div class="member-cleanup-time">
            <strong>${this.escapeHtml(this.formatDateTime(eventTime))}</strong>
            <span class="text-muted text-xs">${this.escapeHtml(this.timeAgo(eventTime))}</span>
          </div>
        </td>
        <td>
          <span class="text-muted text-xs">${this.escapeHtml(item.source_message || '没有匹配到来源记录')}</span>
        </td>
        <td>
          <div class="member-table-actions">
            ${actionButtons || '<span class="text-muted text-xs">暂无操作</span>'}
          </div>
        </td>
      </tr>
    `;
  },

  membersModal(account, state = {}) {
    const members = Array.isArray(state.members) ? state.members : [];
    const total = Number(state.total || members.length || 0);
    const search = String(state.search || '').trim().toLowerCase();
    const visibleMembers = search
      ? members.filter(member => {
          const name = String(member.name || '').toLowerCase();
          const email = String(member.email || '').toLowerCase();
          return name.includes(search) || email.includes(search);
        })
      : members;

    const owners = members.filter(member => member.is_owner).length;
    const admins = members.filter(member => member.role === 'account-admin').length;
    const occupied = members.filter(member => member.seat_type === 'default' && !member.deactivated_time).length;

    const rows = state.loading
      ? `
        <tr>
          <td colspan="5">
            <div class="member-detail-empty">\u6b63\u5728\u52a0\u8f7d\u6210\u5458\u5217\u8868...</div>
          </td>
        </tr>
      `
      : visibleMembers.length === 0
        ? `
          <tr>
            <td colspan="5">
              <div class="member-detail-empty">${search ? '\u6ca1\u6709\u5339\u914d\u7684\u6210\u5458' : '\u6682\u65e0\u6210\u5458\u6570\u636e'}</div>
            </td>
          </tr>
        `
        : visibleMembers.map(member => `
          <tr class="${state.selectedUserId === member.id ? 'member-row-active' : ''}">
            <td>
              <div class="member-name-cell">
                <div class="member-name">${this.escapeHtml(member.name || '\u672a\u547d\u540d')}</div>
                <div class="member-email">${this.escapeHtml(member.email || '')}</div>
              </div>
            </td>
            <td>${this.renderMemberRoleControl(account.id, member)}</td>
            <td><span class="member-role-badge">${this.escapeHtml(this.seatTypeLabel(member.seat_type))}</span></td>
            <td><span class="text-muted">${this.escapeHtml(this.formatDate(member.created_time))}</span></td>
            <td>
              <div class="member-table-actions">
                <button class="member-inline-btn" onclick="App.loadMemberDetail(${account.id}, ${this.jsString(member.id)})">\u8be6\u60c5</button>
                ${member.is_owner ? '' : `<button class="member-inline-btn warn" onclick="App.logoutMember(${account.id}, ${this.jsString(member.id)})">\u4e0b\u7ebf</button>`}
                ${member.is_owner ? '' : `<button class="member-inline-btn danger" onclick="App.removeMember(${account.id}, ${this.jsString(member.id)})">\u8e22\u51fa</button>`}
              </div>
            </td>
          </tr>
        `).join('');

    return `
      <div class="members-modal">
        <div class="members-summary">
          <div class="members-summary-card">
            <span class="members-summary-label">\u5de5\u4f5c\u533a</span>
            <strong class="members-summary-value">${this.escapeHtml(account.quota_workspace_name || state.workspaceName || account.email)}</strong>
            <span class="members-summary-meta">${this.escapeHtml(account.quota_plan_type || state.planType || '')}</span>
          </div>
          <div class="members-summary-card">
            <span class="members-summary-label">\u6210\u5458\u603b\u6570</span>
            <strong class="members-summary-value">${total}</strong>
            <span class="members-summary-meta">\u5df2\u52a0\u8f7d ${members.length}</span>
          </div>
          <div class="members-summary-card">
            <span class="members-summary-label">\u89d2\u8272\u6982\u89c8</span>
            <strong class="members-summary-value">${owners}/${admins}/${occupied}</strong>
            <span class="members-summary-meta">\u6240\u6709\u8005 / \u7ba1\u7406\u5458 / \u5360\u4f4d</span>
          </div>
        </div>
        <div class="members-help">
          <span>\u5f53\u524d\u652f\u6301\u67e5\u770b\u5168\u90e8\u6210\u5458\u3001\u4fee\u6539\u5e10\u53f7\u7c7b\u578b\u3001\u5f3a\u5236\u4e0b\u7ebf\u548c\u8e22\u51fa\u6210\u5458\u3002</span>
          <span>\u81ea\u5b9a\u4e49\u89d2\u8272\u3001\u7528\u6237\u7ec4\u548c\u989d\u5ea6\u80fd\u529b\u6309 OpenAI \u4e0a\u6e38\u5b9e\u9645\u8fd4\u56de\u663e\u793a\u3002</span>
        </div>
        <div class="members-modal-grid">
          <div class="members-list-panel">
            <div class="members-list-toolbar">
              <div class="search-box members-search">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                <input type="text" value="${this.escapeHtml(state.search || '')}" placeholder="\u6309\u59d3\u540d\u6216\u90ae\u7bb1\u7b5b\u9009" oninput="App.filterMembers(this.value)">
              </div>
              <div class="members-toolbar-actions">
                <button class="btn btn-secondary" type="button" onclick="App.refreshMembersModal()">\u5237\u65b0</button>
              </div>
            </div>
            <div class="members-table-wrapper">
              <table class="accounts-table members-table">
                <thead>
                  <tr>
                    <th>\u6210\u5458</th>
                    <th>\u5e10\u53f7\u7c7b\u578b</th>
                    <th>\u5e2d\u4f4d</th>
                    <th>\u52a0\u5165\u65f6\u95f4</th>
                    <th>\u64cd\u4f5c</th>
                  </tr>
                </thead>
                <tbody>
                  ${rows}
                </tbody>
              </table>
            </div>
          </div>
          ${this.memberDetailPanel(state)}
        </div>
      </div>
    `;
  },

  workspaceRowWithEffectiveLock(workspace) {
    const occupied = Number(workspace.occupied_seats || 0);
    const pending = Number(workspace.pending_invites || 0);
    const total = Number(workspace.invite_total_hint || 0);
    const memberCount = Number(workspace.member_count || 0);
    const manualInviteLocked = Number(workspace.invite_locked || 0) === 1;
    const autoInviteLocked = Number(workspace.auto_invite_locked || 0) === 1;
    const inviteLocked = manualInviteLocked || autoInviteLocked;
    const autoLockOnly = autoInviteLocked && !manualInviteLocked;
    const projectedRaw = Number(workspace.projected_remaining_seats);
    const memberSlotsRaw = Number(workspace.remaining_seats);
    const projectedRemaining = Number.isFinite(projectedRaw) ? projectedRaw : total - occupied - pending;
    const memberSlots = Number.isFinite(memberSlotsRaw) ? memberSlotsRaw : total - occupied;
    const capacity = `${occupied + pending}/${total}`;
    const saleableText = projectedRemaining < 0
      ? `超额 ${Math.abs(projectedRemaining)}`
      : `可售余量 ${projectedRemaining}`;
    const saleableTone = projectedRemaining < 0 ? 'danger' : (projectedRemaining === 0 ? 'warning' : 'success');
    const memberSlotsText = memberSlots < 0
      ? `成员超额 ${Math.abs(memberSlots)}`
      : `成员空位 ${memberSlots}`;
    const autoLockLabel = memberCount > 8 ? '成员超员处理中' : '预占满员';
    const autoLockTitle = memberCount > 8
      ? '当前实际成员数已经超过 8，系统正在迁移超出的成员'
      : '当前占位 + 待邀请已经达到 8，系统已自动锁定并停止继续邀请';
    const statusLabel = manualInviteLocked && autoInviteLocked
      ? `手动锁定 / ${autoLockLabel}`
      : manualInviteLocked
        ? '手动锁定'
        : autoInviteLocked
          ? autoLockLabel
          : '未锁定';
    const statusTitle = manualInviteLocked && autoInviteLocked
      ? `这个空间同时处于手动锁定和${autoLockLabel}状态`
      : manualInviteLocked
        ? '你已手动锁定这个空间，邀请分配会跳过它'
        : autoInviteLocked
          ? autoLockTitle
          : '当前空间会参与邀请分配';
    const lockTitle = autoLockOnly
      ? autoLockTitle
      : (inviteLocked
        ? '已锁定，当前空间不会参与邀请分配'
        : '点击锁定后，这个空间不会再参与邀请分配');
    const inviteButtonTitle = inviteLocked ? `${statusLabel}，不能再选中邀请` : '发送邀请到这个工作区';

    return `
      <tr data-id="${workspace.id}">
        <td>
          <button
            class="action-btn ${(manualInviteLocked || autoInviteLocked) ? 'tone-red' : 'tone-green'} workspace-lock-btn ${autoLockOnly ? 'disabled' : ''}"
            title="${this.escapeHtml(lockTitle)}"
            aria-label="${this.escapeHtml(inviteLocked ? '解锁空间' : '锁定空间')}"
            ${autoLockOnly ? 'disabled' : `onclick="App.toggleWorkspaceInviteLock(${workspace.id}, ${inviteLocked ? 'false' : 'true'})"`}
          >
            ${inviteLocked
              ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 1 1 8 0v3"/></svg>'
              : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.75-1"/></svg>'}
          </button>
        </td>
        <td>
          <div class="stack-col-sm">
            <span class="cell-title">${this.escapeHtml(workspace.workspace_name || workspace.workspace_id)}</span>
            <span class="text-muted text-xs">${this.escapeHtml(workspace.workspace_id)}</span>
            <div class="surface-chip-row">
              ${this.quotaPill(statusLabel, inviteLocked ? 'warning' : 'neutral', statusTitle)}
            </div>
          </div>
        </td>
        <td>
          <div class="stack-col-sm">
            <span>${this.escapeHtml(workspace.account_email || '')}</span>
            <span class="text-muted text-xs">${this.escapeHtml(workspace.plan_type || '')}</span>
          </div>
        </td>
        <td>
          <div class="surface-chip-row">
            ${this.workspaceSyncBadge(workspace.sync_status)}
            ${this.healthBadge(workspace.health_score, workspace.health_label)}
          </div>
        </td>
        <td>
          <div class="stack-col-md">
            ${this.quotaPill(`成员 ${workspace.member_count || 0}`, 'neutral')}
            ${this.quotaPill(`占位 ${workspace.occupied_seats || 0}`, 'neutral')}
            ${this.quotaPill(`待邀请 ${workspace.pending_invites || 0}`, Number(workspace.pending_invites || 0) > 0 ? 'accent' : 'neutral')}
            ${this.quotaPill(saleableText, saleableTone)}
            ${this.quotaPill(memberSlotsText, memberSlots <= 1 ? 'warning' : 'neutral')}
          </div>
        </td>
        <td>
          <div class="stack-col-sm">
            <span>${this.escapeHtml(capacity)}</span>
            <span class="text-muted text-xs">最近同步 ${this.timeAgo(workspace.last_synced_at)}</span>
            ${workspace.sync_message ? `<span class="quota-sync-message" title="${this.escapeHtml(workspace.sync_message)}">${this.escapeHtml(workspace.sync_message)}</span>` : ''}
          </div>
        </td>
        <td>
          <div class="action-btns">
            <button class="action-btn tone-yellow" title="查看这个工作区的成员" onclick="App.openWorkspaceMembers(${workspace.account_id}, ${this.jsString(workspace.workspace_id)}, ${this.jsString(workspace.workspace_name || workspace.workspace_id)}, ${this.jsString(workspace.plan_type || '')}, ${this.jsString(workspace.account_email || '')})">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            </button>
            <button class="action-btn tone-blue ${inviteLocked ? 'disabled' : ''}" title="${this.escapeHtml(inviteButtonTitle)}" ${inviteLocked ? 'disabled' : `onclick="App.openWorkspaceInvite(${workspace.account_id}, ${this.jsString(workspace.workspace_id)}, ${this.jsString(workspace.workspace_name || workspace.workspace_id)})"`}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
            </button>
            <button class="action-btn tone-purple" title="同步工作区" onclick="App.syncWorkspace(${workspace.id})">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2v6h-6"/><path d="M3 22v-6h6"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L3 8"/><path d="M3.51 15a9 9 0 0 0 14.85 3.36L21 16"/></svg>
            </button>
            <button class="action-btn tone-green" title="导出成员" onclick="App.exportWorkspace(${workspace.id})">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            </button>
          </div>
        </td>
      </tr>
    `;
  },

  recommendationRowWithEffectiveLock(item) {
    const canInvite = item.recommendation_state === 'available' || item.recommendation_state === 'cooldown';
    const memberCount = Number(item.member_count || 0);
    const lockedLabel = Number(item.auto_invite_locked || 0) === 1
      ? (memberCount > 8 ? '成员超员处理中' : '预占满员')
      : '已锁定';
    const tone = item.recommendation_state === 'available'
      ? 'success'
      : (item.recommendation_state === 'full' || item.recommendation_state === 'locked' ? 'warning' : 'neutral');
    const inviteLabel = item.recommendation_state === 'locked'
      ? lockedLabel
      : (canInvite ? '发邀请' : '不可发');
    const stateLabel = item.recommendation_state === 'locked'
      ? lockedLabel
      : this.recommendationLabel(item.recommendation_state);

    return `
      <tr>
        <td>${this.escapeHtml(item.workspace_name || item.workspace_id)}</td>
        <td>${this.escapeHtml(item.account_email || '')}</td>
        <td>${this.healthBadge(item.health_score, item.health_label)}</td>
        <td>${this.quotaPill(stateLabel, tone)}</td>
        <td>${this.escapeHtml(`${item.projected_remaining_seats}`)}</td>
        <td>
          <div class="member-table-actions">
            <button class="member-inline-btn" onclick="App.jumpToWorkspace(${this.jsString(item.workspace_id)}, ${this.jsString(item.workspace_name || item.workspace_id)})">定位</button>
            <button class="member-inline-btn ${canInvite ? '' : 'disabled'}" ${canInvite ? `onclick="App.openWorkspaceInvite(${item.account_id}, ${this.jsString(item.workspace_id)}, ${this.jsString(item.workspace_name || item.workspace_id)})"` : 'disabled'}>${this.escapeHtml(inviteLabel)}</button>
          </div>
        </td>
      </tr>
    `;
  },
};

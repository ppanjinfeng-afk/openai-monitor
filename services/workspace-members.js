const { withBrowserPage } = require('./browser');

function withWorkspacePage(work) {
  return withBrowserPage(work);
}

async function runWorkspaceAction(account, action, params = {}, options = {}) {
  const execute = async page => page.evaluate(async ({ accessToken, workspaceIdHint, workspaceNameHint, planTypeHint, action, params }) => {
    const isUuid = value => /^[0-9a-fA-F-]{36}$/.test(String(value || ''));
    const normalizePlanType = value => String(value || '').trim().toLowerCase();
    const isWorkspacePlan = value => {
      const planType = normalizePlanType(value);
      if (!planType) return false;
      if (['free', 'plus', 'pro', 'personal', 'default'].includes(planType)) {
        return false;
      }
      return (
        planType.includes('team') ||
        planType.includes('business') ||
        planType.includes('enterprise') ||
        planType.includes('workspace')
      );
    };

    const getHeaders = (workspaceId, extraHeaders = {}) => {
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'OAI-Language': 'en-US',
      };

      if (workspaceId) {
        headers['ChatGPT-Account-Id'] = workspaceId;
      }

      return { ...headers, ...extraHeaders };
    };

    const parseResponse = async response => {
      const text = await response.text();
      try {
        return { text, data: JSON.parse(text) };
      } catch {
        return { text, data: null };
      }
    };

    const extractErrorMessage = (payload, fallbackText, status) => {
      const candidates = [
        payload?.error_description,
        payload?.message,
        payload?.detail,
        payload?.error?.message,
        payload?.error,
      ];

      for (const candidate of candidates) {
        if (candidate == null) continue;
        if (typeof candidate === 'string' && candidate.trim()) {
          return candidate.trim();
        }

        try {
          const json = JSON.stringify(candidate);
          if (json && json !== 'null') {
            return json;
          }
        } catch {}
      }

      return fallbackText || `HTTP ${status}`;
    };

    const localizeFeatureMessage = (message, status) => {
      const lower = String(message || '').toLowerCase();
      if (lower.includes('rbac not enabled')) {
        return '\u5f53\u524d Team \u5de5\u4f5c\u533a\u672a\u5f00\u542f RBAC';
      }
      if (lower.includes('enterprise plan required')) {
        return '\u5f53\u524d\u5957\u9910\u4e0d\u652f\u6301\u8fd9\u4e2a\u529f\u80fd';
      }
      if (status === 404) {
        return '\u5f53\u524d\u5de5\u4f5c\u533a\u6ca1\u6709\u5f00\u653e\u8fd9\u4e2a\u63a5\u53e3';
      }
      return message;
    };

    const resolveWorkspace = async () => {
      if (isUuid(workspaceIdHint)) {
        return {
          success: true,
          workspaceId: workspaceIdHint,
          workspaceName: workspaceNameHint || '',
          planType: planTypeHint || '',
        };
      }

      const response = await fetch(
        'https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27?server_time=true',
        { headers: getHeaders(null) }
      );
      const parsed = await parseResponse(response);

      if (!response.ok) {
        return {
          success: false,
          message: `\u83b7\u53d6\u5de5\u4f5c\u533a\u5931\u8d25 (HTTP ${response.status}): ${extractErrorMessage(parsed.data, parsed.text, response.status)}`,
        };
      }

      const entries = Object.entries(parsed.data?.accounts || {});
      const workspaceEntry =
        entries.find(([accountId, details]) => details?.is_workspace && isUuid(accountId)) ||
        entries.find(([accountId, details]) => details?.is_personal === false && isUuid(accountId)) ||
        entries.find(([accountId, details]) => isUuid(accountId) && isWorkspacePlan(details?.account?.plan_type));

      if (!workspaceEntry) {
        return {
          success: false,
          message: '\u672a\u627e\u5230\u53ef\u7528\u7684\u5de5\u4f5c\u533a ID',
        };
      }

      return {
        success: true,
        workspaceId: workspaceEntry[0],
        workspaceName: workspaceEntry[1]?.account?.name || '',
        planType: workspaceEntry[1]?.account?.plan_type || '',
      };
    };

    const normalizeMember = item => ({
      id: item?.id || '',
      account_user_id: item?.account_user_id || '',
      name: item?.name || '',
      email: item?.email || '',
      role: item?.role || '',
      seat_type: item?.seat_type || '',
      created_time: item?.created_time || '',
      deactivated_time: item?.deactivated_time || '',
      is_scim_managed: Boolean(item?.is_scim_managed),
      is_owner: item?.role === 'account-owner',
    });

    const fetchMembers = async (workspaceId, searchQuery = '') => {
      const limit = 100;
      let offset = 0;
      let total = 0;
      const members = [];

      while (true) {
        const query = encodeURIComponent(searchQuery || '');
        const response = await fetch(
          `https://chatgpt.com/backend-api/accounts/${workspaceId}/users?limit=${limit}&offset=${offset}&query=${query}`,
          { headers: getHeaders(workspaceId) }
        );
        const parsed = await parseResponse(response);

        if (!response.ok) {
          return {
            success: false,
            message: `\u83b7\u53d6\u6210\u5458\u5217\u8868\u5931\u8d25 (HTTP ${response.status}): ${extractErrorMessage(parsed.data, parsed.text, response.status)}`,
          };
        }

        const items = Array.isArray(parsed.data?.items) ? parsed.data.items : [];
        total = Number(parsed.data?.total || items.length || 0);
        members.push(...items.map(normalizeMember));

        offset += items.length;
        if (items.length === 0 || offset >= total) {
          break;
        }
      }

      return {
        success: true,
        total,
        members,
      };
    };

    const findMemberById = async (workspaceId, userId) => {
      const allMembers = await fetchMembers(workspaceId, '');
      if (!allMembers.success) {
        return allMembers;
      }

      const member = allMembers.members.find(item => item.id === userId);
      if (!member) {
        return {
          success: false,
          message: '\u672a\u627e\u5230\u6307\u5b9a\u6210\u5458',
        };
      }

      return {
        success: true,
        member,
      };
    };

    const fetchOptionalFeature = async ({ workspaceId, member, path, method = 'GET' }) => {
      const response = await fetch(path, {
        method,
        headers: getHeaders(workspaceId),
      });
      const parsed = await parseResponse(response);

      if (response.ok) {
        return {
          supported: true,
          success: true,
          data: parsed.data,
        };
      }

      const message = localizeFeatureMessage(
        extractErrorMessage(parsed.data, parsed.text, response.status),
        response.status
      );
      const lower = message.toLowerCase();
      const unsupported =
        response.status === 401 ||
        response.status === 403 ||
        response.status === 404 ||
        lower.includes('rbac not enabled') ||
        lower.includes('enterprise plan required') ||
        lower.includes('not enabled');

      return {
        supported: !unsupported,
        success: false,
        message,
      };
    };

    const workspace = await resolveWorkspace();
    if (!workspace.success) {
      return workspace;
    }

    if (action === 'list-members') {
      const membersResult = await fetchMembers(workspace.workspaceId, params.search || '');
      if (!membersResult.success) {
        return membersResult;
      }

      return {
        success: true,
        workspaceId: workspace.workspaceId,
        workspaceName: workspace.workspaceName,
        planType: workspace.planType,
        total: membersResult.total,
        members: membersResult.members,
      };
    }

    if (action === 'member-detail') {
      const memberResult = await findMemberById(workspace.workspaceId, params.userId);
      if (!memberResult.success) {
        return memberResult;
      }

      const member = memberResult.member;
      const rolesResult = await fetchOptionalFeature({
        workspaceId: workspace.workspaceId,
        member,
        path: `https://chatgpt.com/backend-api/rbac/workspace/${workspace.workspaceId}/principals/${member.id}/roles?account_id=${workspace.workspaceId}&consistency=strong`,
      });
      const groupsResult = await fetchOptionalFeature({
        workspaceId: workspace.workspaceId,
        member,
        path: `https://chatgpt.com/backend-api/accounts/${workspace.workspaceId}/users/${member.account_user_id}/groups`,
      });
      const creditLimitResult = await fetchOptionalFeature({
        workspaceId: workspace.workspaceId,
        member,
        path: `https://chatgpt.com/backend-api/rbac/workspace/${workspace.workspaceId}/principals/${member.id}/credit-limit?account_id=${workspace.workspaceId}&consistency=strong`,
      });

      return {
        success: true,
        workspaceId: workspace.workspaceId,
        workspaceName: workspace.workspaceName,
        planType: workspace.planType,
        member,
        detail: {
          roles: rolesResult.success
            ? { supported: true, items: rolesResult.data?.roles || [] }
            : { supported: rolesResult.supported, message: rolesResult.message },
          groups: groupsResult.success
            ? { supported: true, items: groupsResult.data?.items || [] }
            : { supported: groupsResult.supported, message: groupsResult.message },
          credit_limit: creditLimitResult.success
            ? { supported: true, ...creditLimitResult.data }
            : { supported: creditLimitResult.supported, message: creditLimitResult.message },
        },
      };
    }

    if (action === 'update-member') {
      const requestBody = {};
      if (params.role !== undefined) {
        requestBody.role = params.role;
      }
      if (params.seatType !== undefined) {
        requestBody.seat_type = params.seatType;
      }

      const response = await fetch(
        `https://chatgpt.com/backend-api/accounts/${workspace.workspaceId}/users/${params.userId}`,
        {
          method: 'PATCH',
          headers: getHeaders(workspace.workspaceId, {
            'Content-Type': 'application/json',
          }),
          body: JSON.stringify(requestBody),
        }
      );
      const parsed = await parseResponse(response);

      if (!response.ok) {
        return {
          success: false,
          message: `\u66f4\u65b0\u6210\u5458\u5931\u8d25 (HTTP ${response.status}): ${extractErrorMessage(parsed.data, parsed.text, response.status)}`,
        };
      }

      return {
        success: true,
        message: parsed.data?.success ? 'Member updated' : 'Member updated',
        workspaceId: workspace.workspaceId,
      };
    }

    if (action === 'remove-member') {
      const response = await fetch(
        `https://chatgpt.com/backend-api/accounts/${workspace.workspaceId}/users/${params.userId}`,
        {
          method: 'DELETE',
          headers: getHeaders(workspace.workspaceId),
        }
      );
      const parsed = await parseResponse(response);

      if (!response.ok) {
        return {
          success: false,
          message: `\u79fb\u51fa\u6210\u5458\u5931\u8d25 (HTTP ${response.status}): ${extractErrorMessage(parsed.data, parsed.text, response.status)}`,
        };
      }

      return {
        success: true,
        message: 'Member removed',
        workspaceId: workspace.workspaceId,
      };
    }

    if (action === 'remove-members') {
      const members = (Array.isArray(params.members) ? params.members : [])
        .map((item, index) => ({
          clientIndex: Number.isFinite(Number(item?.clientIndex)) ? Number(item.clientIndex) : index,
          userId: String(item?.userId || '').trim(),
          email: String(item?.email || '').trim(),
        }))
        .filter(item => item.userId);

      if (members.length === 0) {
        return {
          success: false,
          message: 'No members to remove',
          workspaceId: workspace.workspaceId,
          results: [],
          removed: 0,
          failed: 0,
        };
      }

      const concurrency = Math.max(1, Math.min(Number(params.concurrency || 4) || 4, 8));
      const results = new Array(members.length);
      let cursor = 0;

      const removeOne = async member => {
        try {
          const response = await fetch(
            `https://chatgpt.com/backend-api/accounts/${workspace.workspaceId}/users/${member.userId}`,
            {
              method: 'DELETE',
              headers: getHeaders(workspace.workspaceId),
            }
          );
          const parsed = await parseResponse(response);

          if (!response.ok) {
            return {
              clientIndex: member.clientIndex,
              userId: member.userId,
              email: member.email,
              success: false,
              message: `\u79fb\u51fa\u6210\u5458\u5931\u8d25 (HTTP ${response.status}): ${extractErrorMessage(parsed.data, parsed.text, response.status)}`,
            };
          }

          return {
            clientIndex: member.clientIndex,
            userId: member.userId,
            email: member.email,
            success: true,
            message: 'Member removed',
          };
        } catch (err) {
          return {
            clientIndex: member.clientIndex,
            userId: member.userId,
            email: member.email,
            success: false,
            message: err.message || 'Remove member failed',
          };
        }
      };

      const workerCount = Math.min(concurrency, members.length);
      await Promise.all(Array.from({ length: workerCount }, async () => {
        while (cursor < members.length) {
          const current = cursor;
          cursor += 1;
          results[current] = await removeOne(members[current]);
        }
      }));

      const removed = results.filter(item => item?.success).length;
      const failed = results.length - removed;

      return {
        success: failed === 0,
        message: failed === 0 ? 'Members removed' : 'Some members failed to remove',
        workspaceId: workspace.workspaceId,
        results,
        removed,
        failed,
      };
    }

    if (action === 'logout-member') {
      const response = await fetch(
        `https://chatgpt.com/backend-api/accounts/${workspace.workspaceId}/users/${params.userId}/logout_all`,
        {
          method: 'POST',
          headers: getHeaders(workspace.workspaceId),
        }
      );
      const parsed = await parseResponse(response);

      if (!response.ok) {
        return {
          success: false,
          message: `\u6210\u5458\u4e0b\u7ebf\u5931\u8d25 (HTTP ${response.status}): ${extractErrorMessage(parsed.data, parsed.text, response.status)}`,
        };
      }

      return {
        success: true,
        message: 'Member logged out',
        workspaceId: workspace.workspaceId,
      };
    }

    if (action === 'revoke-pending-invite') {
      const email = String(params.email || '').trim();
      if (!email) {
        return {
          success: false,
          message: '\u53d7\u9080\u90ae\u7bb1\u4e0d\u80fd\u4e3a\u7a7a',
        };
      }

      const response = await fetch(
        `https://chatgpt.com/backend-api/accounts/${workspace.workspaceId}/invites`,
        {
          method: 'DELETE',
          headers: getHeaders(workspace.workspaceId, {
            'Content-Type': 'application/json',
          }),
          body: JSON.stringify({
            email_address: email,
          }),
        }
      );
      const parsed = await parseResponse(response);
      const message = extractErrorMessage(parsed.data, parsed.text, response.status);

      if (!response.ok) {
        const lower = String(message || '').toLowerCase();
        if (response.status === 404 && lower.includes('invite not found')) {
          return {
            success: true,
            found: false,
            message: 'Invite already missing',
            workspaceId: workspace.workspaceId,
          };
        }

        return {
          success: false,
          message: `\u64a4\u9500\u5f85\u9080\u8bf7\u5931\u8d25 (HTTP ${response.status}): ${message}`,
        };
      }

      return {
        success: true,
        found: true,
        message: 'Invite revoked',
        workspaceId: workspace.workspaceId,
      };
    }

    return {
      success: false,
      message: `Unknown workspace action: ${action}`,
    };
  }, {
    accessToken: account.access_token,
    workspaceIdHint: options.workspaceId || account.quota_workspace_id || '',
    workspaceNameHint: options.workspaceName || account.quota_workspace_name || '',
    planTypeHint: options.planType || account.quota_plan_type || '',
    action,
    params,
  });

  if (options.page) {
    return execute(options.page);
  }

  return withWorkspacePage(execute);
}

async function listMembers(account, params = {}) {
  return runWorkspaceAction(account, 'list-members', params, {
    workspaceId: params.workspaceId || '',
    workspaceName: params.workspaceName || '',
    planType: params.planType || '',
    page: params.page,
  });
}

async function getMemberDetail(account, userId, options = {}) {
  return runWorkspaceAction(account, 'member-detail', { userId }, {
    workspaceId: options.workspaceId || '',
    workspaceName: options.workspaceName || '',
    planType: options.planType || '',
    page: options.page,
  });
}

async function updateMember(account, userId, params = {}, options = {}) {
  return runWorkspaceAction(account, 'update-member', { userId, ...params }, {
    workspaceId: options.workspaceId || params.workspaceId || '',
    workspaceName: options.workspaceName || params.workspaceName || '',
    planType: options.planType || params.planType || '',
    page: options.page,
  });
}

async function removeMember(account, userId, options = {}) {
  return runWorkspaceAction(account, 'remove-member', { userId }, {
    workspaceId: options.workspaceId || '',
    workspaceName: options.workspaceName || '',
    planType: options.planType || '',
    page: options.page,
  });
}

async function removeMembers(account, members = [], options = {}) {
  const normalizedMembers = (Array.isArray(members) ? members : [])
    .map((item, index) => ({
      clientIndex: Number.isFinite(Number(item?.clientIndex)) ? Number(item.clientIndex) : index,
      userId: String(item?.userId || item?.user_id || '').trim(),
      email: String(item?.email || '').trim(),
    }))
    .filter(item => item.userId);

  return runWorkspaceAction(account, 'remove-members', {
    members: normalizedMembers,
    concurrency: options.concurrency,
  }, {
    workspaceId: options.workspaceId || '',
    workspaceName: options.workspaceName || '',
    planType: options.planType || '',
    page: options.page,
  });
}

async function logoutMember(account, userId, options = {}) {
  return runWorkspaceAction(account, 'logout-member', { userId }, {
    workspaceId: options.workspaceId || '',
    workspaceName: options.workspaceName || '',
    planType: options.planType || '',
    page: options.page,
  });
}

async function revokePendingInvite(account, params = {}, options = {}) {
  return runWorkspaceAction(account, 'revoke-pending-invite', {
    email: params.email || '',
    remoteInviteId: params.remoteInviteId || '',
  }, {
    workspaceId: options.workspaceId || params.workspaceId || '',
    workspaceName: options.workspaceName || params.workspaceName || '',
    planType: options.planType || params.planType || '',
    page: options.page,
  });
}

module.exports = {
  withWorkspacePage,
  listMembers,
  getMemberDetail,
  updateMember,
  removeMember,
  removeMembers,
  logoutMember,
  revokePendingInvite,
};

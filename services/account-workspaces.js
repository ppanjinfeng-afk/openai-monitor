const { withBrowserPage } = require('./browser');

function withWorkspacePage(work) {
  return withBrowserPage(work);
}

async function fetchAccountWorkspaces(page, account) {
  return page.evaluate(async ({ accessToken, preferredWorkspaceId }) => {
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

    const getHeaders = extraHeaders => ({
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'OAI-Language': 'en-US',
      ...extraHeaders,
    });

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

    const response = await fetch(
      'https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27?server_time=true',
      { headers: getHeaders() }
    );
    const parsed = await parseResponse(response);

    if (!response.ok) {
      return {
        success: false,
        message: `获取工作区失败 (HTTP ${response.status}): ${extractErrorMessage(parsed.data, parsed.text, response.status)}`,
      };
    }

    const entries = Object.entries(parsed.data?.accounts || {});
    const mapWorkspace = ([accountId, details], index) => ({
      id: accountId,
      name: details?.account?.name || '',
      plan_type: details?.account?.plan_type || '',
      is_workspace: Boolean(details?.is_workspace),
      is_personal: Boolean(details?.is_personal),
      index,
    });

    const dedicated = entries
      .filter(([accountId, details]) => details?.is_workspace && isUuid(accountId))
      .map(mapWorkspace);
    const shared = entries
      .filter(([accountId, details]) => details?.is_personal === false && isUuid(accountId))
      .map(mapWorkspace);
    const planBased = entries
      .filter(([accountId, details]) => isUuid(accountId) && isWorkspacePlan(details?.account?.plan_type))
      .map(mapWorkspace);
    const workspaces = [...dedicated, ...shared, ...planBased]
      .filter((workspace, index, list) => list.findIndex(item => item.id === workspace.id) === index);

    if (workspaces.length === 0) {
      return {
        success: false,
        code: 'no_workspace_found',
        message: '未找到可用工作区',
      };
    }

    const selected = workspaces.find(workspace => workspace.id === preferredWorkspaceId) || workspaces[0];

    return {
      success: true,
      workspaces,
      default_workspace_id: selected.id,
      default_workspace_name: selected.name || '',
      default_plan_type: selected.plan_type || '',
    };
  }, {
    accessToken: account.access_token,
    preferredWorkspaceId: account.quota_workspace_id || '',
  });
}

async function listAccountWorkspaces(account, options = {}) {
  if (!account || !account.access_token) {
    return {
      success: false,
      message: '账号尚未授权',
    };
  }

  try {
    if (options.page) {
      return await fetchAccountWorkspaces(options.page, account);
    }
    return await withWorkspacePage(page => fetchAccountWorkspaces(page, account));
  } catch (err) {
    return {
      success: false,
      message: err.message,
    };
  }
}

module.exports = {
  listAccountWorkspaces,
  fetchAccountWorkspaces,
};

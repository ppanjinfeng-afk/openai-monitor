let puppeteer;
let StealthPlugin;

async function getPuppeteer() {
  if (!puppeteer) {
    puppeteer = require('puppeteer-extra');
    StealthPlugin = require('puppeteer-extra-plugin-stealth');
    puppeteer.use(StealthPlugin());
  }
  return puppeteer;
}

async function sendTeamInvite(account, targetEmail, options = {}) {
  const trimmedEmail = String(targetEmail || '').trim();
  if (!trimmedEmail) {
    return { success: false, message: 'Target email is required' };
  }

  if (!account.access_token) {
    return { success: false, message: 'Account is not authorized yet' };
  }

  let browser = null;

  try {
    const pptr = await getPuppeteer();
    browser = await pptr.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1280,800',
      ],
      defaultViewport: { width: 1280, height: 800 },
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    );

    console.log(`[Inviter] Opening chatgpt.com for ${account.email}...`);
    await page.goto('https://chatgpt.com/', {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });
    await new Promise(resolve => setTimeout(resolve, 3000));

    const result = await page.evaluate(async ({ accessToken, emailToInvite, forceResend, selectedWorkspaceId, selectedWorkspaceName, maxReservedSeats }) => {
      const DUPLICATE_HINTS = [
        'already invited',
        'already been invited',
        'already exists',
        'already pending',
        'already a member',
        'already sent',
        'duplicate',
      ];

      const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
      const isUuid = (value) => /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value);
      const normalizePlanType = (value) => String(value || '').trim().toLowerCase();
      const isWorkspacePlan = (value) => {
        const planType = normalizePlanType(value);
        if (!planType) {
          return false;
        }

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
      const normalizeEmail = (value) => String(value || '').trim().toLowerCase();

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

      const parseResponse = async (response) => {
        const text = await response.text();
        try {
          return { text, data: JSON.parse(text) };
        } catch {
          return { text, data: null };
        }
      };

      const stringifyValue = (value) => {
        if (value == null) {
          return '';
        }
        if (typeof value === 'string') {
          return value;
        }
        try {
          return JSON.stringify(value);
        } catch {
          return String(value);
        }
      };

      const extractErrorMessage = (payload) => {
        if (!payload) {
          return '';
        }

        const candidates = [
          payload.error_description,
          payload.message,
          payload.detail,
          payload.error && payload.error.message,
          payload.error,
          payload.details,
        ];

        for (const candidate of candidates) {
          const value = stringifyValue(candidate).trim();
          if (value) {
            return value;
          }
        }

        return '';
      };

      const extractErroredEmailMessage = (payload, emailAddress) => {
        const erroredEmails = Array.isArray(payload?.errored_emails) ? payload.errored_emails : [];

        for (const entry of erroredEmails) {
          if (typeof entry === 'string') {
            if (!emailAddress || normalizeEmail(entry) === normalizeEmail(emailAddress)) {
              return entry;
            }
            continue;
          }

          if (!entry || typeof entry !== 'object') {
            continue;
          }

          const entryEmail = entry.email_address || entry.email || entry.address || '';
          if (emailAddress && entryEmail && normalizeEmail(entryEmail) !== normalizeEmail(emailAddress)) {
            continue;
          }

          const message = extractErrorMessage(entry) || stringifyValue(entry);
          if (message) {
            return message;
          }
        }

        return '';
      };

      const listWorkspaces = async () => {
        const accountsRes = await fetch(
          'https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27?server_time=true',
          { headers: getHeaders(null) }
        );
        const parsed = await parseResponse(accountsRes);

        if (!accountsRes.ok) {
          return {
            error: `Failed to fetch workspaces (HTTP ${accountsRes.status}): ${extractErrorMessage(parsed.data) || parsed.text}`,
          };
        }

        const entries = Object.entries(parsed.data?.accounts || {});
        const mapWorkspace = ([accountId, details]) => ({
          id: accountId,
          name: details?.account?.name || '',
          planType: details?.account?.plan_type || '',
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
            error: `No workspace account id found in ${JSON.stringify(entries.map(([accountId]) => accountId))}`,
          };
        }

        return { workspaces };
      };

      const resolveWorkspace = async () => {
        const workspaceListResult = await listWorkspaces();
        if (workspaceListResult.error) {
          return workspaceListResult;
        }

        const requestedWorkspaceId = String(selectedWorkspaceId || '').trim();
        const workspace = requestedWorkspaceId
          ? workspaceListResult.workspaces.find(item => item.id === requestedWorkspaceId)
          : workspaceListResult.workspaces[0];

        if (!workspace) {
          return {
            error: `Selected workspace not found: ${requestedWorkspaceId}`,
          };
        }

        return {
          workspaceId: workspace.id,
          workspaceName: workspace.name || String(selectedWorkspaceName || '').trim(),
          planType: workspace.planType || '',
        };
      };

      const listInvites = async (workspaceId) => {
        const limit = 100;
        let offset = 0;
        let total = 0;
        const invites = [];

        while (true) {
          const listRes = await fetch(
            `https://chatgpt.com/backend-api/accounts/${workspaceId}/invites?limit=${limit}&offset=${offset}&query=`,
            { headers: getHeaders(workspaceId) }
          );
          const parsed = await parseResponse(listRes);

          if (!listRes.ok) {
            return {
              success: false,
              code: 'invite_lookup_failed',
              message: `Failed to list invites (HTTP ${listRes.status}): ${extractErrorMessage(parsed.data) || parsed.text || `HTTP ${listRes.status}`}`,
            };
          }

          const items = Array.isArray(parsed.data?.items) ? parsed.data.items : [];
          total = Number(parsed.data?.total || items.length || 0);
          invites.push(...items);

          offset += items.length;
          if (items.length === 0 || offset >= total) {
            break;
          }
        }

        return {
          success: true,
          items: invites,
          total,
        };
      };

      const listUsers = async (workspaceId) => {
        const limit = 100;
        let offset = 0;
        let total = 0;
        const users = [];

        while (true) {
          const usersRes = await fetch(
            `https://chatgpt.com/backend-api/accounts/${workspaceId}/users?limit=${limit}&offset=${offset}&query=`,
            { headers: getHeaders(workspaceId) }
          );
          const parsed = await parseResponse(usersRes);

          if (!usersRes.ok) {
            return {
              success: false,
              code: 'user_lookup_failed',
              message: `Failed to list users (HTTP ${usersRes.status}): ${extractErrorMessage(parsed.data) || parsed.text || `HTTP ${usersRes.status}`}`,
            };
          }

          const items = Array.isArray(parsed.data?.items) ? parsed.data.items : [];
          total = Number(parsed.data?.total || items.length || 0);
          users.push(...items);

          offset += items.length;
          if (items.length === 0 || offset >= total) {
            break;
          }
        }

        return {
          success: true,
          items: users,
          total,
        };
      };

      const checkInviteCapacity = async (workspaceId, maxReservedSeats) => {
        const inviteTotal = Number(maxReservedSeats || 0);
        if (!Number.isFinite(inviteTotal) || inviteTotal <= 0) {
          return { success: true, skipped: true };
        }

        const usersResult = await listUsers(workspaceId);
        if (!usersResult.success) {
          return usersResult;
        }

        const invitesResult = await listInvites(workspaceId);
        if (!invitesResult.success) {
          return invitesResult;
        }

        const memberSeats = usersResult.items.filter(item => item?.seat_type === 'default' && !item?.deactivated_time).length;
        const pendingInvites = Number(invitesResult.total || invitesResult.items.length || 0);
        const reservedSeats = memberSeats + pendingInvites;

        if (reservedSeats >= inviteTotal) {
          return {
            success: false,
            code: 'capacity_full',
            capacity: {
              memberSeats,
              pendingInvites,
              reservedSeats,
              inviteTotal,
              projectedRemainingSeats: inviteTotal - reservedSeats,
            },
            message: `Capacity full: members ${memberSeats} + pending invites ${pendingInvites} = reserved ${reservedSeats}/${inviteTotal}`,
          };
        }

        return {
          success: true,
          capacity: {
            memberSeats,
            pendingInvites,
            reservedSeats,
            inviteTotal,
            projectedRemainingSeats: inviteTotal - reservedSeats,
          },
        };
      };

      const findInviteByEmail = async (workspaceId, emailAddress) => {
        const listResult = await listInvites(workspaceId);
        if (!listResult.success) {
          return listResult;
        }

        const invite = listResult.items.find(item => normalizeEmail(item?.email_address) === normalizeEmail(emailAddress)) || null;
        return { success: true, invite };
      };

      const resendInviteById = async (workspaceId, inviteId) => {
        if (!inviteId) {
          return {
            success: false,
            code: 'invite_not_found',
            message: 'No remote invite id found to resend',
          };
        }

        const resendRes = await fetch(
          `https://chatgpt.com/backend-api/accounts/${workspaceId}/invites/${inviteId}`,
          {
            method: 'PATCH',
            headers: getHeaders(workspaceId, {
              'Content-Type': 'application/json',
            }),
            body: JSON.stringify({ resend: true }),
          }
        );
        const parsed = await parseResponse(resendRes);

        if (resendRes.ok && parsed.data?.success === true) {
          await sleep(1000);
          return { success: true };
        }

        return {
          success: false,
          code: 'resend_failed',
          message: `Failed to resend existing invite (HTTP ${resendRes.status}): ${extractErrorMessage(parsed.data) || parsed.text || `HTTP ${resendRes.status}`}`,
        };
      };

      const revokeInviteByEmail = async (workspaceId, emailAddress) => {
        const revokeRes = await fetch(
          `https://chatgpt.com/backend-api/accounts/${workspaceId}/invites`,
          {
            method: 'DELETE',
            headers: getHeaders(workspaceId, {
              'Content-Type': 'application/json',
            }),
            body: JSON.stringify({
              email_address: emailAddress,
            }),
          }
        );
        const parsed = await parseResponse(revokeRes);
        const message = extractErrorMessage(parsed.data) || parsed.text || `HTTP ${revokeRes.status}`;

        if (revokeRes.ok) {
          await sleep(1500);
          return { success: true, found: true };
        }

        if (revokeRes.status === 404 && message.toLowerCase().includes('invite not found')) {
          return { success: true, found: false };
        }

        return {
          success: false,
          code: 'revoke_failed',
          message: `Failed to revoke existing invite (HTTP ${revokeRes.status}): ${message}`,
        };
      };

      const createInvite = async (workspaceId) => {
        const inviteRes = await fetch(`https://chatgpt.com/backend-api/accounts/${workspaceId}/invites`, {
          method: 'POST',
          headers: getHeaders(workspaceId, {
            'Content-Type': 'application/json',
          }),
          body: JSON.stringify({
            email_addresses: [emailToInvite],
            role: 'standard-user',
          }),
        });
        const parsed = await parseResponse(inviteRes);

        const message = extractErrorMessage(parsed.data) || parsed.text || `HTTP ${inviteRes.status}`;
        const lowerMessage = message.toLowerCase();

        if (!inviteRes.ok) {
          return {
            success: false,
            code: 'create_failed',
            isDuplicate:
              inviteRes.status === 409 ||
              inviteRes.status === 422 ||
              DUPLICATE_HINTS.some(hint => lowerMessage.includes(hint)),
            message: `Failed to create invite (HTTP ${inviteRes.status}): ${message}`,
          };
        }

        const accountInvites = Array.isArray(parsed.data?.account_invites) ? parsed.data.account_invites : [];
        const matchingInvite = accountInvites.find(item => normalizeEmail(item?.email_address) === normalizeEmail(emailToInvite)) || null;

        if (matchingInvite) {
          return {
            success: true,
            createdNewInvite: true,
            invite: matchingInvite,
          };
        }

        const remoteInviteResult = await findInviteByEmail(workspaceId, emailToInvite);
        if (!remoteInviteResult.success) {
          return remoteInviteResult;
        }

        if (remoteInviteResult.invite) {
          return {
            success: true,
            createdNewInvite: true,
            invite: remoteInviteResult.invite,
          };
        }

        const erroredEmailMessage = extractErroredEmailMessage(parsed.data, emailToInvite);
        if (erroredEmailMessage) {
          return {
            success: false,
            code: 'create_failed',
            message: `Failed to create invite: ${erroredEmailMessage}`,
          };
        }

        return {
          success: false,
          code: 'invite_not_materialized',
          message: `OpenAI accepted the invite request but did not create a pending invite for ${emailToInvite}`,
        };
      };

      const workspaceResult = await resolveWorkspace();
      if (workspaceResult.error) {
        return { success: false, code: 'workspace_lookup_failed', message: workspaceResult.error };
      }

      const { workspaceId, workspaceName, planType } = workspaceResult;
      const existingInviteResult = await findInviteByEmail(workspaceId, emailToInvite);
      if (!existingInviteResult.success) {
        return existingInviteResult;
      }

      if (!existingInviteResult.invite) {
        const capacityResult = await checkInviteCapacity(workspaceId, maxReservedSeats);
        if (!capacityResult.success) {
          return {
            ...capacityResult,
            workspaceId,
            workspaceName,
            planType,
          };
        }
      }

      if (forceResend && existingInviteResult.invite) {
        const resendResult = await resendInviteById(workspaceId, existingInviteResult.invite.id);
        if (!resendResult.success) {
          return resendResult;
        }

        return {
          success: true,
          wasResend: true,
          createdNewInvite: false,
          remoteInviteId: existingInviteResult.invite.id,
          workspaceId,
          workspaceName,
          planType,
          message: `Invite resent successfully to ${emailToInvite}`,
        };
      }

      let createResult = await createInvite(workspaceId);

      if (!createResult.success && createResult.isDuplicate) {
        const duplicateInviteResult = await findInviteByEmail(workspaceId, emailToInvite);
        if (!duplicateInviteResult.success) {
          return duplicateInviteResult;
        }

        if (duplicateInviteResult.invite) {
          if (forceResend) {
            const resendResult = await resendInviteById(workspaceId, duplicateInviteResult.invite.id);
            if (!resendResult.success) {
              return resendResult;
            }

            return {
              success: true,
              wasResend: true,
              createdNewInvite: false,
              remoteInviteId: duplicateInviteResult.invite.id,
              workspaceId,
              workspaceName,
              planType,
              message: `Invite resent successfully to ${emailToInvite}`,
            };
          }

          return {
            success: true,
            wasResend: false,
            createdNewInvite: false,
            remoteInviteId: duplicateInviteResult.invite.id,
            workspaceId,
            workspaceName,
            planType,
            message: `Invite already pending for ${emailToInvite}`,
          };
        }

        const revokeResult = await revokeInviteByEmail(workspaceId, emailToInvite);
        if (!revokeResult.success) {
          return revokeResult;
        }

        if (revokeResult.found) {
          createResult = await createInvite(workspaceId);
        }
      }

      if (!createResult.success) {
        return createResult;
      }

      return {
        success: true,
        wasResend: forceResend,
        createdNewInvite: Boolean(createResult.createdNewInvite),
        remoteInviteId: createResult.invite?.id || null,
        workspaceId,
        workspaceName,
        planType,
        message: forceResend
          ? `Invite resent successfully to ${emailToInvite}`
          : `Invite sent successfully to ${emailToInvite}`,
      };
    }, {
      accessToken: account.access_token,
      emailToInvite: trimmedEmail,
      forceResend: Boolean(options.forceResend),
      selectedWorkspaceId: options.workspaceId || '',
      selectedWorkspaceName: options.workspaceName || '',
      maxReservedSeats: Number(options.maxReservedSeats || account.invite_total || 0),
    });

    return result;
  } catch (err) {
    console.error(`[Inviter] Error sending invite to ${trimmedEmail}:`, err);
    return { success: false, message: `Browser script failed: ${err.message}` };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

module.exports = {
  getPuppeteer,
  sendTeamInvite,
};

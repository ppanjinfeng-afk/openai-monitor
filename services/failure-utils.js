function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function classifyFailure(message, status = '') {
  const text = normalizeText(message);
  const normalizedStatus = normalizeText(status);

  if (!text && !normalizedStatus) {
    return 'unknown';
  }

  if (text.includes('cooldown')) return 'cooldown';
  if (text.includes('invalid email')) return 'invalid_email';
  if (text.includes('not authorized') || text.includes('oauth') || text.includes('尚未授权')) return 'oauth_missing';
  if (text.includes('token') && (text.includes('expired') || text.includes('invalid'))) return 'token_invalid';
  if (text.includes('invalid credentials') || normalizedStatus === 'invalid_credentials') return 'invalid_credentials';
  if (text.includes('rate limit') || normalizedStatus === 'rate_limited') return 'rate_limited';
  if (text.includes('invite_degraded') || text.includes('邀请假成功')) return 'invite_degraded';
  if (text.includes('invite_not_materialized') || text.includes('did not create a pending invite')) return 'invite_not_materialized';
  if (text.includes('already invited') || text.includes('already pending') || text.includes('duplicate')) return 'duplicate_invite';
  if (text.includes('workspace') && text.includes('not found')) return 'workspace_lookup_failed';
  if (text.includes('http 404')) return 'upstream_404';
  if (text.includes('http 50') || text.includes('http 5')) return 'upstream_5xx';
  if (text.includes('revoke existing invite')) return 'revoke_failed';
  if (text.includes('resend existing invite')) return 'resend_failed';
  if (text.includes('quota') || text.includes('满员') || text.includes('剩余 0')) return 'quota_full';
  if (normalizedStatus === 'error') return 'generic_error';

  return 'unknown';
}

function categoryLabel(category) {
  const labels = {
    cooldown: '冷却中',
    invalid_email: '邮箱格式错误',
    oauth_missing: '未授权',
    token_invalid: '令牌失效',
    invalid_credentials: '凭证无效',
    rate_limited: '限流',
    invite_degraded: '邀请能力异常',
    invite_not_materialized: '假成功未落地',
    duplicate_invite: '重复邀请',
    workspace_lookup_failed: '工作区解析失败',
    upstream_404: '上游 404',
    upstream_5xx: '上游 5xx',
    revoke_failed: '撤销失败',
    resend_failed: '补发失败',
    quota_full: '名额不足',
    generic_error: '通用错误',
    unknown: '未知',
  };

  return labels[category] || category || '未知';
}

module.exports = {
  classifyFailure,
  categoryLabel,
};

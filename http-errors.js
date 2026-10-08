function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function wrapAsyncRoutes(router) {
  const wrap = handler => {
    if (Array.isArray(handler)) return handler.map(wrap);
    if (typeof handler !== 'function') return handler;
    return (req, res, next) => {
      try {
        return Promise.resolve(handler(req, res, next)).catch(next);
      } catch (error) {
        return next(error);
      }
    };
  };

  for (const method of ['get', 'post', 'put', 'patch', 'delete', 'all']) {
    if (typeof router[method] !== 'function') continue;
    const register = router[method].bind(router);
    router[method] = (...args) => register(...args.map(wrap));
  }
}

function logRequestEvent(req, event, level = 'error') {
  logCompanyEvent(req?.companyTenantId ?? null, event, level);
}

function logCompanyEvent(companyId, event, level = 'error') {
  const entry = JSON.stringify({ event, company_id: companyId ?? null });
  (level === 'warn' ? console.warn : console.error)(entry);
}

function sendInternalError(res, error, context) {
  // TEMPORARY DEBUG: remove debug_* fields once the cause is found.
  console.error(JSON.stringify({
    event: String(context || 'request_failed').slice(0, 100),
    company_id: res.locals?.company_id ?? null,
    debug_message: String(error?.message || '').slice(0, 300),
    debug_code: error?.code || null,
    debug_cause: String(error?.cause?.message || '').slice(0, 300),
    debug_at: String(error?.stack || '').split('\n')[1]?.trim() || null
  }));
  Promise.resolve(res.locals?.reportUserError?.(context || 'request_failed', 500, error)).catch(() => {});
  if (res.headersSent) return;
  return res.status(500).json({ error: 'Internal server error.' });
}

module.exports = { asyncHandler, logCompanyEvent, logRequestEvent, sendInternalError, wrapAsyncRoutes };

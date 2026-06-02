export function formatErrorResponse(error: any) {
  if (error._providerError) {
    // _errorBody may be { "error": { "message": "...", ... } } or { "message": "..." }
    const body = error._errorBody || {}
    const inner = body.error || body
    return {
      error: {
        message: inner.message || body.message || 'Provider error',
        type: inner.type || 'provider_error',
        code: inner.code || null
      },
      source: error._source || 'provider'
    }
  }
  return {
    error: { message: error.message || 'Internal server error' },
    source: error._source || 'gateway'
  }
}

export function throwFormattedError(error: any): never {
  const resp = formatErrorResponse(error)
  throw createError({ statusCode: resp.error?.status_code || 500, data: resp })
}

export function formatErrorResponse(error: any) {
  if (error._providerError) {
    return {
      error: error._errorBody,
      status_code: error._statusCode,
      source: error._source
    }
  }
  return {
    error: { message: error.message || 'Internal server error' },
    status_code: error.statusCode || error._statusCode || 500,
    source: error._source || 'gateway'
  }
}

export function throwFormattedError(error: any): never {
  const resp = formatErrorResponse(error)
  throw createError({ statusCode: resp.status_code, data: resp })
}

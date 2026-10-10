import { createError, defineEventHandler, getQuery } from 'h3'
import { getPluginManager } from '../../../../plugins-runtime'
import { getPluginMarket, PluginMarketError, type MarketSort } from '../../../../plugins-runtime/market'
import { getAuthStore } from '../../../../stores/auth.store'

export default defineEventHandler(async event => {
  const query = getQuery(event)
  try {
    if (['query', 'page', 'pageSize', 'sort'].some(key => Array.isArray(query[key]))) {
      throw new PluginMarketError('INVALID_SEARCH', 'Market query parameters must not be repeated', 400)
    }
    return await getPluginMarket({ manager: getPluginManager(), getSSRFConfig: () => getAuthStore().getSSRFConfig() }).search({
      query: query.query === undefined ? '' : query.query as string,
      page: query.page === undefined ? 1 : Number(query.page),
      pageSize: query.pageSize === undefined ? 20 : Number(query.pageSize),
      sort: query.sort === undefined ? 'relevance' : query.sort as MarketSort
    })
  } catch (error) {
    if (error instanceof PluginMarketError) throw createError({ statusCode: error.statusCode, message: error.message, data: { code: error.code } })
    throw error
  }
})

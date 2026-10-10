import { defineEventHandler } from 'h3'
import { getPluginManager } from '../../../plugins-runtime'

export default defineEventHandler(() => getPluginManager().getMetrics())

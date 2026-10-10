import { getPluginManager } from '../../../plugins-runtime'

export default defineEventHandler(() => getPluginManager().list())

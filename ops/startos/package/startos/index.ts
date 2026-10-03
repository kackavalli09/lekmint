import { buildManifest, IMPOSSIBLE, VersionGraph, VersionInfo } from '@start9labs/start-sdk'
import { sdk } from './sdk'
import { manifest as sdkManifest } from './manifest'

export { main } from './main'
export const actions = sdk.Actions.of()
const versionGraph = VersionGraph.of({
  current: VersionInfo.of<'1.1.1:0'>({
    version: '1.1.1:0',
    releaseNotes: 'Isolated standby-only package candidate. Not approved for real funds.',
    migrations: { up: async () => {}, down: IMPOSSIBLE },
  }),
  other: [],
})
export const manifest = buildManifest(versionGraph, sdkManifest)
export const init = sdk.setupInit(
  async (_effects, kind) => {
    if (kind === 'restore') throw new Error('Native restore disabled: use reviewed isolated logical restore.')
  },
  versionGraph,
  sdk.setupInterfaces(async () => []),
  sdk.setupDependencies(async () => ({})),
  actions,
)
export const uninit = sdk.setupUninit(versionGraph)
export const createBackup = async () => {
  throw new Error('Native backup disabled: live raw PostgreSQL files are not a consistent backup. Use reviewed logical encrypted backups.')
}
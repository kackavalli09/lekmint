import { sdk } from './sdk'

export const main = sdk.setupMain(async ({ effects }) => {
  const postgres = sdk.SubContainer.of(
    effects, { imageId: 'postgres' },
    sdk.Mounts.of()
      .mountVolume({ volumeId: 'postgres', subpath: null, mountpoint: '/var/lib/postgresql/data', readonly: false })
      .mountVolume({ volumeId: 'config', subpath: null, mountpoint: '/run/lek-config', readonly: true }),
    'postgres',
  )
  const api = sdk.SubContainer.of(
    effects, { imageId: 'api' },
    sdk.Mounts.of().mountVolume({
      volumeId: 'config', subpath: null, mountpoint: '/run/lek-config', readonly: true,
    }),
    'api',
  )
  return sdk.Daemons.of(effects)
    .addDaemon('postgres', {
      subcontainer: postgres,
      exec: {
        command: sdk.useEntrypoint(),
        runAsInit: true,
        sigtermTimeout: 120_000,
      },
      ready: {
        display: 'PostgreSQL authenticated probe',
        fn: () => sdk.healthCheck.runHealthScript(
          ['/bin/sh', '/usr/local/bin/lek-postgres-healthcheck'], postgres,
          { timeout: 5000, errorMessage: 'Test database or protected probe credentials are not ready.' },
        ),
      },
      requires: [],
    })
    .addDaemon('api', {
      subcontainer: api,
      exec: {
        command: sdk.useEntrypoint(),
        runAsInit: true,
        sigtermTimeout: 120_000,
        env: {
          MINT_OPERATION_MODE: 'standby',
          MINT_RELEASE_ID: 'lek-mint-lab-1.1.1',
          DATABASE_URL_FILE: '/run/lek-config/DATABASE_URL',
          SESSION_SECRET_FILE: '/run/lek-config/SESSION_SECRET',
          ADMIN_API_KEY_FILE: '/run/lek-config/ADMIN_API_KEY',
          TRUST_PROXY: '0',
        },
      },
      ready: {
        display: 'API liveness only — transactions remain disabled',
        fn: () => sdk.healthCheck.runHealthScript(
          ['node', '/app/healthcheck.mjs', 'live'], api,
          { timeout: 5000, errorMessage: 'Standby API is not running.' },
        ),
      },
      requires: ['postgres'],
    })
})
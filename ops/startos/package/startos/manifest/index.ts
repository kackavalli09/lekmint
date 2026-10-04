import { setupManifest } from '@start9labs/start-sdk'

export const manifest = setupManifest({
  id: 'lek-mint-lab',
  title: 'Lek Mint — Isolated Test',
  license: 'MIT',
  packageRepo: 'https://github.com/kackavalli09/lekmint',
  upstreamRepo: 'https://github.com/kackavalli09/lekmint',
  marketingUrl: 'https://github.com/kackavalli09/lekmint',
  donationUrl: null,
  description: {
    short: 'Real Lek Mint API and PostgreSQL, fenced for isolated testing.',
    long: 'Build candidate only. Standby is enforced. No public interfaces, automatic database initialization, activation action, or native backups. Never load production credentials or ledger data into this test package.',
  },
  volumes: ['postgres', 'config'],
  images: {
    api: {
      source: { dockerBuild: { workdir: '../../..', dockerfile: '../Dockerfile.api' } },
      arch: ['x86_64'],
    },
    postgres: {
      source: { dockerBuild: { workdir: '../../..', dockerfile: '../Dockerfile.postgres' } },
      arch: ['x86_64'],
    },
  },
  dependencies: {},
})
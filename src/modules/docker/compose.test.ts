import assert from 'node:assert/strict'
import test from 'node:test'
import { InternalError } from '@jib/errors'
import { dockerCreateCompose } from './compose.ts'

void test('resolved config uses all Compose files and the managed env file without persisting output', async () => {
  const calls: string[][] = []
  const compose = dockerCreateCompose({
    app: 'blog',
    dir: '/blog',
    files: ['compose.yml', 'prod.yml'],
    envFile: '/secrets/blog/.env',
    exec: async (args, opts) => {
      calls.push(args)
      assert.equal(opts.capture, true)
      assert.equal(opts.cwd, '/blog')
      return {
        exitCode: 0,
        stdout: JSON.stringify({ services: { web: { environment: { TOKEN: 'secret' } } } }),
        stderr: '',
      }
    },
  })
  assert.deepEqual(await compose.resolvedConfig(), {
    services: { web: { environment: { TOKEN: 'secret' } } },
  })
  assert.deepEqual(calls[0], [
    'docker',
    'compose',
    '-p',
    'jib-blog',
    '-f',
    'compose.yml',
    '-f',
    'prod.yml',
    '--env-file',
    '/secrets/blog/.env',
    'config',
    '--format',
    'json',
  ])
})

void test('resolved config returns typed errors for Docker failures and malformed models', async () => {
  for (const [exitCode, stdout] of [
    [1, ''],
    [0, 'invalid'],
    [0, '[]'],
    [0, 'null'],
  ] as const) {
    const compose = dockerCreateCompose({
      app: 'blog',
      dir: '/blog',
      files: [],
      exec: async () => ({ exitCode, stdout, stderr: 'failure' }),
    })
    assert((await compose.resolvedConfig()) instanceof InternalError)
  }
})

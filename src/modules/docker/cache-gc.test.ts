import assert from 'node:assert/strict'
import { chmod, lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { dockerBuildCacheTarget, dockerConfigureBuildCacheResult } from './cache-gc.ts'

async function withDaemonConfig(raw: string | undefined, run: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'jib-docker-gc-'))
  const path = join(dir, 'daemon.json')
  try {
    if (raw !== undefined) {
      await writeFile(path, raw)
    }
    await run(path)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const dockerDisk = {
  dockerRootDir: async () => '/mnt/docker-data',
  filesystem: async (path: string) => {
    assert.equal(path, '/mnt/docker-data')
    return { blocks: 100_000_000, bsize: 1_000 } // 100 GB
  },
}

void test('sizes Docker build cache against total Docker filesystem capacity', () => {
  assert.equal(dockerBuildCacheTarget(2_000_000_000), '200MB')
  assert.equal(dockerBuildCacheTarget(40_000_000_000), '4GB')
  assert.equal(dockerBuildCacheTarget(200_000_000_000), '20GB')
  assert.equal(dockerBuildCacheTarget(1_000_000_000_000), '20GB')
  assert.ok(dockerBuildCacheTarget(Number.NaN) instanceof Error)
  assert.ok(dockerBuildCacheTarget(0) instanceof Error)
})

void test('merges GC target into existing daemon config without changing other settings or permissions', async () => {
  await withDaemonConfig(
    '{"log-driver":"journald","builder":{"gc":{"enabled":true}}}\n',
    async (path) => {
      await chmod(path, 0o600)
      assert.equal(
        await dockerConfigureBuildCacheResult({ ...dockerDisk, daemonConfigPath: path }),
        '10GB',
      )
      assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
        'log-driver': 'journald',
        builder: { gc: { enabled: true, defaultKeepStorage: '10GB' } },
      })
      assert.equal((await stat(path)).mode & 0o777, 0o600)
      const content = await readFile(path, 'utf8')
      assert.equal(
        await dockerConfigureBuildCacheResult({
          daemonConfigPath: path,
          dockerRootDir: async () => {
            throw new Error('should not query Docker again')
          },
        }),
        undefined,
      )
      assert.equal(await readFile(path, 'utf8'), content)
    },
  )
})

void test('creates daemon config when absent', async () => {
  await withDaemonConfig(undefined, async (path) => {
    assert.equal(
      await dockerConfigureBuildCacheResult({ ...dockerDisk, daemonConfigPath: path }),
      '10GB',
    )
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
      builder: { gc: { enabled: true, defaultKeepStorage: '10GB' } },
    })
  })
})

void test('respects explicit administrator GC targets, disabled GC, and custom policies', async () => {
  for (const gc of [
    { enabled: true, defaultKeepStorage: '3GB' },
    { enabled: false },
    { policy: [{ keepStorage: '2GB', all: true }] },
  ]) {
    const original = JSON.stringify({ builder: { gc }, 'live-restore': true })
    await withDaemonConfig(original, async (path) => {
      assert.equal(
        await dockerConfigureBuildCacheResult({
          daemonConfigPath: path,
          dockerRootDir: async () => {
            throw new Error('should not query Docker for an explicit policy')
          },
        }),
        undefined,
      )
      assert.equal(await readFile(path, 'utf8'), original)
    })
  }
})

void test('does not overwrite invalid daemon config or write when disk detection fails', async () => {
  for (const raw of [
    '{broken',
    '[]',
    '{"builder":null}',
    '{"builder":42}',
    '{"builder":{"gc":null}}',
    '{"builder":{"gc":42}}',
    '{"builder":{"gc":{"enabled":42}}}',
  ]) {
    await withDaemonConfig(raw, async (path) => {
      assert.ok(
        (await dockerConfigureBuildCacheResult({
          ...dockerDisk,
          daemonConfigPath: path,
        })) instanceof Error,
      )
      assert.equal(await readFile(path, 'utf8'), raw)
    })
  }
  await withDaemonConfig('{}', async (path) => {
    const result = await dockerConfigureBuildCacheResult({
      daemonConfigPath: path,
      dockerRootDir: async () => '/missing-docker-root',
      filesystem: async () => {
        throw new Error('disk unavailable')
      },
    })
    assert.ok(result instanceof Error)
    assert.equal(await readFile(path, 'utf8'), '{}')
  })
})

void test('does not replace an administrator-managed daemon config symlink', async () => {
  await withDaemonConfig(undefined, async (path) => {
    await symlink('managed-daemon.json', path)
    assert.ok(
      (await dockerConfigureBuildCacheResult({ ...dockerDisk, daemonConfigPath: path })) instanceof
        Error,
    )
    assert.equal((await lstat(path)).isSymbolicLink(), true)
  })
})

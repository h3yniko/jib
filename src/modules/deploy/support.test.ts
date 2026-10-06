import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AppSchema } from '@jib/config'
import { pathsGetPaths } from '@jib/paths'
import { deployLinkSecrets, deploySyncOverride } from './support.ts'

void test('override preparation propagates filesystem failures', async (testCtx) => {
  const root = await mkdtemp(join(tmpdir(), 'jib-prepare-'))
  testCtx.after(() => rm(root, { recursive: true, force: true }))
  const paths = pathsGetPaths(root)
  await writeFile(join(root, 'compose.yml'), 'services:\n  web:\n    image: nginx\n')
  await writeFile(paths.overridesDir, 'blocks mkdir')
  assert(
    (await deploySyncOverride(
      paths,
      'blog',
      AppSchema.parse({ repo: 'local', compose: ['compose.yml'] }),
      root,
    )) instanceof Error,
  )
})

void test('removed managed env deletes only its owned link and preserves local env', async (testCtx) => {
  const root = await mkdtemp(join(tmpdir(), 'jib-env-'))
  testCtx.after(() => rm(root, { recursive: true, force: true }))
  const paths = pathsGetPaths(root)
  const managed = join(paths.secretsDir, 'blog', '.env')
  const local = join(root, '.env')
  await mkdir(join(paths.secretsDir, 'blog'), { recursive: true })
  await writeFile(managed, 'URL=first\n')
  assert.equal(await deployLinkSecrets(paths, 'blog', root), undefined)
  assert.equal(await readFile(local, 'utf8'), 'URL=first\n')
  await rm(managed)
  assert.equal(await deployLinkSecrets(paths, 'blog', root), undefined)
  await assert.rejects(readFile(local), { code: 'ENOENT' })
  await writeFile(local, 'LOCAL=keep\n')
  assert.equal(await deployLinkSecrets(paths, 'blog', root), undefined)
  assert.equal(await readFile(local, 'utf8'), 'LOCAL=keep\n')
  await rm(local)
  await writeFile(join(root, 'custom.env'), 'CUSTOM=keep\n')
  await symlink(join(root, 'custom.env'), local)
  assert.equal(await deployLinkSecrets(paths, 'blog', root), undefined)
  assert.equal(await readFile(local, 'utf8'), 'CUSTOM=keep\n')
})

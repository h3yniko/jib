import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { ConfigSchema } from '@jib/config'
import { dockerCreateCompose } from '@jib/docker'
import { InternalError, ValidationError } from '@jib/errors'
import { ingressClaim } from '@jib/ingress'
import { pathsGetPaths } from '@jib/paths'
import { stateEmpty, stateLoad, stateSave } from '@jib/state'
import { ingressApplyNginxConfig } from '@/modules/ingress/backends/nginx/config.ts'
import { ingressCreateNginxOperator } from '@/modules/ingress/backends/nginx/operator.ts'
import { reconcileApp } from './app.ts'
import { reconcileDesiredState } from './desired.ts'

async function fixture(testCtx: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'jib-reconcile-'))
  testCtx.after(() => rm(root, { recursive: true, force: true }))
  const ctx = {
    cfg: ConfigSchema.parse({
      config_version: 3,
      apps: {
        blog: {
          repo: 'local',
          domains: [{ host: 'hexnickk.sh', port: 8080 }],
        },
      },
    }),
    paths: pathsGetPaths(root),
  }
  const model = { services: { web: { image: 'blog', environment: { URL: 'hexnickk.sh' } } } }
  const calls: string[][] = []
  const loadedRoutes: string[][] = []
  let nginxFails = false
  let upFails = false
  let buildFails = false
  let healthFails = false
  const exec = async (args: string[]) => {
    calls.push(args)
    if (args.includes('reload')) {
      const routes = await nginxIncludedRoutes(ctx.paths.nginxDir)
      loadedRoutes.push(routes)
    }
    return { ok: !nginxFails, stdout: '', stderr: nginxFails ? 'invalid nginx config' : '' }
  }
  const compose = dockerCreateCompose({
    app: 'blog',
    dir: root,
    files: ['compose.yml'],
    exec: async (args) => {
      calls.push(args)
      const failure = (args.includes('up') && upFails) || (args.includes('build') && buildFails)
      return {
        exitCode: failure ? 1 : 0,
        stdout: JSON.stringify(model),
        stderr: failure ? 'failed' : '',
      }
    },
  })
  const deps = {
    syncOverride: async () => undefined,
    linkSecrets: async () => undefined,
    composeFor: () => compose,
    load: stateLoad,
    save: stateSave,
    checkHealth: async () => [{ endpoint: 'http://127.0.0.1:8080/', ok: !healthFails }],
    acquireLock: async () => async () => {},
    applyGlobal: (paths: typeof ctx.paths, cfg: typeof ctx.cfg) =>
      ingressApplyNginxConfig(paths, cfg, exec),
    createOperator: () =>
      ingressCreateNginxOperator({
        nginxDir: ctx.paths.nginxDir,
        exec,
        certExists: async () => false,
      }),
    claim: ingressClaim,
  }
  const run = (rebuild = false) => reconcileApp(ctx, { app: 'blog', workdir: root, rebuild }, deps)
  const load = async () => {
    const state = await stateLoad(ctx.paths.stateDir, 'blog')
    assert(!(state instanceof Error))
    return state
  }
  return {
    ctx,
    model,
    calls,
    loadedRoutes,
    deps,
    run,
    load,
    failNginx: (value: boolean) => {
      nginxFails = value
    },
    failUp: () => {
      upFails = true
    },
    failBuild: () => {
      buildFails = true
    },
    failHealth: () => {
      healthFails = true
    },
  }
}

void test('restart replaces domains, removes old routes, and records derived state', async (testCtx) => {
  const fixtureData = await fixture(testCtx)
  assert.equal(await fixtureData.run(), undefined)
  const before = await fixtureData.load()
  fixtureData.ctx.cfg.apps.blog!.domains[0]!.host = 'niko.page'
  assert.equal(await fixtureData.run(), undefined)
  assert.deepEqual(await readdir(join(fixtureData.ctx.paths.nginxDir, 'blog')), ['niko.page.conf'])
  assert.deepEqual(fixtureData.loadedRoutes.at(-1), ['niko.page.conf'])
  const after = await fixtureData.load()
  assert.notEqual(after.applied.ingress, before.applied.ingress)
  assert.equal(after.applied.runtime, before.applied.runtime)
  assert.match(
    await readFile(join(fixtureData.ctx.paths.nginxDir, 'blog/niko.page.conf'), 'utf8'),
    /server_name niko.page;/,
  )
  fixtureData.ctx.cfg.apps.blog!.domains = []
  assert.equal(await fixtureData.run(), undefined)
  await assert.rejects(readFile(join(fixtureData.ctx.paths.nginxDir, 'blog/niko.page.conf')), {
    code: 'ENOENT',
  })
  assert.deepEqual(fixtureData.loadedRoutes.at(-1), [])
})

void test('unchanged routes avoid reloads while externally edited or missing artifacts are repaired', async (testCtx) => {
  const fixtureData = await fixture(testCtx)
  assert.equal(await fixtureData.run(), undefined)
  fixtureData.calls.length = 0
  assert.equal(await fixtureData.run(), undefined)
  assert.equal(fixtureData.calls.filter((args) => args.includes('sudo')).length, 0)
  const path = join(fixtureData.ctx.paths.nginxDir, 'blog/hexnickk.sh.conf')
  await writeFile(path, 'manual drift')
  assert.equal(await fixtureData.run(), undefined)
  assert.match(await readFile(path, 'utf8'), /server_name hexnickk.sh;/)
  await rm(path)
  assert.equal(await fixtureData.run(), undefined)
  await writeFile(join(fixtureData.ctx.paths.nginxDir, 'blog/obsolete.conf'), 'obsolete')
  assert.equal(await fixtureData.run(), undefined)
  assert.deepEqual(await readdir(join(fixtureData.ctx.paths.nginxDir, 'blog')), [
    'hexnickk.sh.conf',
  ])
})

void test('failed ingress preserves old files and applied ingress while recording runtime; retry converges', async (testCtx) => {
  const fixtureData = await fixture(testCtx)
  assert.equal(await fixtureData.run(), undefined)
  const before = await fixtureData.load()
  fixtureData.ctx.cfg.apps.blog!.domains[0]!.host = 'niko.page'
  fixtureData.model.services.web.environment.URL = 'niko.page'
  fixtureData.failNginx(true)
  assert((await fixtureData.run()) instanceof InternalError)
  const partial = await fixtureData.load()
  assert.equal(partial.applied.ingress, before.applied.ingress)
  assert.notEqual(partial.applied.runtime, before.applied.runtime)
  assert.deepEqual(await readdir(join(fixtureData.ctx.paths.nginxDir, 'blog')), [
    'hexnickk.sh.conf',
  ])
  fixtureData.failNginx(false)
  assert.equal(await fixtureData.run(), undefined)
  assert.deepEqual(await readdir(join(fixtureData.ctx.paths.nginxDir, 'blog')), ['niko.page.conf'])
})

void test('build input changes stay pending after restart and clear only after successful rebuild', async (testCtx) => {
  const fixtureData = await fixture(testCtx)
  const model = fixtureData.model as Record<string, unknown>
  model.services = {
    web: { image: 'blog', build: { context: '/blog', args: { URL: 'hexnickk.sh' } } },
  }
  assert((await fixtureData.run()) instanceof ValidationError)
  assert.equal((await fixtureData.load()).applied.build, undefined)
  assert.equal(await fixtureData.run(true), undefined)
  const before = await fixtureData.load()
  model.services = {
    web: { image: 'blog', build: { context: '/blog', args: { URL: 'niko.page' } } },
  }
  assert((await fixtureData.run()) instanceof ValidationError)
  assert.equal((await fixtureData.load()).applied.build, before.applied.build)
  assert.equal(await fixtureData.run(true), undefined)
  assert.notEqual((await fixtureData.load()).applied.build, before.applied.build)
  assert.equal(await fixtureData.run(), undefined)
})

void test('container, health, build, and state failures do not mark failed stages applied', async (testCtx) => {
  const fixtureData = await fixture(testCtx)
  fixtureData.failUp()
  assert((await fixtureData.run()) instanceof InternalError)
  assert.deepEqual((await fixtureData.load()).applied, {})
  const health = await fixture(testCtx)
  health.ctx.cfg.apps.blog!.health = [{ port: 8080, path: '/' }]
  health.failHealth()
  assert((await health.run()) instanceof InternalError)
  assert.deepEqual((await health.load()).applied, {})
  const build = await fixture(testCtx)
  ;(build.model as Record<string, unknown>).services = { web: { build: { context: '/blog' } } }
  build.failBuild()
  assert((await build.run(true)) instanceof InternalError)
  assert.deepEqual((await build.load()).applied, {})
  const save = await fixture(testCtx)
  save.deps.save = async () => new InternalError('state write failed')
  assert((await save.run()) instanceof InternalError)
  assert.deepEqual((await save.load()).applied, {})
  assert.equal(
    save.calls.some((args) => args.includes('sudo')),
    false,
  )
})

void test('global config changes reconcile and restore previous contents on validation failure', async (testCtx) => {
  const fixtureData = await fixture(testCtx)
  assert.equal(await fixtureData.run(), undefined)
  const path = join(fixtureData.ctx.paths.nginxDir, '00-jib-ingress.conf')
  const previous = await readFile(path, 'utf8')
  fixtureData.ctx.cfg.ingress = { max_body_size: '20m' }
  fixtureData.failNginx(true)
  assert((await fixtureData.run()) instanceof InternalError)
  assert.equal(await readFile(path, 'utf8'), previous)
  fixtureData.failNginx(false)
  assert.equal(await fixtureData.run(), undefined)
  assert.match(await readFile(path, 'utf8'), /client_max_body_size 20m;/)
})

void test('desired state is deterministic and keeps runtime env separate from build args', () => {
  const cfg = ConfigSchema.parse({ config_version: 3, apps: { blog: { repo: 'local' } } })
  const app = cfg.apps.blog!
  const first = reconcileDesiredState({ cfg }, 'blog', app, {
    services: {
      web: {
        image: 'blog',
        environment: { A: 'secret' },
        build: { args: { URL: 'one' }, context: '/blog' },
      },
    },
  })
  const second = reconcileDesiredState({ cfg }, 'blog', app, {
    services: {
      web: {
        build: { context: '/blog', args: { URL: 'one' } },
        environment: { A: 'changed' },
        image: 'blog',
      },
    },
  })
  assert(!(first instanceof Error) && !(second instanceof Error))
  assert.equal(first.build, second.build)
  assert.notEqual(first.runtime, second.runtime)
  assert(!JSON.stringify(first).includes('secret'))
  assert.deepEqual(
    reconcileDesiredState({ cfg }, 'blog', app, {
      services: {
        web: {
          build: { context: '/blog', args: { URL: 'one' } },
          image: 'blog',
          environment: { A: 'secret' },
        },
      },
    }),
    first,
  )
})

void test('legacy state loads with empty applied records', async (testCtx) => {
  const fixtureData = await fixture(testCtx)
  await mkdir(fixtureData.ctx.paths.stateDir, { recursive: true })
  const legacy: Partial<ReturnType<typeof stateEmpty>> = stateEmpty('blog')
  delete legacy.applied
  await writeFile(join(fixtureData.ctx.paths.stateDir, 'blog.json'), JSON.stringify(legacy))
  assert.deepEqual((await fixtureData.load()).applied, {})
})

// Match the installed nginx include: nginxDir/*/*.conf.
async function nginxIncludedRoutes(nginxDir: string): Promise<string[]> {
  const routes: string[] = []
  for (const dir of await readdir(nginxDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) {
      continue
    }
    for (const file of await readdir(join(nginxDir, dir.name))) {
      if (file.endsWith('.conf')) {
        routes.push(file)
      }
    }
  }
  return routes
}

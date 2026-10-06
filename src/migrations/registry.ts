import { m0001_ensure_dirs } from './0001-ensure-dirs.ts'
import { m0002_ensure_config } from './0002-ensure-config.ts'
import { m0003_ensure_group } from './0003-ensure-group.ts'
import { m0006_install_docker } from './0006-install-docker.ts'
import { m0007_install_watcher } from './0007-install-watcher.ts'
import { m0008_install_nginx } from './0008-install-nginx.ts'
import { m0009_install_sudoers } from './0009-install-sudoers.ts'
import { m0010_expand_sudoers_for_nginx } from './0010-expand-sudoers-for-nginx.ts'
import { m0011_repair_secret_permissions } from './0011-repair-managed-secret-permissions.ts'
import { m0012_start_managed_services } from './0012-start-managed-services.ts'
import { m0013_apply_ingress_body_limit } from './0013-apply-ingress-body-limit.ts'
import { m0014_move_build_args_to_env } from './0014-move-build-args-to-env.ts'
import { m0015_limit_docker_build_cache } from './0015-limit-docker-build-cache.ts'
import type { JibMigration } from './types.ts'

export const migrations: JibMigration[] = [
  m0001_ensure_dirs,
  m0002_ensure_config,
  m0003_ensure_group,
  m0006_install_docker,
  m0007_install_watcher,
  m0008_install_nginx,
  m0009_install_sudoers,
  m0010_expand_sudoers_for_nginx,
  m0011_repair_secret_permissions,
  m0012_start_managed_services,
  m0013_apply_ingress_body_limit,
  m0014_move_build_args_to_env,
  m0015_limit_docker_build_cache,
]

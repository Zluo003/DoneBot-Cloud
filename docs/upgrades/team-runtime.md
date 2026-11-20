# Team runtime provisioning

Status: opt-in foundations; not a team product release. Gateway and runtime APIs use `donebot.teams.v1`. Team model execution credentials, billing attribution, workspace switching and Linux adversarial acceptance are still pending. No `cloud_access` capability should be enabled yet.

Both worker and agent default `CLOUD_TEAMS_ENABLED` to off. Enabling requires the pinned `CLOUD_MASTER_PUBLIC_KEY`; the selected immutable runtime image must carry `cn.donebot.teams.protocol=donebot.teams.v1`. The worker advertises only the protocol returned by a healthy agent and rechecks it before team provisioning. Gateway configuration returns either personal gateway credentials or a team trust root and purchased resource snapshot, never both.

Team identity, public key, resources and file limits are held in the host-owned metadata store. Team setup refuses a personal credential, existing personal volume/container, a changed team or changed purchased specification. Disk creation uses the team resource snapshot; persisted smaller disks remain unchanged. Existing personal CPU, memory and combined 15 GiB storage limits are retained.

Member access uses a gateway signature bound to instance, team, actor, role, member version, method and exact runtime URI, expiring within ten seconds. Worker validates the outer node request; agent validates the member grant, including resource and backup routes. It forwards no personal Cookie or owner bearer. Full-instance backups require Owner/Admin. Gateway revocation closes open member connections; node lease loss fences the instance.

A team runtime never creates an Owner admin pairing session. Startup requires team protocol plus successful runtime isolation readiness. Missing bubblewrap, unavailable namespaces, pending/failed self-checks or missing seccomp prevent execution. Do not weaken Docker security options to bypass this boundary.

Verification on 2026-11-20: `node --test --test-concurrency=1 test/*.test.mjs`, 45 passed, including signed HTTP/WebSocket worker/agent paths, capability downgrade, opt-in defaults, immutable metadata and disk bounds. Evidence: `/tmp/donebot-cloud-team-all.log`. These synthetic runtimes do not establish real Linux isolation. DoneBot's isolated real-server fixture separately proved refusal to execute without isolation; image qualification remains pending.

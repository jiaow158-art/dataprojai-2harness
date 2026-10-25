#!/usr/bin/env bash
# S4-B2-C1：Runner managed 标签与身份 fail-closed 的 Linux/Docker 无模型测试。
# 仅使用 /srv/dpit/data/verify 下本轮创建的隔离任务根；不访问 DWS/模型。
set -u
set -o pipefail

REPO=/srv/dpit/apps/harness
RUNNER="$REPO/m0/sandbox/run_in_sandbox.sh"
IMAGE=dataplat-script:m0
BASE=$(mktemp -d /srv/dpit/data/verify/b2c1-label-XXXXXX) || exit 2
TASK_ROOT="$BASE/tasks"
SID=sess-c1-label
WD="$TASK_ROOT/work/$SID/workdir"
RES="$TASK_ROOT/results/$SID/results"
ASSETS="$BASE/assets"
ACL_STATE="$BASE/acl-state"
CONTAINERS=()
FAILS=0
RUNID=""
ATTEMPT=""
RUN_PID=""
RUN_RC=127
RUNNER_ENV=()

cleanup() {
  if [ -n "${RUN_PID:-}" ] && kill -0 "$RUN_PID" 2>/dev/null; then
    kill "$RUN_PID" 2>/dev/null || true
    wait "$RUN_PID" 2>/dev/null || true
  fi
  for n in "${CONTAINERS[@]:-}"; do
    [ -n "$n" ] || continue
    img=$(docker inspect --format '{{.Config.Image}}' "$n" 2>/dev/null || true)
    case "$img" in
      "$IMAGE") docker rm -f "$n" >/dev/null 2>&1 || true ;;
    esac
  done
  rm -rf "$BASE"
}
trap cleanup EXIT INT TERM

record() { printf '%s\n' "$*" | tee -a "$BASE/test.log"; }
fail() { record "FAIL: $*"; FAILS=$((FAILS+1)); }

install -d -m 700 "$BASE" "$TASK_ROOT" "$TASK_ROOT/work" "$TASK_ROOT/results" "$WD" "$RES" "$ASSETS" "$ACL_STATE"
printf 'asset\n' > "$ASSETS/keep.txt"
printf 'import os, json, time\nprint(json.dumps({"uid": os.getuid(), "ok": True}), flush=True)\ntime.sleep(3)\n' > "$WD/hold.py"
printf 'print("quick-ok")\n' > "$WD/quick.py"
record "start=$(date -Is) base=$BASE"
command -v docker >/dev/null 2>&1 || { fail "docker missing"; exit 1; }
docker info >/dev/null 2>&1 || { fail "docker daemon unavailable"; exit 1; }
docker image inspect "$IMAGE" >/dev/null 2>&1 || { fail "image missing: $IMAGE"; exit 1; }
[ "$(docker ps -a --filter ancestor="$IMAGE" --format '{{.Names}}' | wc -l)" -eq 0 ] || { fail "baseline sandbox containers exist"; exit 1; }

runner_env_args() { # <runid> <attempt>
  local rid="$1" att="$2"
  RUNNER_ENV=(
    PATH=/usr/local/bin:/usr/bin:/bin HOME="$BASE"
    RESULTS_DIR="$RES" ASSETS_DIR="$ASSETS"
    SANDBOX_TASK_ROOTS="$TASK_ROOT"
    SANDBOX_ASSETS_ROOTS="$ASSETS"
    SANDBOX_ACL_STATE_DIR="$ACL_STATE"
    SANDBOX_MEM=512m SANDBOX_CPUS=1 SANDBOX_PIDS=64
    SANDBOX_TIMEOUT_S=120 SANDBOX_IMAGE="$IMAGE"
  )
  [ -n "$rid" ] && RUNNER_ENV+=(SANDBOX_RUN_ID="$rid")
  [ -n "$att" ] && RUNNER_ENV+=(SANDBOX_ATTEMPT="$att")
}

start_bg() { # <runid> <attempt> <script> <label>
  runner_env_args "$1" "$2"
  env -i "${RUNNER_ENV[@]}" /bin/bash "$RUNNER" "$WD" "$3" >"$BASE/$4.out" 2>"$BASE/$4.err" &
  RUN_PID=$!
}

run_fg() { # <runid> <attempt> <script> <label>
  runner_env_args "$1" "$2"
  env -i "${RUNNER_ENV[@]}" /bin/bash "$RUNNER" "$WD" "$3" >"$BASE/$4.out" 2>"$BASE/$4.err"
  RUN_RC=$?
}

wait_container() { # <run-prefix|m0sandbox-> -> output name
  local prefix="$1" n
  for _ in $(seq 1 200); do
    while IFS= read -r n; do
      case "$n" in
        "$prefix"*) printf '%s\n' "$n"; return 0 ;;
      esac
    done < <(docker ps --filter ancestor="$IMAGE" --format '{{.Names}}' 2>/dev/null || true)
    sleep 0.05
  done
  return 1
}

label_of() {
  local v
  v=$(docker inspect --format "{{index .Config.Labels \"$2\"}}" "$1" 2>/dev/null || true)
  case "$v" in '<no value>') printf '' ;; *) printf '%s' "$v" ;; esac
}
inspect_field() { docker inspect --format "$2" "$1" 2>/dev/null || true; }
acl_residue() {
  local n=0
  n=$((n + $(getfacl -Rncp --absolute-names "$WD" 2>/dev/null | grep -c '^user:65534' || true)))
  n=$((n + $(getfacl -Rncp --absolute-names "$RES" 2>/dev/null | grep -c '^user:65534' || true)))
  n=$((n + $(getfacl -Rncp --absolute-names "$ASSETS" 2>/dev/null | grep -c '^user:65534' || true)))
  printf '%s\n' "$n"
}

# 1) Direct Runner without trusted task identity: no managed labels.
start_bg "" "" hold.py noid
PID=$RUN_PID
N=$(wait_container "m0sandbox-") || { fail "no-identity container not observed"; }
if [ -n "$N" ]; then
  CONTAINERS+=("$N")
  M=$(label_of "$N" com.dpit.gateway.managed)
  R=$(label_of "$N" com.dpit.gateway.task.run_id)
  A=$(label_of "$N" com.dpit.gateway.task.attempt)
  record "noid name=$N managed='$M' run_id='$R' attempt='$A'"
  [ "$M" != "true" ] && [ -z "$R" ] && [ -z "$A" ] || fail "no-identity container has managed labels"
fi
wait "$PID"; RC=$?
record "noid_rc=$RC"
[ "$RC" -eq 0 ] || fail "no-identity runner rc=$RC"
[ "$(acl_residue)" -eq 0 ] || fail "ACL residue after no-identity run"

# 2) Trusted identity: exact labels + unchanged sandbox controls.
RUNID="labeltest-$(date +%s)-$(openssl rand -hex 4)"
ATTEMPT=2
start_bg "$RUNID" "$ATTEMPT" hold.py managed
PID=$RUN_PID
N=$(wait_container "$RUNID-a$ATTEMPT-") || { fail "managed container not observed"; }
if [ -n "$N" ]; then
  CONTAINERS+=("$N")
  M=$(label_of "$N" com.dpit.gateway.managed)
  R=$(label_of "$N" com.dpit.gateway.task.run_id)
  A=$(label_of "$N" com.dpit.gateway.task.attempt)
  U=$(inspect_field "$N" '{{.Config.User}}')
  MEM=$(inspect_field "$N" '{{.HostConfig.Memory}}')
  CPU=$(inspect_field "$N" '{{.HostConfig.NanoCpus}}')
  PIDS=$(inspect_field "$N" '{{.HostConfig.PidsLimit}}')
  NET=$(inspect_field "$N" '{{.HostConfig.NetworkMode}}')
  RO=$(inspect_field "$N" '{{.HostConfig.ReadonlyRootfs}}')
  IMG=$(inspect_field "$N" '{{.Config.Image}}')
  record "managed name=$N labels=$M/$R/$A controls user=$U mem=$MEM cpu=$CPU pids=$PIDS net=$NET ro=$RO image=$IMG"
  [ "$M" = "true" ] && [ "$R" = "$RUNID" ] && [ "$A" = "$ATTEMPT" ] || fail "managed label mismatch"
  [ "$U" = "65534:65534" ] && [ "$MEM" = "536870912" ] && [ "$CPU" = "1000000000" ] && [ "$PIDS" = "64" ] \
    && [ "$NET" = "none" ] && [ "$RO" = "true" ] && [ "$IMG" = "$IMAGE" ] || fail "sandbox controls degraded"
fi
wait "$PID"; RC=$?
record "managed_rc=$RC"
[ "$RC" -eq 0 ] || fail "managed runner rc=$RC"
[ "$(acl_residue)" -eq 0 ] || fail "ACL residue after managed run"

# 3) Invalid identities fail before Docker and before ACL state changes.
BEFORE=$(docker ps -a --filter ancestor="$IMAGE" --format '{{.Names}}' | wc -l)
run_fg "../bad" 1 quick.py badrun
RC=$RUN_RC
[ "$RC" -eq 78 ] || fail "invalid run_id expected 78 got $RC"
run_fg "labeltest-invalid" "1x" quick.py badattempt
RC=$RUN_RC
[ "$RC" -eq 78 ] || fail "invalid attempt expected 78 got $RC"
AFTER=$(docker ps -a --filter ancestor="$IMAGE" --format '{{.Names}}' | wc -l)
[ "$BEFORE" -eq "$AFTER" ] || fail "invalid identity created a container"
[ "$(acl_residue)" -eq 0 ] || fail "ACL residue after invalid identity"
[ -z "$(find "$ACL_STATE" -maxdepth 1 \( -name '*.acl.bak' -o -name '*.acl.snap' \) -print -quit 2>/dev/null)" ] || fail "backup/snapshot after invalid identity"
record "invalid_rcs=78,78 before_containers=$BEFORE after_containers=$AFTER"

# Final resource/reap check: no container with our names remains.
LEFT=$(docker ps -a --filter ancestor="$IMAGE" --format '{{.Names}}' | wc -l)
[ "$LEFT" -eq 0 ] || fail "test containers remain: $LEFT"
[ "$FAILS" -eq 0 ] && record "SUMMARY ok=1" || record "SUMMARY ok=0 failures=$FAILS"
[ "$FAILS" -eq 0 ]

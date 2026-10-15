#!/usr/bin/env bash
# 沙箱边界验证 v2（LIN-1B S2-B 证据模型，spec §6.2）：阳性对照先行 + 负向产物判据三分类。
# ——基础设施故障（daemon 不通/镜像缺失/setfacl 缺失/脚本未执行/容器未启动）不得计入
#   BLOCKED-OK：负向脚本显式打印 LEAK:<case>（越界成功, exit 0）或 DENIED:<case>（预期拒绝
#   机制生效, exit 1）；无 DENIED 标记的非零一律 [INVALID-FAIL] 单独计数并判失败。
# 退出码：0=通过（SKIP 不影响）；1=存在 LEAK-FAIL 或 INVALID-FAIL；
#         2=NOT-EXECUTED（preflight 不满足，未执行任何容器）；3=阳性对照失败（负向未运行）。
# 平台：Linux 全量（宿主 uid 65534 读写对照、任务 B 清单+sha256 核对、仓库 ACL 残留审计）；
#       win32(Docker Desktop) 无 ACL 语义 → 宿主段 [SKIP-OS]，容器段同语义。
# 资源：单容器串行；SANDBOX_MEM 缺省 512m（可外层覆盖）。fixture 全部收拢单一 mktemp 根
#       （${TMPDIR:-/tmp}/s2b-redteam-*），退出 trap 即清理——仅删本脚本自建目录，无全局清理。
set -u
cd "$(dirname "$0")/../.." || exit 1

IMAGE="${SANDBOX_IMAGE:-dataplat-script:m0}"
export SANDBOX_MEM="${SANDBOX_MEM:-512m}"

# ---------- preflight：任一不满足 = NOT-EXECUTED（exit 2，不进入任何计数、不建 fixture） ----------
pf() { echo "NOT-EXECUTED: $1" >&2; exit 2; }
command -v docker >/dev/null 2>&1 || pf "docker CLI 缺失"
docker info >/dev/null 2>&1 || pf "Docker daemon 不可达"
docker image inspect "${IMAGE}" >/dev/null 2>&1 || pf "镜像 ${IMAGE} 不存在（先完成离线导入并本地构建）"
if [ "$(uname -s)" = "Linux" ]; then
  command -v setfacl >/dev/null 2>&1 || pf "setfacl 缺失（apt install acl）——无 ACL 支持禁止跑红队"
fi

# ---------- fixture：单一 mktemp 根，退出即清理（仅本脚本自建目录） ----------
TMPD=$(mktemp -d "${TMPDIR:-/tmp}/s2b-redteam-XXXXXX")
chmod 711 "$TMPD"   # 允许 uid 65534 穿越（不可列目录）：宿主对照须命中叶子目录自身的按任务
                    # ACL 语义，而非被 mktemp 700 的父目录先行挡死（生产 workroot 同理可穿越）
cleanup() { rm -rf "$TMPD"; }
trap cleanup EXIT
trap 'exit 130' INT TERM
WD="$TMPD/taskA-workdir"; RES="$TMPD/taskA-results"; WD2="$TMPD/taskB-workdir"; ASSETS="$TMPD/assets"
mkdir -p "$WD" "$RES" "$WD2"; chmod 700 "$WD" "$RES" "$WD2"   # 每任务目录同 mktemp 语义（700）
cp -r skills/report-generator "$ASSETS"                       # 测试资产专属副本：setfacl 只落副本，不碰仓库
printf 'taskB-secret' > "$WD2/m0_marker_zq.txt"               # 跨任务读取探针标记
printf 'pc-read-token-7f3a' > "$RES/pc_read.txt"              # P2 预置授权读取件
snap() { { find "$WD2" -type f -exec sha256sum {} + | sort; find "$WD2" | sort; } 2>/dev/null; }
SNAP_BEFORE=$(snap)

run() { RESULTS_DIR="$RES" ASSETS_DIR="$ASSETS" bash m0/sandbox/run_in_sandbox.sh "$@"; }

# ---------- 阳性对照（先证"沙箱可用"；任一失败 → exit 3，负向不运行） ----------
pc_fail() { echo "[POSITIVE-FAIL] $1"; exit 3; }

cat > "$WD/pc_write.py" <<'EOF'
import sys
try:
    with open("/workdir/pc_probe.txt", "w") as f:
        f.write("pc-write-ok")
except OSError as e:
    print(f"PC-WRITE-FAIL:{e}"); sys.exit(1)
print("PC-WRITE-OK")
EOF
out=$(run "$WD" pc_write.py 2>&1); rc=$?
{ [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "PC-WRITE-OK"; } || pc_fail "P1 容器写本任务 workdir 失败（rc=$rc）：$out"
[ "$(cat "$WD/pc_probe.txt" 2>/dev/null)" = "pc-write-ok" ] || pc_fail "P1 宿主复查 pc_probe.txt 内容不符"
echo "[POSITIVE-OK] P1 容器可写本任务 workdir（宿主复查内容一致）"

cat > "$WD/pc_read.py" <<'EOF'
import sys
try:
    with open("/results/pc_read.txt") as f:
        tok = f.read()
except OSError as e:
    print(f"PC-READ-FAIL:{e}"); sys.exit(1)
print(f"PC-READ-OK:{tok}")
EOF
out=$(run "$WD" pc_read.py 2>&1); rc=$?
{ [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "PC-READ-OK:pc-read-token-7f3a"; } || pc_fail "P2 容器读授权 results 失败（rc=$rc）：$out"
echo "[POSITIVE-OK] P2 容器可读授权 results"

out=$(run "$WD" /assets/scripts/build.py --selftest 2>&1); rc=$?
{ [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "SELFTEST PASS"; } || pc_fail "P3 报告生成器 selftest 失败（rc=$rc）：$out"
echo "[POSITIVE-OK] P3 报告生成器 selftest PASS（资产=测试副本）"

# ---------- 负向（三分类：BLOCKED-OK / LEAK-FAIL / INVALID-FAIL） ----------
pass=0; fail=0; invalid=0; skipped=0
check() { # check <名称> <rc> <输出>
  if [ "$2" -eq 0 ]; then echo "[LEAK-FAIL] $1"; fail=$((fail+1)); return; fi
  if printf '%s' "$3" | grep -q "DENIED:"; then
    echo "[BLOCKED-OK] $1"; pass=$((pass+1))
  else
    echo "[INVALID-FAIL] $1（无 DENIED 标记——基础设施/配置故障，不计入通过）"; invalid=$((invalid+1))
  fi
}

# 1. 凭据不可见（存在 DWS_/DSH_/DEEPSEEK_ 变量即泄漏）
cat > "$WD/t1.py" <<'EOF'
import os, sys
leaked = [k for k in os.environ if k.startswith(("DWS_", "DSH_", "DEEPSEEK_"))]
if leaked:
    print("LEAK:creds:" + ",".join(leaked)); sys.exit(0)
print("DENIED:creds:容器内无 DWS_/DSH_/DEEPSEEK_ 变量"); sys.exit(1)
EOF
out=$(run "$WD" t1.py 2>&1); rc=$?; check "凭据不可见" "$rc" "$out"

# 2. 网络不可达（canary 探针：直连 DWS IP 成功即泄漏；不带凭据、不执行查询）
cat > "$WD/t2.py" <<'EOF'
import socket, sys
try:
    socket.create_connection(("121.37.200.214", 8000), timeout=5)
except OSError as e:
    print(f"DENIED:net:{e}"); sys.exit(1)
print("LEAK:net:容器可直连 DWS"); sys.exit(0)
EOF
out=$(run "$WD" t2.py 2>&1); rc=$?; check "网络外联" "$rc" "$out"

# 3. 白名单外写入被拒（rootfs 只读）
cat > "$WD/t3.py" <<'EOF'
import sys
try:
    open("/etc/m0_probe", "w").write("x")
except OSError as e:
    print(f"DENIED:rootfs-write:{e}"); sys.exit(1)
print("LEAK:rootfs-write"); sys.exit(0)
EOF
out=$(run "$WD" t3.py 2>&1); rc=$?; check "越界写入" "$rc" "$out"

# 4. 只读挂载不可写（/results 与 /assets 各试一次）
cat > "$WD/t4.py" <<'EOF'
import sys
for p in ("/results/m0_probe", "/assets/m0_probe"):
    try:
        open(p, "w").write("x")
    except OSError:
        continue
    print(f"LEAK:ro-mount:{p}"); sys.exit(0)
print("DENIED:ro-mount:/results 与 /assets 均拒写"); sys.exit(1)
EOF
out=$(run "$WD" t4.py 2>&1); rc=$?; check "只读挂载写入" "$rc" "$out"

# 5. 跨任务「未挂载」隔离（读臂）：任务 B 目录未挂载进容器 → 有界扫描不可发现
cat > "$WD/t5.py" <<'EOF'
import os, sys
for base in ("/", "/tmp", "/workdir", "/results", "/assets"):
    for root, dirs, files in os.walk(base):
        dirs[:] = [d for d in dirs if not d.startswith(("proc", "sys", "dev"))]
        if root[len(base):].count(os.sep) >= 6:
            dirs[:] = []
        if "m0_marker_zq.txt" in files:
            print(f"LEAK:cross-read:{os.path.join(root, 'm0_marker_zq.txt')}"); sys.exit(0)
print("DENIED:cross-read:任务 B 标记在容器内不可发现（未挂载隔离）"); sys.exit(1)
EOF
out=$(run "$WD" t5.py 2>&1); rc=$?; check "跨任务读取（未挂载隔离）" "$rc" "$out"

# 6. 跨任务写入（写臂）：容器内 /tmp 为独立 tmpfs（可写属预期，不构成跨任务泄漏）；
#    对任务 B 的候选路径（不存在的挂载点/只读挂载）全部拒写。
cat > "$WD/t6.py" <<'EOF'
import sys
try:
    open("/tmp/xw_own.txt", "w").write("ok")
except OSError as e:
    print(f"INVALID:tmpfs-not-writable:{e}"); sys.exit(2)
for p in ("/wd2/xw.txt", "/workdir/../wd2/xw.txt", "/taskB-workdir/xw.txt",
          "/workdir/../taskB-workdir/xw.txt", "/results/xw.txt", "/assets/xw.txt"):
    try:
        open(p, "w").write("x")
    except OSError:
        continue
    print(f"LEAK:cross-write:{p}"); sys.exit(0)
print("DENIED:cross-write:所有跨任务候选路径均拒写（tmpfs 属预期可写，单列）"); sys.exit(1)
EOF
out=$(run "$WD" t6.py 2>&1); rc=$?; check "跨任务写入（tmpfs 除外）" "$rc" "$out"

# 7. 跨任务「UID/ACL」隔离（宿主层，Linux 专属）：任务 B 宿主目录对 uid 65534 读写均拒；
#    对照组：任务 A workdir 经 run_in_sandbox 按任务授权后 65534 可读写（证明拒绝来自按任务
#    ACL，而非"一律拒绝"）。最后核对任务 B 目录清单+sha256 前后一致。
if [ "$(uname -s)" = "Linux" ]; then
  if sudo -u nobody test -r "$WD" && sudo -u nobody test -w "$WD"; then
    echo "[POSITIVE-OK] uid 65534 可读写任务 A workdir（授权对照）"
  else
    echo "[INVALID-FAIL] uid 65534 对任务 A workdir 无权限——按任务 ACL 授权链异常"; invalid=$((invalid+1))
  fi
  if sudo -u nobody test -r "$WD2"; then
    echo "[LEAK-FAIL] 任务 B 宿主 workdir 可被 uid 65534 读取"; fail=$((fail+1))
  elif sudo -u nobody test -w "$WD2"; then
    echo "[LEAK-FAIL] 任务 B 宿主 workdir 可被 uid 65534 写入"; fail=$((fail+1))
  elif sudo -u nobody sh -c "printf x > '$WD2/uid_leak.txt'" 2>/dev/null; then
    echo "[LEAK-FAIL] 任务 B 宿主 workdir 实际写入成功"; fail=$((fail+1))
  else
    echo "[BLOCKED-OK] 任务 B 宿主 workdir：uid 65534 读写均拒（UID/ACL 隔离）"; pass=$((pass+1))
  fi
  SNAP_AFTER=$(snap)
  if [ "$SNAP_BEFORE" = "$SNAP_AFTER" ]; then
    echo "[POSITIVE-OK] 任务 B 目录清单+sha256 前后一致（$WD2）"
  else
    echo "[LEAK-FAIL] 任务 B 目录发生变更："; printf '%s\n---\n%s\n' "$SNAP_BEFORE" "$SNAP_AFTER"; fail=$((fail+1))
  fi
  n=$(getfacl -n -p skills/report-generator 2>/dev/null | grep -c "user:65534" || true)
  if [ "${n:-0}" -eq 0 ]; then
    echo "[POSITIVE-OK] 仓库 skills/report-generator 无 65534 ACL 残留（资产隔离生效）"
  else
    echo "[LEAK-FAIL] 仓库 skills/report-generator 残留 ${n} 条 65534 ACL"; fail=$((fail+1))
  fi
else
  echo "[SKIP-OS] 宿主 UID/ACL 对照与仓库 ACL 审计（win32 无 ACL 语义）"; skipped=$((skipped+1))
fi

echo "passed=$pass failed=$fail invalid=$invalid skipped=$skipped（fixture 根 $TMPD，退出即清理）"
[ $((fail + invalid)) -eq 0 ] && exit 0 || exit 1

# ---------------------------------------------------------------------
# 历史回执（2026-09-08，Git Bash + Docker Desktop 27.5.1 WSL2）：旧 4 条负向 4/4。
# 已被 v2 证据模型取代（阳性先行 + LEAK/DENIED/INVALID 三分类 + 宿主 UID/ACL 段）；
# Linux 侧正式回执待 S2-B 实跑后按新格式追加，不在此预填。
# ---------------------------------------------------------------------

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
ROOT="$TMPD/fixture-root/taskroot"   # S4-B1r3：任务根深度须 ≥4（拒 /srv/dpit/data 级过宽根）；
                                        # Linux 默认 /tmp/tmp.XXXX/taskroot 仅 3 级，故固定再下沉一层
mkdir -p "$ROOT"
WD="$ROOT/taskA-workdir"; RES="$ROOT/taskA-results"; WD2="$ROOT/taskB-workdir"; ASSETS="$ROOT/assets"
if [ "$(uname -s)" = "Linux" ]; then
  # S4-B1r2：runner 需授权任务根（fail closed）；ACL 状态目录走 runner 缺省（任务根下
  # .sandbox-acl-state，0700+属主+非符号链接校验）——不依赖共享 /tmp，fixture 退出即清
  export SANDBOX_TASK_ROOTS="$ROOT"
fi
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
  # 授权对照（S4-B1r2 闭环保留下改为「运行中」探针）：长任务运行期间（已授权）
  # 65534 可读写任务 A workdir——证明任务 B 的拒绝来自按任务 ACL 而非一律拒绝
  printf 'import time\ntime.sleep(6)\nprint("t7-ok")\n' > "$WD/t7long.py"
  ( run "$WD" t7long.py > "$TMPD/t7.log" 2>&1 ) & T7PID=$!
  T7LOCKED=0
  _kA="$(printf '%s' "$(realpath -e "$WD")" | sha256sum | cut -c1-16)"
  # S4-B1r3 采样时机：runner 先持锁、后备份并授权——须同时观察到「锁被持有 +
  # uid 65534 已在 workdir 获得读写」才判定，避免授权完成前的毫秒级竞态误报 INVALID。
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if ! flock -n "${ROOT}/.sandbox-acl-state/${_kA}.lock" true 2>/dev/null \
       && sudo -n -u '#65534' test -r "$WD" && sudo -n -u '#65534' test -w "$WD"; then
      T7LOCKED=1; break
    fi
    sleep 0.5
  done
  if [ "$T7LOCKED" -eq 1 ]; then
    echo "[POSITIVE-OK] uid 65534 运行期可读写任务 A workdir（授权对照，闭环保留下）"
  else
    echo "[INVALID-FAIL] uid 65534 运行期对任务 A workdir 无权限——按任务 ACL 授权链异常"; invalid=$((invalid+1))
  fi
  wait "$T7PID"
  if sudo -n -u '#65534' test -r "$WD2"; then
    echo "[LEAK-FAIL] 任务 B 宿主 workdir 可被 uid 65534 读取"; fail=$((fail+1))
  elif sudo -n -u '#65534' test -w "$WD2"; then
    echo "[LEAK-FAIL] 任务 B 宿主 workdir 可被 uid 65534 写入"; fail=$((fail+1))
  elif sudo -n -u '#65534' sh -c "printf x > '$WD2/uid_leak.txt'" 2>/dev/null; then
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

# 8. S4-B1r2 ACL 授权/恢复闭环（宿主层，Linux 专属）。用例：
#    8a 0600 脚本+0700 嵌套目录+0600 多文件依赖（阳性） · 8b 恢复正确性（整树+results/assets
#    零残留+模式位不变） · 8c 越界任务根拒绝（含同名目录陷阱） · 8c2 过宽根配置拒绝（/ 与
#    深度<4） · 8c3/8c4 根外 assets 拒绝与 SANDBOX_ASSETS_ROOTS 授权面 · 8d stale 备份恢复
#    闭环（伪造现场） · 8d2 真实 SIGKILL 后 stale 恢复 · 8e 损坏备份 fail-closed（79+保备份+
#    不启容器） · 8f 同 workdir 并发（flock -n 直接 78）· 8g symlink/fifo 防护 ·
#    8h 容器自建文件后二次调用 · 8i 任务中删除文件后恢复 · 8i2 非删除恢复错误不被吞 ·
#    8i3 任务期换入符号链接拒绝跟随 · 8j 非零退出/超时后恢复 · 8k 既有 ACL/mask 字节级保持。
if [ "$(uname -s)" = "Linux" ]; then
  STATE="${ROOT}/.sandbox-acl-state"   # runner 缺省状态目录（任务根下）
  # 8a 阳性：0600 脚本 + 0700 嵌套子目录 + 0600 多文件依赖，容器内可读可执行（修复目标）
  WD3="$ROOT/s4-workdir"; mkdir -p "$WD3/sub"
  printf 'print("s4-ok")\nprint(open("/workdir/sub/dep.txt").read().strip())\n' > "$WD3/r.py"; chmod 600 "$WD3/r.py"
  printf 'dep-data\n' > "$WD3/sub/dep.txt"; chmod 600 "$WD3/sub/dep.txt"
  printf 'open("/workdir/out.txt","w").write("gen-ok")\n' > "$WD3/sub/gen.py"; chmod 600 "$WD3/sub/gen.py"
  chmod 700 "$WD3" "$WD3/sub"
  out=$(run "$WD3" r.py 2>&1); rc=$?
  out2=$(run "$WD3" sub/gen.py 2>&1); rc2=$?
  if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q s4-ok && printf '%s' "$out" | grep -q dep-data \
     && [ "$rc2" -eq 0 ] && [ "$(cat "$WD3/out.txt" 2>/dev/null)" = "gen-ok" ]; then
    echo "[POSITIVE-OK] 8a 0600 脚本+0700 嵌套目录+多文件依赖容器内可执行（S4-B1 修复目标）"
  else
    echo "[INVALID-FAIL] 8a 私有模式脚本不可读/不可执行（rc=$rc/$rc2）：$out $out2"; invalid=$((invalid+1))
  fi

  # 8b 恢复正确性：workdir 整树 + results/assets 目录 零 u:65534 残留；模式位不变
  residue=$(getfacl -Rncp --absolute-names "$WD3" 2>/dev/null | grep -c "^user:65534" || true)
  residue_ra=$(getfacl -ncp --absolute-names "$RES" "$ASSETS" 2>/dev/null | grep -c "^user:65534" || true)
  m_root=$(stat -c %a "$WD3"); m_sub=$(stat -c %a "$WD3/sub"); m_f=$(stat -c %a "$WD3/r.py")
  if [ "${residue:-0}" -eq 0 ] && [ "${residue_ra:-0}" -eq 0 ] \
     && [ "$m_root" = "700" ] && [ "$m_sub" = "700" ] && [ "$m_f" = "600" ]; then
    echo "[BLOCKED-OK] 8b ACL 精确恢复闭环（workdir 树+results/assets 零残留；模式位 700/700/600 不变）"; pass=$((pass+1))
  else
    echo "[LEAK-FAIL] 8b ACL 残留或模式漂移（树=$residue results/assets=$residue_ra modes=$m_root/$m_sub/$m_f）"; fail=$((fail+1))
  fi

  # 8c 越界任务根拒绝 + 同名目录陷阱（仅凭目录名不得通过——须解析后全路径前缀比对）
  OUT8=$(mktemp -d "${TMPDIR:-/tmp}/s2b-outside-XXXXXX")
  mkdir -p "$OUT8/taskA-workdir"; printf 'print("evil")\n' > "$OUT8/taskA-workdir/e.py"
  out=$(RESULTS_DIR="$RES" ASSETS_DIR="$ASSETS" bash m0/sandbox/run_in_sandbox.sh "$OUT8/taskA-workdir" e.py 2>&1); rc=$?
  if [ "$rc" -eq 78 ] && printf '%s' "$out" | grep -q "SANDBOX-FATAL\[78\]"; then
    echo "[BLOCKED-OK] 8c 越界 workdir 拒绝（exit 78；同名目录不误判，容器未启动）"; pass=$((pass+1))
  else
    echo "[LEAK-FAIL] 8c 越界路径未被拒（rc=$rc）：$out"; fail=$((fail+1))
  fi
  rm -rf "$OUT8"

  # 8c2 过宽任务根配置拒绝："/"（黑名单）与「深度 3 的现存在祖先」（深度规则）均须 exit 78
  # ——候选根由 fixture 根逐级上溯计算，不依赖 TMPDIR 的实际深度（S4-B1r3）
  SHALLOW="$ROOT"
  while [ "$(printf '%s' "$SHALLOW" | tr -cd '/' | wc -c)" -ge 4 ]; do SHALLOW="$(dirname "$SHALLOW")"; done
  for badroot in "/" "$SHALLOW"; do
    out=$(RESULTS_DIR="$RES" ASSETS_DIR="$ASSETS" SANDBOX_TASK_ROOTS="$badroot" \
          bash m0/sandbox/run_in_sandbox.sh "$WD3" r.py 2>&1); rc=$?
    if [ "$rc" -eq 78 ] && printf '%s' "$out" | grep -q "非法任务根"; then
      echo "[BLOCKED-OK] 8c2 过宽任务根拒绝（root=${badroot}）"; pass=$((pass+1))
    else
      echo "[LEAK-FAIL] 8c2 过宽根未被拒（root=${badroot} rc=$rc）：$out"; fail=$((fail+1))
    fi
  done

  # 8c3 根外 assets 拒绝：assets 指向任务根外且未配 SANDBOX_ASSETS_ROOTS → 78
  # S4-B1r3：可信资产根同样受「深度≥4」校验——fixture 收拢在 TMPD 单一根下
  # （EXIT trap 兜底），同时位于任务根 ROOT 之外，保持 8c3 拒绝 / 8c4 放行语义。
  AST_TMP=$(mktemp -d "$TMPD/s2b-assets-XXXXXX")
  AST_BASE="$AST_TMP/ext-assets-root"; AST_OUT="$AST_BASE/v1"; mkdir -p "$AST_OUT"
  chmod 700 "$AST_TMP" "$AST_BASE"
  out=$(RESULTS_DIR="$RES" ASSETS_DIR="$AST_OUT" bash m0/sandbox/run_in_sandbox.sh "$WD3" r.py 2>&1); rc=$?
  if [ "$rc" -eq 78 ] && printf '%s' "$out" | grep -q "SANDBOX_ASSETS_ROOTS/SANDBOX_TASK_ROOTS"; then
    echo "[BLOCKED-OK] 8c3 根外 assets 拒绝（exit 78，容器未启动）"; pass=$((pass+1))
  else
    echo "[LEAK-FAIL] 8c3 根外 assets 未被拒（rc=$rc）：$out"; fail=$((fail+1))
  fi

  # 8c4 可信资产根授权面：同一根外 assets 经 SANDBOX_ASSETS_ROOTS 显式放行 → 正常执行
  out=$(RESULTS_DIR="$RES" ASSETS_DIR="$AST_OUT" SANDBOX_ASSETS_ROOTS="$AST_OUT" \
        bash m0/sandbox/run_in_sandbox.sh "$WD3" r.py 2>&1); rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "[BLOCKED-OK] 8c4 可信资产根授权面生效（SANDBOX_ASSETS_ROOTS 显式放行）"; pass=$((pass+1))
  else
    echo "[LEAK-FAIL] 8c4 资产根授权异常（rc=$rc）：$out"; fail=$((fail+1))
  fi
  rm -rf "$AST_TMP"

  # 8d stale 备份闭环（伪造「已授权后被 SIGKILL」现场：树上残留 65534 + 备份对留存）
  WD4="$ROOT/s4-stale"; mkdir -p "$WD4"; printf 'print("stale-ok")\n' > "$WD4/g.py"
  k4="$(printf '%s' "$(realpath -e "$WD4")" | sha256sum | cut -c1-16)"
  BAK4="${STATE}/${k4}.acl.bak"; SNAP4="${STATE}/${k4}.acl.snap"
  getfacl --absolute-names "$WD4" 2>/dev/null > "$BAK4"
  getfacl --absolute-names "$RES" 2>/dev/null >> "$BAK4"   # 对齐 runner 备份域（含 results/assets）
  getfacl --absolute-names "$ASSETS" 2>/dev/null >> "$BAK4"
  { printf '%s\td\t%s\n' "$WD4" "$(getfacl -c --absolute-names -- "$WD4" 2>/dev/null | paste -sd, -)"
    printf '%s\td\t%s\n' "$RES" "$(getfacl -c --absolute-names -- "$RES" 2>/dev/null | paste -sd, -)"
    printf '%s\td\t%s\n' "$ASSETS" "$(getfacl -c --absolute-names -- "$ASSETS" 2>/dev/null | paste -sd, -)"
  } > "$SNAP4"
  setfacl -m u:65534:rwx "$WD4" 2>/dev/null   # 伪造授权残留
  out=$(run "$WD4" g.py 2>&1); rc=$?
  res4=$(getfacl -Rncp --absolute-names "$WD4" 2>/dev/null | grep -c "^user:65534" || true)
  if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "检测到上次异常退出" && [ "${res4:-0}" -eq 0 ] && [ ! -e "$BAK4" ]; then
    echo "[BLOCKED-OK] 8d stale 备份恢复闭环（基线还原→重授权→运行→恢复→清备份）"; pass=$((pass+1))
  else
    echo "[LEAK-FAIL] 8d stale 处理异常（rc=$rc residue=$res4 bak留存=$([ -e "$BAK4" ] && echo y || echo n)）"; fail=$((fail+1))
  fi

  # 8d2 真实 SIGKILL：后台长任务进入运行段后 kill -9 runner → 下次调用检出 stale 并闭环
  WD42="$ROOT/s4-kill"; mkdir -p "$WD42"; printf 'import time\ntime.sleep(5)\nprint("k-ok")\n' > "$WD42/k.py"
  k42="$(printf '%s' "$(realpath -e "$WD42")" | sha256sum | cut -c1-16)"
  BAK42="${STATE}/${k42}.acl.bak"
  RESULTS_DIR="$RES" ASSETS_DIR="$ASSETS" bash m0/sandbox/run_in_sandbox.sh "$WD42" k.py \
    > "$TMPD/kill.log" 2>&1 & KPID=$!
  KLOCKED=0
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [ -e "$BAK42" ] && { KLOCKED=1; break; }   # 备份落盘=已过备份段（授权中/已授权）
    sleep 0.5
  done
  kill -9 "$KPID" 2>/dev/null; wait "$KPID" 2>/dev/null
  if [ "$KLOCKED" -eq 1 ] && [ -e "$BAK42" ]; then
    printf 'print("k2-ok")\n' > "$WD42/k2.py"
    out=$(run "$WD42" k2.py 2>&1); rc=$?
    res42=$(getfacl -Rncp --absolute-names "$WD42" 2>/dev/null | grep -c "^user:65534" || true)
    if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "检测到上次异常退出" && [ "${res42:-0}" -eq 0 ] && [ ! -e "$BAK42" ]; then
      echo "[BLOCKED-OK] 8d2 真实 SIGKILL 后 stale 恢复闭环（kill -9 runner → 下次自愈）"; pass=$((pass+1))
    else
      echo "[LEAK-FAIL] 8d2 SIGKILL 恢复异常（rc=$rc residue=$res42）"; fail=$((fail+1))
    fi
  else
    echo "[INVALID-FAIL] 8d2 未能进入运行段（备份未落盘），现场未成立"; invalid=$((invalid+1))
  fi

  # 8e 损坏备份 fail-closed：拒绝执行（容器不启动）、备份保留、exit 79
  WD5="$ROOT/s4-corrupt"; mkdir -p "$WD5"; printf 'print("x")\n' > "$WD5/x.py"
  k5="$(printf '%s' "$(realpath -e "$WD5")" | sha256sum | cut -c1-16)"
  BAK5="${STATE}/${k5}.acl.bak"; SNAP5="${STATE}/${k5}.acl.snap"
  printf 'not an acl file\n' > "$BAK5"; printf 'garbage\n' > "$SNAP5"
  out=$(run "$WD5" x.py 2>&1); rc=$?
  if [ "$rc" -eq 79 ] && [ -e "$BAK5" ] && printf '%s' "$out" | grep -q "SANDBOX-FATAL\[79\]"; then
    echo "[BLOCKED-OK] 8e 损坏备份 fail-closed（exit 79，备份留存，容器未启动）"; pass=$((pass+1))
  else
    echo "[LEAK-FAIL] 8e 恢复失败未保备份/未拒绝（rc=$rc bak=$([ -e "$BAK5" ] && echo y || echo n)）：$out"; fail=$((fail+1))
  fi

  # 8f 同 workdir 并发：flock -n——第二调用立即 78；首任务正常完成且零残留
  WD6="$ROOT/s4-conc"; mkdir -p "$WD6"; printf 'import time\ntime.sleep(6)\nprint("c-ok")\n' > "$WD6/c.py"
  k6="$(printf '%s' "$(realpath -e "$WD6")" | sha256sum | cut -c1-16)"
  LOCK6="${STATE}/${k6}.lock"
  ( run "$WD6" c.py > "$TMPD/conc.log" 2>&1 ) & CONC_PID=$!
  CONFLICT_RC=-1; out2=""   # S4-B1r3：未采样到锁时也保持 set -u 下可诊断
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if ! flock -n "$LOCK6" true 2>/dev/null; then
      out2=$(run "$WD6" c.py 2>&1); CONFLICT_RC=$?; break
    fi
    sleep 0.5
  done
  if [ "$CONFLICT_RC" -eq 78 ] && printf '%s' "$out2" | grep -q "并发冲突"; then
    echo "[BLOCKED-OK] 8f 同 workdir 并发第二调用立即拒绝（flock -n，exit 78）"; pass=$((pass+1))
  else
    echo "[LEAK-FAIL] 8f 并发冲突未被拒（rc=$CONFLICT_RC）：$out2"; fail=$((fail+1))
  fi
  wait "$CONC_PID"; conc_rc=$?
  res6=$(getfacl -Rncp --absolute-names "$WD6" 2>/dev/null | grep -c "^user:65534" || true)
  if [ "$conc_rc" -eq 0 ] && [ "${res6:-0}" -eq 0 ]; then
    echo "[POSITIVE-OK] 8f 首任务并发场景下正常完成且整树零残留"
  else
    echo "[INVALID-FAIL] 8f 首任务异常（rc=$conc_rc residue=$res6）：$(tail -3 "$TMPD/conc.log")"; invalid=$((invalid+1))
  fi

  # 8g symlink/fifo 防护：授权与恢复不得波及链接目标（域外文件零 65534），fifo 不炸流程
  WD7="$ROOT/s4-link"; mkdir -p "$WD7"
  ln -s "$WD2/m0_marker_zq.txt" "$WD7/leak.txt"
  mkfifo "$WD7/pipe.fifo" 2>/dev/null || true
  printf 'print("l-ok")\n' > "$WD7/l.py"; chmod 600 "$WD7/l.py"
  out=$(run "$WD7" l.py 2>&1); rc=$?
  tgt=$(getfacl -ncp --absolute-names "$WD2/m0_marker_zq.txt" 2>/dev/null | grep -c "^user:65534" || true)
  if [ "$rc" -eq 0 ] && [ "${tgt:-0}" -eq 0 ] && [ -p "$WD7/pipe.fifo" ]; then
    echo "[BLOCKED-OK] 8g symlink/fifo 防护（链接目标零越界授权；fifo 存活不炸备份/恢复）"; pass=$((pass+1))
  else
    echo "[LEAK-FAIL] 8g symlink/fifo 防护异常（rc=$rc 目标65534=$tgt fifo=$([ -p "$WD7/pipe.fifo" ] && echo y || echo n)）"; fail=$((fail+1))
  fi

  # 8h 容器自建文件后第二次调用：容器产物（65534 属主）不进备份/授权域（-uid 过滤），
  #     二次调用正常，产物留存可读，恢复零残留
  WD8="$ROOT/s4-second"; mkdir -p "$WD8"
  printf 'open("f2.txt","w").write("made-by-container")\nprint("w1-ok")\n' > "$WD8/w.py"; chmod 600 "$WD8/w.py"
  printf 'print(open("/workdir/f2.txt").read().strip())\n' > "$WD8/r2.py"; chmod 600 "$WD8/r2.py"
  out=$(run "$WD8" w.py 2>&1); rc=$?
  out2=$(run "$WD8" r2.py 2>&1); rc2=$?
  res8=$(getfacl -Rncp --absolute-names "$WD8" 2>/dev/null | grep -c "^user:65534" || true)
  if [ "$rc" -eq 0 ] && [ "$rc2" -eq 0 ] && printf '%s' "$out2" | grep -q made-by-container && [ "${res8:-0}" -eq 0 ]; then
    echo "[BLOCKED-OK] 8h 容器自建文件后二次调用（属主过滤幂等，产物留存，零残留）"; pass=$((pass+1))
  else
    echo "[LEAK-FAIL] 8h 二次调用异常（rc=$rc/$rc2 residue=$res8）：$out2"; fail=$((fail+1))
  fi

  # 8i 任务中删除文件后的恢复：verify 对已删路径跳过（合法变更），不误判 79，删除保持
  WD9="$ROOT/s4-del"; mkdir -p "$WD9"
  printf 'import os\nos.remove("/workdir/victim.txt")\nprint("d-ok")\n' > "$WD9/del.py"; chmod 600 "$WD9/del.py"
  printf 'to-be-deleted\n' > "$WD9/victim.txt"; chmod 600 "$WD9/victim.txt"
  out=$(run "$WD9" del.py 2>&1); rc=$?
  if [ "$rc" -eq 0 ] && [ ! -e "$WD9/victim.txt" ]; then
    echo "[BLOCKED-OK] 8i 任务内删除文件后恢复正常（skip-missing 语义，删除保持，非 79）"; pass=$((pass+1))
  else
    echo "[LEAK-FAIL] 8i 删除场景恢复异常（rc=$rc victim=$([ -e "$WD9/victim.txt" ] && echo 存在 || echo 已删)）：$out"; fail=$((fail+1))
  fi

  # 8i2 非删除类恢复错误不得被吞：容器把基线文件替换为 uid 65534 属主文件后，
  #     dp-user 无法对该路径 setfacl → 必须 79 且保留备份（与 8i 的合法删除区分）
  WD9b="$ROOT/s4-del-err"; mkdir -p "$WD9b"
  printf 'import os\nos.remove("/workdir/victim2.txt")\nopen("/workdir/victim2.txt","w").write("container-owned")\nprint("r-ok")\n' > "$WD9b/repl.py"
  chmod 600 "$WD9b/repl.py"
  printf 'baseline\n' > "$WD9b/victim2.txt"; chmod 600 "$WD9b/victim2.txt"
  out=$(run "$WD9b" repl.py 2>&1); rc=$?
  k9b="$(printf '%s' "$(realpath -e "$WD9b")" | sha256sum | cut -c1-16)"
  BAK9b="${STATE}/${k9b}.acl.bak"; SNAP9b="${STATE}/${k9b}.acl.snap"
  if [ "$rc" -eq 79 ] && [ -e "$BAK9b" ] && [ -e "$SNAP9b" ] \
     && printf '%s' "$out" | grep -q "setfacl --restore 失败"; then
    echo "[BLOCKED-OK] 8i2 非删除类恢复错误不被吞（exit 79，备份+报错留存）"; pass=$((pass+1))
  else
    echo "[LEAK-FAIL] 8i2 恢复错误被吞/未保留备份（rc=$rc bak=$([ -e "$BAK9b" ] && echo y || echo n)）：$out"; fail=$((fail+1))
  fi

  # 8i3 任务期把备份域内目录换成指向域外的符号链接：setfacl --restore 默认会跟随
  #     （实测 leaf 与父目录链接都会改写目标 ACL）——runner 必须拒绝跟随、exit 79、
  #     备份留存，且域外目标 ACL 字节级不变。
  WD9c="$ROOT/s4-symswap"; mkdir -p "$WD9c/sub"
  TGT9c="$TMPD/outside-target"; mkdir -p "$TGT9c"
  printf 'outside-original\n' > "$TGT9c/dep.txt"; chmod 600 "$TGT9c/dep.txt"
  setfacl -m u:2000:r-- "$TGT9c/dep.txt" 2>/dev/null
  printf 'workdir-original\n' > "$WD9c/sub/dep.txt"; chmod 600 "$WD9c/sub/dep.txt"
  setfacl -m u:2001:r-- "$WD9c/sub/dep.txt" 2>/dev/null
  printf 'import os, shutil\nshutil.rmtree("/workdir/sub")\nos.symlink("%s", "/workdir/sub")\nprint("s-ok")\n' \
    "$TGT9c" > "$WD9c/swap.py"
  chmod 600 "$WD9c/swap.py"
  before9c=$(getfacl -ncp --absolute-names "$TGT9c/dep.txt" 2>/dev/null)
  out=$(run "$WD9c" swap.py 2>&1); rc=$?
  after9c=$(getfacl -ncp --absolute-names "$TGT9c/dep.txt" 2>/dev/null)
  k9c="$(printf '%s' "$(realpath -e "$WD9c")" | sha256sum | cut -c1-16)"
  BAK9c="${STATE}/${k9c}.acl.bak"
  if [ "$rc" -eq 79 ] && [ -e "$BAK9c" ] && [ "$before9c" = "$after9c" ] \
     && printf '%s' "$out" | grep -q "拒绝跟随"; then
    echo "[BLOCKED-OK] 8i3 任务期换入符号链接不跟随（exit 79，域外 ACL 零变更，备份留存）"; pass=$((pass+1))
  else
    echo "[LEAK-FAIL] 8i3 符号链接跟随/域外 ACL 变更（rc=$rc bak=$([ -e "$BAK9c" ] && echo y || echo n) target_changed=$([ "$before9c" = "$after9c" ] && echo n || echo y)）：$out"; fail=$((fail+1))
  fi

  # 8j 非零退出 / 超时：容器退出码透传，恢复闭环不受影响
  WDj="$ROOT/s4-rc"; mkdir -p "$WDj"
  printf 'import sys\nsys.exit(3)\n' > "$WDj/e3.py"; chmod 600 "$WDj/e3.py"
  printf 'import time\ntime.sleep(8)\n' > "$WDj/slow.py"; chmod 600 "$WDj/slow.py"
  out=$(run "$WDj" e3.py 2>&1); rc3=$?
  resj1=$(getfacl -Rncp --absolute-names "$WDj" 2>/dev/null | grep -c "^user:65534" || true)
  out=$(RESULTS_DIR="$RES" ASSETS_DIR="$ASSETS" SANDBOX_TIMEOUT_S=3 \
        bash m0/sandbox/run_in_sandbox.sh "$WDj" slow.py 2>&1); rcT=$?
  resj2=$(getfacl -Rncp --absolute-names "$WDj" 2>/dev/null | grep -c "^user:65534" || true)
  if [ "$rc3" -eq 3 ] && [ "${resj1:-0}" -eq 0 ] \
     && { [ "$rcT" -eq 124 ] || [ "$rcT" -eq 137 ]; } && [ "${resj2:-0}" -eq 0 ]; then
    echo "[BLOCKED-OK] 8j 非零退出（rc=3）与超时（rc=$rcT）后均恢复闭环零残留"; pass=$((pass+1))
  else
    echo "[LEAK-FAIL] 8j 退出码/恢复异常（rc3=$rc3 rcT=$rcT residue=$resj1/$resj2）"; fail=$((fail+1))
  fi

  # 8k 既有 ACL/mask 字节级保持：预置 named 条目+限定 mask，全周期后 getfacl -c 全量一致
  WD10="$ROOT/s4-mask"; mkdir -p "$WD10"
  printf 'print(open("/workdir/keep.txt").read().strip())\n' > "$WD10/m.py"; chmod 600 "$WD10/m.py"
  printf 'keep-data\n' > "$WD10/keep.txt"; chmod 600 "$WD10/keep.txt"
  setfacl -m u:2000:r--,m::r-- "$WD10/keep.txt" 2>/dev/null
  before=$(getfacl -c --absolute-names "$WD10/keep.txt" 2>/dev/null)
  out=$(run "$WD10" m.py 2>&1); rc=$?
  after=$(getfacl -c --absolute-names "$WD10/keep.txt" 2>/dev/null)
  if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q keep-data && [ "$before" = "$after" ]; then
    echo "[BLOCKED-OK] 8k 既有 ACL/mask 全量保持（named+mask 字节级一致，含运行期读授权）"; pass=$((pass+1))
  else
    echo "[LEAK-FAIL] 8k ACL/mask 漂移（before[$before] after[$after] rc=$rc）"; fail=$((fail+1))
  fi
else
  echo "[SKIP-OS] S4-B1r2 ACL 授权/恢复闭环（win32 无 ACL 语义）"; skipped=$((skipped+1))
fi

echo "passed=$pass failed=$fail invalid=$invalid skipped=$skipped（fixture 根 $TMPD，退出即清理）"
[ $((fail + invalid)) -eq 0 ] && exit 0 || exit 1

# ---------------------------------------------------------------------
# 历史回执（2026-09-08，Git Bash + Docker Desktop 27.5.1 WSL2）：旧 4 条负向 4/4。
# 已被 v2 证据模型取代（阳性先行 + LEAK/DENIED/INVALID 三分类 + 宿主 UID/ACL 段）；
# Linux 侧正式回执待 S2-B 实跑后按新格式追加，不在此预填。
# ---------------------------------------------------------------------

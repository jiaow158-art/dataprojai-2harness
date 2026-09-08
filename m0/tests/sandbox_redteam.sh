#!/usr/bin/env bash
# 沙箱边界验证：四条全绿才允许进入 Phase E（spec §6.2）
# 设计事实：/tmp 为 tmpfs 可写(noexec)——属预期行为，不在断言范围
set -u
cd "$(dirname "$0")/../.." || exit 1
WD=$(mktemp -d); RES=$(mktemp -d)
export RESULTS_DIR="$RES" ASSETS_DIR="$(pwd)/skills/report-generator"
pass=0; fail=0
check() { if [ "$2" -ne 0 ]; then echo "[BLOCKED-OK] $1"; pass=$((pass+1)); else echo "[LEAK-FAIL] $1"; fail=$((fail+1)); fi }

# 1. 凭据不可见（存在 DWS_/DSH_/DEEPSEEK_ 变量即泄漏）
cat > "$WD/t1.py" <<'EOF'
import os, sys
sys.exit(0 if [k for k in os.environ if k.startswith(("DWS_","DSH_","DEEPSEEK_"))] else 1)
EOF
bash m0/sandbox/run_in_sandbox.sh "$WD" t1.py >/dev/null 2>&1; check "凭据泄漏" $?

# 2. 网络不可达（DWS 直连）
cat > "$WD/t2.py" <<'EOF'
import socket, sys
try:
    socket.create_connection(("121.37.200.214", 8000), timeout=5); sys.exit(0)
except OSError:
    sys.exit(1)
EOF
bash m0/sandbox/run_in_sandbox.sh "$WD" t2.py >/dev/null 2>&1; check "网络外联" $?

# 3. 白名单外写入被拒（rootfs 只读）
cat > "$WD/t3.py" <<'EOF'
import sys
try:
    open("/etc/m0_probe", "w").write("x"); sys.exit(0)
except OSError:
    sys.exit(1)
EOF
bash m0/sandbox/run_in_sandbox.sh "$WD" t3.py >/dev/null 2>&1; check "越界写入" $?

# 4. 只读挂载不可写（/results 与 /assets 各试一次）
cat > "$WD/t4.py" <<'EOF'
import sys
for p in ("/results/m0_probe", "/assets/m0_probe"):
    try:
        open(p, "w").write("x"); sys.exit(0)
    except OSError:
        continue
sys.exit(1)
EOF
bash m0/sandbox/run_in_sandbox.sh "$WD" t4.py >/dev/null 2>&1; check "只读挂载写入" $?

echo "passed=$pass failed=$fail"
exit $fail

# ---------------------------------------------------------------------
# 运行回执（2026-09-08, Git Bash + Docker Desktop 27.5.1 WSL2, 镜像 dataplat-script:m0）
# $ bash m0/tests/sandbox_redteam.sh; echo "exit=$?"
# [BLOCKED-OK] 凭据泄漏
# [BLOCKED-OK] 网络外联
# [BLOCKED-OK] 越界写入
# [BLOCKED-OK] 只读挂载写入
# passed=4 failed=0
# exit=0
# ---------------------------------------------------------------------

#!/usr/bin/env bash
# 受控执行：无网络(--network none)、rootfs只读(--read-only)、非root身份、
# 目录白名单(结果/资产只读, workdir可写)、资源上限(mem/cpu/pids)、超时清理(timeout+--rm)
# 本地模拟形态：Docker Desktop on Windows (WSL2 backend)，Git Bash 调用
#
# 用法: RESULTS_DIR=... ASSETS_DIR=... bash run_in_sandbox.sh <workdir> <script> [args...]
set -euo pipefail
WORKDIR="$(cd "$1" && pwd)"; SCRIPT="$2"; shift 2 || true
# SCRIPT 默认相对 /workdir；以 / 开头则按容器内绝对路径执行。
# 真跑金样管线须用 /assets/scripts/build.py（ASSETS_DIR=skill 根）：build.py 以自身
# 位置定位 ../templates/，复制进 workdir 会丢布局 → FileNotFoundError /templates/...
# （实测 2026-09-08）
case "$SCRIPT" in /*) SCRIPT_PATH="$SCRIPT" ;; *) SCRIPT_PATH="/workdir/${SCRIPT}" ;; esac
: "${RESULTS_DIR:?need RESULTS_DIR}"; : "${ASSETS_DIR:?need ASSETS_DIR}"
IMAGE="${SANDBOX_IMAGE:-dataplat-script:m0}"
MEM="${SANDBOX_MEM:-2g}"; CPUS="${SANDBOX_CPUS:-1}"
PIDS="${SANDBOX_PIDS:-64}"; TMO="${SANDBOX_TIMEOUT_S:-120}"

# MSYS(Git Bash) 会把 /results 这类容器内路径参数改写成 Windows 路径——禁掉
export MSYS_NO_PATHCONV=1

# Windows 路径方案（实测定型 2026-09-08，Git Bash 8.32 + Docker Desktop 27.5.1 WSL2）：
# 不用手写转换——Git Bash 自带 cygpath，能正确处理 /d/... 与 /tmp/...（MSYS 挂载点）
# 两种形式；手写 winpath 会把 /tmp/x 错转成不存在的 T:\x。cygpath -w 输出 D:\... 形式，
# Docker Desktop 的 -v 对其直接接受（含 MSYS_NO_PATHCONV=1 时）。冒烟两场景均以
# "-v D:\...:/xxx" 混合形式真跑通过。
winpath() { cygpath -w "$1"; }

# tmpfs /tmp（rw,noexec,nosuid,64m）：--read-only rootfs 下 tempfile 仍可用——
# validate_report.py 的 node 语法检查临时文件、build.py --selftest 的 TemporaryDirectory

# 超时方案（实测 2026-09-08）：Git Bash 的 GNU timeout --signal=KILL 只能杀 docker CLI
# 客户端，守护进程侧容器会残留继续跑（实测留下 Up 状态孤儿容器）——故给容器命名，
# 退出后无条件 docker rm -f 兜底清理；正常路径 --rm 已移除，rm -f 为无害 no-op。
CNAME="m0sandbox-$$-$(date +%s)"
RC=0
timeout --signal=KILL "${TMO}" docker run --rm --name "${CNAME}" \
  --network none \
  --read-only \
  --user 65534:65534 \
  --memory "${MEM}" --cpus "${CPUS}" --pids-limit "${PIDS}" \
  -v "$(winpath "${RESULTS_DIR}"):/results:ro" \
  -v "$(winpath "${ASSETS_DIR}"):/assets:ro" \
  -v "$(winpath "${WORKDIR}"):/workdir" \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  -w /workdir \
  "${IMAGE}" python "${SCRIPT_PATH}" "$@" || RC=$?
docker rm -f "${CNAME}" >/dev/null 2>&1 || true
if [ "${RC}" -eq 124 ] || [ "${RC}" -eq 137 ]; then
  echo "SANDBOX: exit ${RC} — SANDBOX_TIMEOUT_S=${TMO}s 超时被杀（或容器 OOM），容器已强制清理" >&2
fi
exit "${RC}"

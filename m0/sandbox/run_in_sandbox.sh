#!/usr/bin/env bash
# 受控执行：无网络(--network none)、rootfs只读(--read-only)、非root身份、
# 目录白名单(结果/资产只读, workdir可写)、资源上限(mem/cpu/pids)、超时清理(timeout+--rm)
# LIN-1B：Linux 下 ACL 初始化 fail closed——工具缺失/校验不过/授权失败即退出 78，不启动容器
# 本地模拟形态：Docker Desktop on Windows (WSL2 backend)，Git Bash 调用
#
# 用法: RESULTS_DIR=... ASSETS_DIR=... bash run_in_sandbox.sh <workdir> <script> [args...]
# 解释器: SANDBOX_INTERPRETER=bash 时用 bash 执行脚本，默认 python（M0-T13，
# 供 dsh exec_script 工具插件复用；缺省行为与既有调用/红队完全一致）
# 容器名: SANDBOX_RUN_ID=<run_id> [SANDBOX_ATTEMPT=<n>] 时容器名为
#         <run_id>-a<n>-<pid>（M1 网关注入，见下方 CNAME 注释）；未设置时用缺省名
set -euo pipefail
WORKDIR="$(cd "$1" && pwd)"; SCRIPT="$2"; shift 2 || true
# SCRIPT 默认相对 /workdir；以 / 开头则按容器内绝对路径执行。
# 真跑金样管线须用 /assets/scripts/build.py（ASSETS_DIR=skill 根）：build.py 以自身
# 位置定位 ../templates/，复制进 workdir 会丢布局 → FileNotFoundError /templates/...
# （实测 2026-09-08）
case "$SCRIPT" in /*) SCRIPT_PATH="$SCRIPT" ;; *) SCRIPT_PATH="/workdir/${SCRIPT}" ;; esac
: "${RESULTS_DIR:?need RESULTS_DIR}"; : "${ASSETS_DIR:?need ASSETS_DIR}"
IMAGE="${SANDBOX_IMAGE:-dataplat-script:m0}"
INTERP="${SANDBOX_INTERPRETER:-python}"
MEM="${SANDBOX_MEM:-2g}"; CPUS="${SANDBOX_CPUS:-1}"
PIDS="${SANDBOX_PIDS:-64}"; TMO="${SANDBOX_TIMEOUT_S:-120}"
MOUNT_RES="${RESULTS_DIR}"; MOUNT_AST="${ASSETS_DIR}"; MOUNT_WD="${WORKDIR}"

# MSYS(Git Bash) 会把 /results 这类容器内路径参数改写成 Windows 路径——禁掉
export MSYS_NO_PATHCONV=1

# Windows 路径方案（实测定型 2026-09-08，Git Bash 8.32 + Docker Desktop 27.5.1 WSL2）：
# 不用手写转换——Git Bash 自带 cygpath，能正确处理 /d/... 与 /tmp/...（MSYS 挂载点）
# 两种形式；手写 winpath 会把 /tmp/x 错转成不存在的 T:\x。cygpath -w 输出 D:\... 形式，
# Docker Desktop 的 -v 对其直接接受（含 MSYS_NO_PATHCONV=1 时）。冒烟两场景均以
# "-v D:\...:/xxx" 混合形式真跑通过。
winpath() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi
}
# Linux 原生引擎（无 cygpath）直接透传 POSIX 路径——docker -v 原样可用（LIN-1 C4）。

# tmpfs /tmp（rw,noexec,nosuid,64m）：--read-only rootfs 下 tempfile 仍可用——
# validate_report.py 的 node 语法检查临时文件、build.py --selftest 的 TemporaryDirectory

# 超时方案（实测 2026-09-08）：Git Bash 的 GNU timeout --signal=KILL 只能杀 docker CLI
# 客户端，守护进程侧容器会残留继续跑（实测留下 Up 状态孤儿容器）——故给容器命名，
# 退出后无条件 docker rm -f 兜底清理；正常路径 --rm 已移除，rm -f 为无害 no-op。
#
# 容器名（M1-T6，附录 A.1 双活安全）：SANDBOX_RUN_ID（可选，M1 网关注入；dsh
# exec_script 插件从宿主进程环境透传）存在时用 "${run_id}-a${attempt}-$$" 形态——
# 接管者按 run_id + 旧 attempt 清理（docker rm -f <run_id>-a<旧attempt>-*）不会误杀
# 新 attempt 的容器；$$ 兜底并发唯一。未设置时保持 M0 原名（m0sandbox-$$-<epoch>，
# 红队脚本与既有调用不传新变量，行为完全不变）。SANDBOX_ATTEMPT 缺省 0。
if [ -n "${SANDBOX_RUN_ID:-}" ]; then
  CNAME="${SANDBOX_RUN_ID}-a${SANDBOX_ATTEMPT:-0}-$$"
else
  CNAME="m0sandbox-$$-$(date +%s)"
fi
RC=0
ACL_GRANTED=0   # S4-B1：1=已授权（workdir 树 + results/assets），docker 收尾后须恢复基线
if [ "$(uname -s)" = "Linux" ]; then
  # ══ S4-B1r2：任务根校验 → flock → stale 恢复 → ACL 备份 → 授权 →（docker）→ 精确恢复 ══
  # 背景：dsh fs 工具在 Linux 落 0600 文件（属主=服务用户），容器 UID 65534 读不了
  # 脚本 → exec_script 失败。方案：对通过「可信任务根 + 任务身份」双重校验的
  # WORKDIR 树及 RESULTS/ASSETS 目录执行「备份 → u:65534 授权 → docker run →
  # setfacl --restore + 全量内容比对恢复」，闭环后零权限残留。
  # Windows（uname 非 Linux）整段跳过，Docker Desktop 链路零变化。
  #
  # env 来源链（可信服务端配置，模型/Agent 参数不可覆盖）：
  #   systemd EnvironmentFile(/etc/dpit, root:dpit 640) → 网关进程 env → dsh 子进程
  #   （全量注入；消毒正则 KEY|PASSWORD|SECRET|TOKEN|DSH_* 不命中 SANDBOX_*）→
  #   exec-script 插件白名单 → 本 runner。模型唯一可控面是 argv 的 script 与参数
  #   （workdir/results/assets 全部由服务端生成），无法经参数注入本段任何 env。
  #
  # 退出码：78=校验/配置/授权/并发冲突失败（容器未启动）；79=恢复失败（备份保留）。
  command -v setfacl >/dev/null 2>&1 && command -v getfacl >/dev/null 2>&1 \
    || { echo "SANDBOX-FATAL[78]: Linux 下需要 setfacl+getfacl（apt install acl）——拒绝执行" >&2; exit 78; }
  command -v flock >/dev/null 2>&1 \
    || { echo "SANDBOX-FATAL[78]: Linux 下需要 flock（util-linux）——拒绝执行" >&2; exit 78; }
  EUID_N="$(id -u)"

  # ---- A. 任务根校验（先于任何 ACL 修改，含 RESULTS/ASSETS）----------------------
  # 根自身合法性（任一配置根非法即拒绝——配置错误要响，不做静默降级）：
  #   存在且 realpath 可解；深度 ≥4（拒绝 /、/srv、/srv/dpit、/srv/dpit/data 等过宽根，
  #   合法形态如 /srv/dpit/data/gateway）；不在共享系统目录黑名单。
  root_real() { # <configured-root> → echo realpath（合法）或返回 1
    local rr
    rr="$(realpath -e -- "$1" 2>/dev/null)" || return 1
    case "$rr" in
      /|/bin|/boot|/dev|/etc|/home|/lib|/lib64|/media|/mnt|/opt|/proc|/root|/run|/sbin|/srv|/sys|/tmp|/usr|/var|/var/tmp|"${TMPDIR:-__none__}") return 1 ;;
    esac
    [ "$(printf '%s' "$rr" | tr -cd '/' | wc -c)" -ge 4 ] || return 1
    printf '%s' "$rr"
  }
  [ -n "${SANDBOX_TASK_ROOTS:-}" ] \
    || { echo "SANDBOX-FATAL[78]: 未配置 SANDBOX_TASK_ROOTS（授权任务根，冒号分隔绝对路径）——拒绝执行" >&2; exit 78; }
  ROOTS_RESOLVED=""
  _ifs_save="$IFS"; IFS=:
  for _r in ${SANDBOX_TASK_ROOTS}; do
    [ -z "$_r" ] && continue
    _rr="$(root_real "$_r")" \
      || { echo "SANDBOX-FATAL[78]: 非法任务根（过宽/不存在）：${_r}——拒绝执行" >&2; exit 78; }
    ROOTS_RESOLVED="${ROOTS_RESOLVED:+${ROOTS_RESOLVED}:}${_rr}"
  done
  IFS="$_ifs_save"

  # 通用：path 是否落在已解析根集合内 / 命中哪个根（全路径前缀比对，非目录名匹配）
  in_roots() { # <resolved-roots(冒号分隔)> <resolved-path>
    local roots="$1" p="$2" r
    [ -n "${roots}" ] || return 1
    local IFS=:
    for r in ${roots}; do
      [ "$p" = "$r" ] && return 0
      case "$p" in "$r"/*) return 0 ;; esac
    done
    return 1
  }
  matched_root_of() { # <resolved-roots> <path> → echo 命中根（无命中输出空串；根列表有序→结果确定）
    local roots="$1" p="$2" r
    local IFS=:
    for r in ${roots}; do
      [ "$p" = "$r" ] && { printf '%s' "$r"; return 0; }
      case "$p" in "$r"/*) printf '%s' "$r"; return 0 ;; esac
    done
    return 0
  }
  WD_REAL="$(realpath -e -- "${WORKDIR}" 2>/dev/null)" \
    || { echo "SANDBOX-FATAL[78]: WORKDIR 不存在或不可解析：${WORKDIR}" >&2; exit 78; }
  RES_REAL="$(realpath -e -- "${RESULTS_DIR}" 2>/dev/null)" \
    || { echo "SANDBOX-FATAL[78]: RESULTS_DIR 不存在或不可解析：${RESULTS_DIR}" >&2; exit 78; }
  AST_REAL="$(realpath -e -- "${ASSETS_DIR}" 2>/dev/null)" \
    || { echo "SANDBOX-FATAL[78]: ASSETS_DIR 不存在或不可解析：${ASSETS_DIR}" >&2; exit 78; }
  # A1/A4：workdir 与 results 分别须落在授权任务根内，且**出自同一命中的根**（同一
  # 受信数据根下的工作区/结果区——生产布局 /srv/dpit/data/gateway 的 work/ 与
  # results/ 子树）；跨根拼接（各自命中不同合法根）在此被拒。
  if ! in_roots "${ROOTS_RESOLVED}" "${WD_REAL}"; then
    echo "SANDBOX-FATAL[78]: workdir（${WD_REAL}）不在 SANDBOX_TASK_ROOTS 授权任务根内——拒绝执行" >&2
    exit 78
  fi
  if ! in_roots "${ROOTS_RESOLVED}" "${RES_REAL}"; then
    echo "SANDBOX-FATAL[78]: results（${RES_REAL}）不在 SANDBOX_TASK_ROOTS 授权任务根内——拒绝执行" >&2
    exit 78
  fi
  MATCHED_ROOT="$(matched_root_of "${ROOTS_RESOLVED}" "${WD_REAL}")"
  [ "${MATCHED_ROOT}" = "$(matched_root_of "${ROOTS_RESOLVED}" "${RES_REAL}")" ] \
    || { echo "SANDBOX-FATAL[78]: workdir 与 results 须出自同一授权任务根（workdir 根=${MATCHED_ROOT} ≠ results 根）——拒绝跨根拼接" >&2; exit 78; }
  # A4 辅助：父目录名一致（生产/e2e 布局该层即 <sessionId>）；两树互不包含
  # （拒绝 results 树下挂 workdir 一类的混合拼接形态）。
  _idw="$(basename "$(dirname "${WD_REAL}")")"
  _idr="$(basename "$(dirname "${RES_REAL}")")"
  [ "${_idw}" = "${_idr}" ] \
    || { echo "SANDBOX-FATAL[78]: 任务身份不一致（workdir 父=${_idw} ≠ results 父=${_idr}）——疑似跨任务拼接，拒绝执行" >&2; exit 78; }
  case "${WD_REAL}" in "${RES_REAL}"|"${RES_REAL}"/*)
    echo "SANDBOX-FATAL[78]: WORKDIR 位于 results 树内（${WD_REAL} ⊆ ${RES_REAL}）——拒绝执行" >&2; exit 78 ;; esac
  case "${RES_REAL}" in "${WD_REAL}"/*)
    echo "SANDBOX-FATAL[78]: results 位于 WORKDIR 树内（${RES_REAL} ⊆ ${WD_REAL}）——拒绝执行" >&2; exit 78 ;; esac
  # A3：assets 须属「可信只读资产根（SANDBOX_ASSETS_ROOTS，冒号分隔）或授权任务根」
  # ——生产 assets 常在代码仓 skills/ 下（只读白名单资产），故独立配置面。资产根同受
  # root_real 校验；深度≥4 仅是防误配置的辅助护栏，授权本体始终是显式配置清单，
  # 不以路径深度替代真实授权根校验。
  ASSETS_ROOTS_RESOLVED=""
  if [ -n "${SANDBOX_ASSETS_ROOTS:-}" ]; then
    _ifs2="$IFS"; IFS=:
    for _r in ${SANDBOX_ASSETS_ROOTS}; do
      [ -z "$_r" ] && continue
      _rr="$(root_real "$_r")" \
        || { echo "SANDBOX-FATAL[78]: 非法资产根（过宽/不存在）：${_r}——拒绝执行" >&2; exit 78; }
      ASSETS_ROOTS_RESOLVED="${ASSETS_ROOTS_RESOLVED:+${ASSETS_ROOTS_RESOLVED}:}${_rr}"
    done
    IFS="$_ifs2"
  fi
  if ! in_roots "${ROOTS_RESOLVED}" "${AST_REAL}" && ! in_roots "${ASSETS_ROOTS_RESOLVED}" "${AST_REAL}"; then
    echo "SANDBOX-FATAL[78]: assets（${AST_REAL}）不在 SANDBOX_ASSETS_ROOTS/SANDBOX_TASK_ROOTS 内——拒绝执行" >&2
    exit 78
  fi
  MOUNT_RES="${RES_REAL}"; MOUNT_AST="${AST_REAL}"; MOUNT_WD="${WD_REAL}"   # 挂载已校验的真实路径

  # ---- B. 专用状态目录 + flock ---------------------------------------------------
  # 状态目录默认在「命中的任务根」（A4 同根绑定的 MATCHED_ROOT）之下（服务用户属地，
  # 0700，不依赖共享 /tmp）；可用 SANDBOX_ACL_STATE_DIR 覆盖（须同样通过属主/非符号链接校验）。
  ACL_STATE_DIR="${SANDBOX_ACL_STATE_DIR:-${MATCHED_ROOT}/.sandbox-acl-state}"
  mkdir -p "${ACL_STATE_DIR}" 2>/dev/null \
    || { echo "SANDBOX-FATAL[78]: ACL 状态目录不可建：${ACL_STATE_DIR}" >&2; exit 78; }
  chmod 700 "${ACL_STATE_DIR}" 2>/dev/null || true
  # 防符号链接劫持：目录须为本用户所有、自身非链接、realpath 与字面一致（链上无链接段）
  [ -O "${ACL_STATE_DIR}" ] && [ ! -L "${ACL_STATE_DIR}" ] \
    && [ "$(realpath -e -- "${ACL_STATE_DIR}" 2>/dev/null)" = "${ACL_STATE_DIR}" ] \
    || { echo "SANDBOX-FATAL[78]: ACL 状态目录不安全（非本用户所有/为符号链接/路径含符号链接段）：${ACL_STATE_DIR}" >&2; exit 78; }
  ACL_KEY="$(printf '%s' "${WD_REAL}" | sha256sum | cut -c1-16)"
  ACL_LOCK="${ACL_STATE_DIR}/${ACL_KEY}.lock"
  ACL_BAK="${ACL_STATE_DIR}/${ACL_KEY}.acl.bak"
  ACL_SNAP="${ACL_STATE_DIR}/${ACL_KEY}.acl.snap"
  for _f in "${ACL_LOCK}" "${ACL_BAK}" "${ACL_SNAP}"; do
    if [ -e "$_f" ] && [ -L "$_f" ]; then
      echo "SANDBOX-FATAL[78]: 状态文件为符号链接（疑似劫持）：${_f}——拒绝执行" >&2; exit 78
    fi
  done
  exec 9>>"${ACL_LOCK}" 2>/dev/null \
    || { echo "SANDBOX-FATAL[78]: 任务锁文件不可写：${ACL_LOCK}" >&2; exit 78; }
  # 非阻塞：同 workdir 已有在跑任务（持锁）→ 立即拒绝，不等待（在跑任务 ACL 不可被
  # 第三方触碰；stale 判定亦以持锁为前提——持锁后发现的备份必为前次 SIGKILL 残留）。
  flock -n 9 \
    || { echo "SANDBOX-FATAL[78]: 同 workdir 已有任务在跑（锁 ${ACL_KEY}）——并发冲突拒绝执行" >&2; exit 78; }

  # ---- C. ACL 备份/授权/恢复原语 --------------------------------------------------
  # 授权与备份仅覆盖「本任务树内、当前用户拥有的普通文件/目录」：-uid 属主过滤（容器
  # 自建的 65534 文件天然跳过）、-xdev 不跨文件系统、symlink/socket/fifo/device 天然
  # 排除（-type f/d）。文件只读授权（u:65534:r--），目录按写入语义（u:65534:rwx）。
  acl_entries() { getfacl -c --absolute-names -- "$1" 2>/dev/null | paste -sd, -; }
  acl_find() { # <dir> <d|f>：属主过滤 + 稳定序（C locale sort）
    find "$1" -xdev -uid "${EUID_N}" -type "$2" -print0 | LC_ALL=C sort -z
  }
  acl_verify() { # <snapshot-file>：全量内容级比对（所有 ACL 条目：named/default/mask/
    # other/基础位——绝非只数条目或只看 65534）；快照内已消失的路径=任务期间合法删除，跳过
    local ok=0 p _t a cur
    while IFS="$(printf '\t')" read -r p _t a; do
      [ -e "$p" ] || continue
      cur="$(acl_entries "$p")"
      if [ "$cur" != "$a" ]; then
        echo "SANDBOX: ACL 恢复校验不一致：${p}（期望[${a}] 实际[${cur}]）" >&2
        ok=1
      fi
    done < "$1"
    return "$ok"
  }
  acl_backup() { # workdir 树（目录先、文件后——首行必为 workdir 根）+ results/assets 目录
    #               → .bak（setfacl --restore 全量格式：named/default/mask/owner/group 全含）
    #               → .snap（<path>\t<d|f>\t<条目逗号拼接> 规范化快照）
    # 管道形态 + 脚本级 pipefail：find/sort 任一失败即令本函数非零（缺陷2 防护——
    # process substitution 会吞掉上游退出码，弃用）；循环体只做文件追加，不受子 shell 影响。
    : > "${ACL_BAK}"; : > "${ACL_SNAP}"
    local p
    acl_find "${WD_REAL}" d | while IFS= read -r -d '' p; do
      getfacl --absolute-names -- "$p" >> "${ACL_BAK}" 2>/dev/null
      printf '%s\t%s\t%s\n' "$p" "d" "$(acl_entries "$p")" >> "${ACL_SNAP}"
    done || return 1
    acl_find "${WD_REAL}" f | while IFS= read -r -d '' p; do
      getfacl --absolute-names -- "$p" >> "${ACL_BAK}" 2>/dev/null
      printf '%s\t%s\t%s\n' "$p" "f" "$(acl_entries "$p")" >> "${ACL_SNAP}"
    done || return 1
    for p in "${RES_REAL}" "${AST_REAL}"; do
      getfacl --absolute-names -- "$p" >> "${ACL_BAK}" 2>/dev/null
      printf '%s\t%s\t%s\n' "$p" "d" "$(acl_entries "$p")" >> "${ACL_SNAP}"
    done
  }
  acl_backup_valid() { # 防空备份/坏备份被当成功：两文件非空 + 快照首行必为 workdir 根
    [ -s "${ACL_BAK}" ] && [ -s "${ACL_SNAP}" ] \
      && [ "$(head -n 1 "${ACL_SNAP}" | cut -f 1)" = "${WD_REAL}" ]
  }
  acl_rollback() { # 恢复（覆盖 workdir 树 + results/assets）+ 全量校验 + 清备份
    setfacl --restore="${ACL_BAK}" 2>/dev/null && acl_verify "${ACL_SNAP}" \
      && rm -f "${ACL_BAK}" "${ACL_SNAP}" && return 0
    return 1
  }

  # ---- stale 备份（仅在持锁后）：残留备份必为前次异常退出残留，先恢复基线再继续 ----
  if [ -e "${ACL_BAK}" ] || [ -e "${ACL_SNAP}" ]; then
    if acl_backup_valid; then
      echo "SANDBOX: 检测到上次异常退出的 ACL 备份——先恢复基线（${ACL_BAK}）" >&2
      if ! acl_rollback; then
        echo "SANDBOX-FATAL[79]: stale ACL 备份恢复失败——备份保留（${ACL_BAK} + .snap），人工核查后处理，拒绝继续" >&2
        exit 79
      fi
    else
      echo "SANDBOX-FATAL[79]: 残留备份对无效（空/损坏/首行非本任务根）——备份保留（${ACL_BAK} + .snap），人工核查，拒绝继续" >&2
      exit 79
    fi
  fi

  # ---- 备份 → 授权（闭环含 results/assets——不留未管理的权限残留）------------------
  acl_backup || { echo "SANDBOX-FATAL[78]: ACL 备份失败（${WD_REAL}）——未授权，拒绝执行" >&2; exit 78; }
  acl_backup_valid \
    || { echo "SANDBOX-FATAL[78]: ACL 备份内容无效（空或缺 workdir 根记录）——拒绝执行" >&2; exit 78; }
  _gf=0
  acl_find "${WD_REAL}" d | xargs -0 -r setfacl -m u:65534:rwx || _gf=1
  acl_find "${WD_REAL}" f | xargs -0 -r setfacl -m u:65534:r-- || _gf=1
  setfacl -m u:65534:rX "${RES_REAL}" || _gf=1   # :ro 挂载：目录遍历读
  setfacl -m u:65534:rX "${AST_REAL}" || _gf=1
  if [ "${_gf}" -ne 0 ]; then
    echo "SANDBOX-FATAL[78]: ACL 授权失败——立即回滚" >&2
    if ! acl_rollback; then
      echo "SANDBOX-FATAL[79]: 授权失败后的回滚亦失败——备份保留（${ACL_BAK} + .snap）" >&2
      exit 79
    fi
    exit 78
  fi
  ACL_GRANTED=1
fi
timeout --signal=KILL "${TMO}" docker run --rm --name "${CNAME}" \
  --network none \
  --read-only \
  --user 65534:65534 \
  --memory "${MEM}" --cpus "${CPUS}" --pids-limit "${PIDS}" \
  -v "$(winpath "${MOUNT_RES}"):/results:ro" \
  -v "$(winpath "${MOUNT_AST}"):/assets:ro" \
  -v "$(winpath "${MOUNT_WD}"):/workdir" \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  -w /workdir \
  "${IMAGE}" "${INTERP}" "${SCRIPT_PATH}" "$@" || RC=$?
docker rm -f "${CNAME}" >/dev/null 2>&1 || true
if [ "${RC}" -eq 124 ] || [ "${RC}" -eq 137 ]; then
  echo "SANDBOX: exit ${RC} — SANDBOX_TIMEOUT_S=${TMO}s 超时被杀（或容器 OOM），容器已强制清理" >&2
fi
if [ "${ACL_GRANTED}" -eq 1 ]; then
  # S4-B1：恢复基线（workdir 树 + results/assets；仍持 flock）。失败 → 保留备份 +
  # exit 79（恢复失败优先于容器退出码上报——权限面残留比任务失败更严重）
  if ! acl_rollback; then
    echo "SANDBOX-FATAL[79]: ACL 恢复失败——备份保留（${ACL_BAK} + .snap）；容器退出码 ${RC} 被 79 覆盖" >&2
    exit 79
  fi
fi
exit "${RC}"

# insight/detectors/base.py
"""Detector 契约（spec §7 + 裁定 #12）：detect(run, ctx) 只返回越阈 Finding；
未越阈中间计算不进 findings 主数据流（diagnostics 未来另设，不混入）。

DetectResult.status 语义：ok=检测正常完成；not_ready/insufficient_history=
依赖数据不足，当日不产出 finding（数据未就绪≠无异常，spec 诚实性红线）。
（超时自降级 unavailable 属 M-i2 runner 编排层，不在 detect() 返回内。）"""
import json
from dataclasses import dataclass, field
from pathlib import Path

CONFIG_DIR = Path(__file__).parent.parent / "config"

def load_config(name: str, root: Path | None = None) -> dict:
    return json.loads(((root or CONFIG_DIR) / f"radar-{name}.json")
                      .read_text(encoding="utf-8"))

@dataclass
class Finding:
    detector: str
    data_date: str            # ctx.as_of.isoformat()（canonical 输出形态）
    dim_keys: dict            # {anchor_type, anchor_id, channel}
    metrics: dict
    norm_score: int
    threshold_passed: bool = True   # 契约收紧后恒 True（detect 只产越阈）
    is_late: bool = False
    facets: dict = field(default_factory=dict)

@dataclass
class DetectResult:
    detector: str
    status: str               # ok | not_ready | insufficient_history
    note: str = ""
    findings: list = field(default_factory=list)

def percentile_score(value: float, baseline: list[float]) -> int:
    """0-100 标准化（端点钉死）：基线最小值→0，最大值→100，超出上界截到 100（下界自然为 0）；
    空/单点基线无分布信息→50。"""
    if len(baseline) < 2:
        return 50
    s = sorted(baseline)
    return min(100, round(100 * sum(1 for b in s if b < value) / (len(s) - 1)))

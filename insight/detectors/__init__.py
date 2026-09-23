"""雷达注册表。"""
from .region_sales import RegionSalesDetector
from .gross_margin import GrossMarginDetector
from .ar_risk import ArRiskDetector
from .target import TargetDetector

REGISTRY = {"region_sales": RegionSalesDetector, "gross_margin": GrossMarginDetector,
            "ar_risk": ArRiskDetector, "target": TargetDetector}

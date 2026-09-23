"""雷达注册表。"""
from .region_sales import RegionSalesDetector
from .gross_margin import GrossMarginDetector

REGISTRY = {"region_sales": RegionSalesDetector, "gross_margin": GrossMarginDetector}

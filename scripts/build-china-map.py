# scripts/build-china-map.py
"""M-i8 地图资产管线（spec 2026-10-06 §5/D-r6）：DataV 省界 GeoJSON → 内嵌 SVG path 资产。

用法：python scripts/build-china-map.py <输入geojson> <输出ts>
  输入：geo.datav.aliyun.com/areas_v3/bound/100000_full.json（curl 下载）
  输出：dataplat-ui/web/src/assets/china-map.ts（CHINA_PROVINCES + NAME_LOOKUP + NINE_DASH）
投影：等经纬 + 纬度纵横比较正（y×1/cos35°），viewBox 800 宽；坐标简化到 0.1 单位；
  面积过小的屿（bbox<0.15°）丢弃防噪。九段线（100000_JD）单独导出。
生成物入 dataplat-ui 仓（一次性资产，改动需重跑本脚本）。"""
import json
import sys

LNG0, LAT0 = 73.0, 54.5          # 左上原点（经、纬）
K = 800 / (135.5 - 73.0)         # 经度满幅 800
YSCALE = 1.0 / 0.8192            # cos(35°) 纵横校正


def to_svg(lng, lat):
    return (round((lng - LNG0) * K, 1), round((LAT0 - lat) * K * YSCALE, 1))


def ring_to_path(ring):
    pts = [to_svg(lng, lat) for lng, lat in ring]
    return "M" + "L".join(f"{x} {y}" for x, y in pts) + "Z"


def simplify(geometry):
    """多环 → path 串；丢小屿。返回 (path, [ring...]) 供 bbox/centroid。"""
    rings = []
    polys = geometry["coordinates"] if geometry["type"] == "MultiPolygon" else [geometry["coordinates"]]
    for poly in polys:
        ring = poly[0]                       # 外环即可（内环=湖泊细部，视觉可省）
        lngs = [p[0] for p in ring]
        lats = [p[1] for p in ring]
        if max(lngs) - min(lngs) < 0.15 and max(lats) - min(lats) < 0.15:
            continue                          # 小屿防噪
        rings.append(ring)
    return "".join(ring_to_path(r) for r in rings), rings


def norm_name(full):
    """DataV 全名 → mix 短名（'广东省'→'广东'；自治区/直辖市特例）。"""
    for suf in ("壮族自治区", "回族自治区", "维吾尔自治区", "自治区", "特别行政区"):
        if full.endswith(suf):
            return full[: -len(suf)]
    return full.rstrip("省市")


def main(src, dst):
    d = json.load(open(src, encoding="utf-8"))
    provinces, lookup, nine_dash = [], {}, ""
    for f in d["features"]:
        props = f["properties"]
        name, adcode = props.get("name"), props.get("adcode")
        if name is None or adcode is None:
            continue
        path, rings = simplify(f["geometry"])
        if not rings:
            continue
        all_pts = [p for r in rings for p in r]
        cx = (min(p[0] for p in all_pts) + max(p[0] for p in all_pts)) / 2
        cy = (min(p[1] for p in all_pts) + max(p[1] for p in all_pts)) / 2
        if str(adcode) == "100000" or "JD" in str(adcode):
            nine_dash = path
            continue
        provinces.append({"name": name, "adcode": adcode, "path": path,
                          "centroid": [round(cx, 1), round(cy, 1)]})
        short = norm_name(name)
        lookup[short] = adcode
        lookup[name] = adcode
    out = ["// 本文件由 harness scripts/build-china-map.py 生成（DataV 公开省界，勿手改）",
           f"// 生成自 100000_full.json；单位 {len(provinces)} + 九段线",
           "export interface ProvincePath { name: string; adcode: number; path: string; centroid: [number, number]; }",
           f"export const VIEWBOX = [0, 0, 800, {round((LAT0 - 18.0) * (800 / 62.5) * 1.2207, 0)}];",
           f"export const CHINA_PROVINCES: ProvincePath[] = {json.dumps(provinces, ensure_ascii=False, separators=(',', ':'))};",
           f"export const NAME_LOOKUP: Record<string, number> = {json.dumps(lookup, ensure_ascii=False, separators=(',', ':'))};",
           f"export const NINE_DASH = {json.dumps(nine_dash)};",
           ""]
    open(dst, "w", encoding="utf-8", newline="\n").write("\n".join(out))
    print(f"provinces={len(provinces)} lookup={len(lookup)} bytes={len('\\n'.join(out))}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])

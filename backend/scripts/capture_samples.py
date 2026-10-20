"""Dev-only: capture raw Flipkart responses to map field paths (price, cancel, replacement, refund).

Writes to backend/.samples/ (gitignored — it holds customer PII). Never commit its output; derive
synthetic, PII-free fixtures from the shapes instead.

Usage (from backend/):
    python -m scripts.capture_samples --cookie ../docs/cookies/<cookie-editor-export>.json

Outputs:
    orders.json                  raw order list (all pages)
    detail-<category>-<n>.json   raw order-detail page per sampled unit
    headings.txt                 unit status headings with counts (which lifecycle states exist)
    paths.txt                    key paths matching lifecycle/price keywords, with PII-safe samples
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

from app import flipkart, parser, store

OUT = Path(__file__).resolve().parent.parent / ".samples"

KEYWORDS = re.compile(
    r"price|amount|paid|payable|refund|cancel|replac|exchange|return|date|time|tracker|timeline|step|status",
    re.I,
)
# Path segments whose values are personal data: print the type only, never the value.
PII_KEYS = re.compile(r"name|address|phone|mobile|email|pin|landmark|city|state|locality|gst|token|id$", re.I)
# Dynamic map keys (unit ids, listing ids, FSNs) collapse to "*" so paths group across orders.
DYNAMIC_KEY = re.compile(r"^(\d{6,}|[A-Z0-9]{12,}|LST[A-Z0-9]+)$")


def classify(heading: str) -> str:
    h = heading.lower()
    if "refund" in h:
        return "refund"
    if re.search(r"replac|exchange", h):
        return "replacement"
    if "return" in h:
        return "return"
    return {
        "CANCELLED": "cancelled",
        "OUT_FOR_DELIVERY": "active",
        "ARRIVING": "active",
        "DELIVERED": "delivered",
    }.get(parser.map_status(heading), "other")


def _safe_sample(path: str, value) -> str:
    if PII_KEYS.search(path.rsplit(".", 1)[-1]):
        return f"<{type(value).__name__}>"
    if isinstance(value, str):
        return repr(re.sub(r"\d{10,}", "<num>", value)[:80])
    return repr(value)


def collect_paths(node, path: str, out: dict) -> None:
    if isinstance(node, dict):
        for k, v in node.items():
            key = "*" if DYNAMIC_KEY.match(str(k)) else str(k)
            collect_paths(v, f"{path}.{key}" if path else key, out)
    elif isinstance(node, list):
        for item in node[:200]:
            collect_paths(item, f"{path}[]", out)
    else:
        entry = out.setdefault(path, {"count": 0, "samples": []})
        entry["count"] += 1
        sample = _safe_sample(path, node)
        if sample not in entry["samples"] and len(entry["samples"]) < 4:
            entry["samples"].append(sample)


def write_paths(sections: dict[str, dict], dest: Path) -> None:
    lines: list[str] = []
    for title, paths in sections.items():
        lines.append(f"===== {title}")
        for p in sorted(paths):
            e = paths[p]
            text_hit = any(KEYWORDS.search(s) for s in e["samples"] if s.startswith("'"))
            if KEYWORDS.search(p) or text_hit:
                lines.append(f"{p}  [n={e['count']}]  {' | '.join(e['samples'])}")
    dest.write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cookie", required=True, help="Cookie-Editor JSON export / raw cookie header file")
    ap.add_argument("--per-category", type=int, default=3, help="detail pages to capture per category")
    ap.add_argument("--out", help="output dir (default: backend/.samples/<cookie file stem>)")
    args = ap.parse_args()

    global OUT
    OUT = Path(args.out) if args.out else OUT / Path(args.cookie).stem
    cookies = store.to_cookie_dict(store.normalize_cookie_input(Path(args.cookie).read_text(encoding="utf-8")))
    OUT.mkdir(parents=True, exist_ok=True)

    orders, partial = flipkart.fetch_orders(cookies)
    (OUT / "orders.json").write_text(json.dumps(orders), encoding="utf-8")
    print(f"orders: {len(orders)} (partial={partial})")

    headings: Counter[str] = Counter()
    picks: dict[str, list[tuple[dict, str, dict]]] = defaultdict(list)
    for order in orders:
        units = parser.get(order, "units")
        if not isinstance(units, dict):
            continue
        order_cats = set()
        for unit_id, unit in units.items():
            heading = str(parser.get(unit, "metaData.moRedesignHeading") or "")
            headings[heading] += 1
            order_cats.add(classify(heading))
        for cat in order_cats:
            if len(picks[cat]) < args.per_category:
                # Capture EVERY unit of the order so a replacement and its original sit side by side.
                for unit_id, unit in units.items():
                    picks[cat].append((order, unit_id, unit))

    (OUT / "headings.txt").write_text(
        "\n".join(f"{n:5d}  {h!r}" for h, n in headings.most_common()), encoding="utf-8"
    )

    sections: dict[str, dict] = {}
    order_paths: dict = {}
    collect_paths(orders, "orders", order_paths)
    sections["orders list"] = order_paths

    failures = 0
    for cat, items in picks.items():
        detail_paths: dict = {}
        for n, (order, unit_id, _unit) in enumerate(items, start=1):
            order_id = str(parser.get(order, "orderMetaData.orderId") or "")
            share = str(parser.get(order, "accessToOrderDataBag.endUser.id") or "")
            try:
                raw = flipkart.fetch_detail_raw(cookies, order_id, unit_id, share)
            except Exception as err:  # keep capturing the rest, but report it
                failures += 1
                print(f"  detail {cat}#{n} failed: {err}", file=sys.stderr)
                continue
            (OUT / f"detail-{cat}-{n}.json").write_text(json.dumps(raw), encoding="utf-8")
            collect_paths(raw, "detail", detail_paths)
        sections[f"detail: {cat} ({len(items)} units)"] = detail_paths
        print(f"category {cat}: {len(items)} units captured")

    write_paths(sections, OUT / "paths.txt")
    print(f"wrote {OUT} (detail failures: {failures})")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())

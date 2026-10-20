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
    addons.txt                   add-on units (trust shield, memberships) vs the product units of the
                                 same orders: every key path, so the add-on marker stands out
    invoice.txt                  every detail-page node that mentions an invoice/download/pdf, with
                                 its sibling keys (the action shape); ids and URL query values masked
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
    r"price|amount|paid|payable|refund|cancel|replac|exchange|return|date|time|tracker|timeline|step|status"
    r"|invoice|download|pdf|document|bill|vas|shield|addon",
    re.I,
)
INVOICE_HINT = re.compile(r"invoice|download|pdf", re.I)
# Ids inside URLs / action params (order, unit, listing ids, tokens) are masked in invoice.txt.
_ID_RUN = re.compile(r"\b(?:OD\d+|\d{6,}|[A-Za-z0-9_-]{16,})\b")
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


def _mask_text(value: str) -> str:
    """URL query values and id-like runs -> placeholders, keeping the URL/route shape readable."""
    return _ID_RUN.sub("<id>", re.sub(r"=([^&#\s]*)", "=<v>", value))[:160]


def _is_addon_candidate(order: dict, unit: dict) -> bool:
    """What the parser already skips, plus any unit titled like an add-on: a new add-on kind that
    lacks every known marker shows up here (a bare "shield" would also catch e.g. SSD products)."""
    return parser.is_addon(unit) or "trust shield" in parser._product_title(order, unit).lower()


def write_addons(orders: list, dest: Path) -> int:
    """Key paths of add-on units next to the product units of the SAME orders, plus the paths that
    exist only on add-ons or whose samples differ — the add-on marker is among those."""
    addon_paths: dict = {}
    product_paths: dict = {}
    addon_products: dict = {}
    found = 0
    for order in orders:
        units = parser.get(order, "units")
        if not isinstance(units, dict) or not any(_is_addon_candidate(order, u) for u in units.values()):
            continue
        bag = parser.get(order, "productDataBag") or {}
        for unit in units.values():
            if _is_addon_candidate(order, unit):
                found += 1
                collect_paths(unit, "unit", addon_paths)
                listing = str(parser.get(unit, "metaData.listingId") or parser.get(unit, "metaData.fsn") or "")
                if isinstance(bag, dict) and isinstance(bag.get(listing), dict):
                    collect_paths(bag[listing], "productDataBag.*", addon_products)
            else:
                collect_paths(unit, "unit", product_paths)

    def fmt(paths: dict, p: str) -> str:
        e = paths[p]
        return f"{p}  [n={e['count']}]  {' | '.join(e['samples'])}"

    lines = [f"add-on units found: {found}", "", "===== paths ONLY on add-on units"]
    lines += [fmt(addon_paths, p) for p in sorted(addon_paths) if p not in product_paths]
    lines += ["", "===== shared paths whose samples differ (add-on | product)"]
    for p in sorted(set(addon_paths) & set(product_paths)):
        a, b = addon_paths[p]["samples"], product_paths[p]["samples"]
        if a != b:
            lines.append(f"{p}  ADDON {' | '.join(a)}  ||  PRODUCT {' | '.join(b)}")
    lines += ["", "===== paths ONLY on product units"]
    lines += [fmt(product_paths, p) for p in sorted(product_paths) if p not in addon_paths]
    lines += ["", "===== add-on product entries (productDataBag)"]
    lines += [fmt(addon_products, p) for p in sorted(addon_products)]
    dest.write_text("\n".join(lines), encoding="utf-8")
    return found


def find_invoice_nodes(node, path: str, out: list[str]) -> None:
    """Every dict that has an invoice-ish key or string value: its path and sibling keys (masked)."""
    if isinstance(node, dict):
        hit = any(INVOICE_HINT.search(str(k)) for k in node) or any(
            isinstance(v, str) and INVOICE_HINT.search(v) for v in node.values()
        )
        if hit:
            fields = []
            for k, v in node.items():
                if isinstance(v, (dict, list)):
                    fields.append(f"{k}=<{type(v).__name__}>")
                elif PII_KEYS.search(str(k)) and not re.search(r"url|uri|type|action|label|text|title", str(k), re.I):
                    fields.append(f"{k}=<{type(v).__name__}>")
                else:
                    fields.append(f"{k}={_mask_text(str(v))!r}")
            out.append(f"{path}  {{{', '.join(fields)}}}")
        for k, v in node.items():
            key = "*" if DYNAMIC_KEY.match(str(k)) else str(k)
            find_invoice_nodes(v, f"{path}.{key}" if path else key, out)
    elif isinstance(node, list):
        for item in node[:200]:
            find_invoice_nodes(item, f"{path}[]", out)


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
    print(f"add-on units: {write_addons(orders, OUT / 'addons.txt')}")

    failures = 0
    invoice_nodes: list[str] = []
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
            found: list[str] = []
            find_invoice_nodes(raw, "detail", found)
            invoice_nodes += [f"[{cat}#{n}] {line}" for line in found]
        sections[f"detail: {cat} ({len(items)} units)"] = detail_paths
        print(f"category {cat}: {len(items)} units captured")

    (OUT / "invoice.txt").write_text("\n".join(invoice_nodes) or "no invoice/download/pdf nodes", encoding="utf-8")
    print(f"invoice nodes: {len(invoice_nodes)}")
    write_paths(sections, OUT / "paths.txt")
    print(f"wrote {OUT} (detail failures: {failures})")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())

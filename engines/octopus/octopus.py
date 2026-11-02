"""
Octopus core — cross-venue price graph + arbitrage gap detection.

Pure stdlib, pure functions, no I/O. This is the algo layer the
Minutely "octopus" lane calls: many arms (venues), one brain —
every price the app can reach, linked into a single graph, and the
best route (direct or via an intermediate asset) found for any pair.

Contract (coordinate by this, nothing else):

    build_graph(quotes) -> graph
        quotes: iterable of {
            "venue": str,          # who publishes this price
            "base":  str,          # the asset being priced
            "quote": str,          # what it is priced IN
            "price": float > 0,    # units of `quote` per 1 `base`
        }
        "Priced in other stuff" is the normal case, not an error:
        a pump curve quoted in SPCX, a pool quoted in WSOL, a venue
        quoting in its own token — all become graph edges here.

    find_gaps(graph, min_net_bps, *, leg_cost_bps=DEFAULT_LEG_COST_BPS)
        -> [gap, ...] ranked by net_bps descending.
        A gap: the best two-hop route A -> X -> B beats the best
        direct A -> B price by more than min_net_bps AFTER stated
        per-leg costs. Costs are inputs, never hidden constants —
        the default is printed in every result as `leg_cost_bps`.

    convert(amount, src, dst, graph, *, max_hops=2) -> dict | None
        Best-rate conversion path for integrations denominated in
        other assets; None when no honest path exists (never a
        fabricated rate).

Graph shape (plain dicts, JSON-friendly):
    graph = {
        "assets": sorted [str],
        "edges": { (src, dst): {"rate": float, "venue": str} },  # best per pair
    }
Rates are directional: edge (A, B) rate r means 1 A = r B.
Every quote contributes both directions (r and 1/r) for its venue,
and the graph keeps the BEST rate per directed pair across venues.

Real-or-loud: a malformed quote raises ValueError. Nothing here
invents a price: no path in the graph, no answer.
"""

from __future__ import annotations

import math

DEFAULT_LEG_COST_BPS = 30.0  # stated default: per-leg venue+slippage cost assumption


def _validate_quote(q, idx):
    if not isinstance(q, dict):
        raise ValueError(f"quote #{idx}: must be an object, got {type(q).__name__}")
    for field in ("venue", "base", "quote"):
        v = q.get(field)
        if not isinstance(v, str) or not v.strip():
            raise ValueError(f"quote #{idx}: {field!r} must be a non-empty string")
    price = q.get("price")
    if isinstance(price, bool) or not isinstance(price, (int, float)):
        raise ValueError(f"quote #{idx}: 'price' must be a number")
    price = float(price)
    if not math.isfinite(price) or price <= 0:
        raise ValueError(f"quote #{idx}: 'price' must be finite and > 0, got {price!r}")
    if q["base"] == q["quote"]:
        raise ValueError(f"quote #{idx}: base and quote are the same asset ({q['base']!r})")
    return q["venue"], q["base"], q["quote"], price


def build_graph(quotes):
    """Quotes -> the best-rate directed price graph (see module contract)."""
    edges = {}
    assets = set()
    for idx, q in enumerate(quotes):
        venue, base, quote, price = _validate_quote(q, idx)
        assets.add(base)
        assets.add(quote)
        for src, dst, rate in ((base, quote, price), (quote, base, 1.0 / price)):
            key = (src, dst)
            cur = edges.get(key)
            if cur is None or rate > cur["rate"]:
                edges[key] = {"rate": rate, "venue": venue}
    return {"assets": sorted(assets), "edges": edges}


def _net_bps(gross_rate_ratio, legs, leg_cost_bps):
    """Return on the routed path net of per-leg costs, in bps vs the direct rate."""
    cost_factor = (1.0 - leg_cost_bps / 10000.0) ** legs
    net_ratio = gross_rate_ratio * cost_factor
    return (net_ratio - 1.0) * 10000.0, net_ratio


def find_gaps(graph, min_net_bps, *, leg_cost_bps=DEFAULT_LEG_COST_BPS):
    """
    Ranked two-hop-beats-direct gaps, net of stated costs.

    For every ordered pair (A, B) with a direct edge, and every
    intermediate X, the routed rate A->X->B is compared against the
    direct rate. A gap is emitted when the routed path's net return
    over the direct price exceeds min_net_bps. Only the best X per
    (A, B) is emitted — the octopus reaches with its best arm.
    """
    if isinstance(min_net_bps, bool) or not isinstance(min_net_bps, (int, float)):
        raise ValueError("min_net_bps must be a number")
    if leg_cost_bps < 0 or leg_cost_bps >= 10000:
        raise ValueError("leg_cost_bps must be in [0, 10000)")
    edges = graph["edges"]
    assets = graph["assets"]
    gaps = []
    for (a, b), direct in edges.items():
        best = None
        for x in assets:
            if x == a or x == b:
                continue
            leg1 = edges.get((a, x))
            leg2 = edges.get((x, b))
            if leg1 is None or leg2 is None:
                continue
            routed = leg1["rate"] * leg2["rate"]
            ratio = routed / direct["rate"]
            if ratio <= 1.0:
                continue
            net_bps, _ = _net_bps(ratio, legs=2, leg_cost_bps=leg_cost_bps)
            if best is None or net_bps > best["net_bps"]:
                best = {
                    "from": a,
                    "to": b,
                    "via": x,
                    "direct_rate": direct["rate"],
                    "direct_venue": direct["venue"],
                    "routed_rate": routed,
                    "leg_venues": [leg1["venue"], leg2["venue"]],
                    "gross_bps": (ratio - 1.0) * 10000.0,
                    "net_bps": net_bps,
                    "leg_cost_bps": leg_cost_bps,
                }
        if best is not None and best["net_bps"] > float(min_net_bps):
            gaps.append(best)
    gaps.sort(key=lambda g: g["net_bps"], reverse=True)
    return gaps


def convert(amount, src, dst, graph, *, max_hops=2):
    """
    Best-rate conversion of `amount` of src into dst, direct or via
    one intermediate (max_hops=2). Returns {amount_out, rate, path,
    venues} or None when the graph holds no honest path.
    """
    if isinstance(amount, bool) or not isinstance(amount, (int, float)) or float(amount) < 0:
        raise ValueError("amount must be a number >= 0")
    if src == dst:
        return {"amount_out": float(amount), "rate": 1.0, "path": [src], "venues": []}
    edges = graph["edges"]
    best = None
    direct = edges.get((src, dst))
    if direct is not None:
        best = {"amount_out": float(amount) * direct["rate"], "rate": direct["rate"],
                "path": [src, dst], "venues": [direct["venue"]]}
    if max_hops >= 2:
        for x in graph["assets"]:
            if x == src or x == dst:
                continue
            leg1 = edges.get((src, x))
            leg2 = edges.get((x, dst))
            if leg1 is None or leg2 is None:
                continue
            rate = leg1["rate"] * leg2["rate"]
            if best is None or rate > best["rate"]:
                best = {"amount_out": float(amount) * rate, "rate": rate,
                        "path": [src, x, dst], "venues": [leg1["venue"], leg2["venue"]]}
    return best

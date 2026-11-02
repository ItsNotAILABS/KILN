# Octopus engine — cross-venue price graph + arbitrage gaps

The Python algo layer for KILN compute: every price the house can
reach — Raydium, Orca, Meteora, pump.fun curves, Jupiter, indexers —
linked into one graph, with the best route (direct or via an
intermediate asset) found for any pair, and gaps ranked net of
stated costs. "Priced in other stuff" is the normal input, never a
rejection: a quote is just an edge.

## Contract (the only surface other lanes depend on)

```python
from octopus import build_graph, find_gaps, convert

graph = build_graph(quotes)   # quotes: [{venue, base, quote, price}]
                              # price = units of `quote` per 1 `base`
gaps  = find_gaps(graph, min_net_bps, leg_cost_bps=30.0)
                              # -> [{from, to, via, direct_rate, direct_venue,
                              #     routed_rate, leg_venues, gross_bps,
                              #     net_bps, leg_cost_bps}] ranked by net_bps
out   = convert(amount, "SPCX", "USDC", graph)
                              # -> {amount_out, rate, path, venues} | None
```

Costs are inputs, printed in every result — never hidden constants.
No path in the graph means `None`, never a fabricated rate.
Malformed quotes raise `ValueError` (real-or-loud).

## Service form

`server.py` wraps the core in a stdlib HTTP service
(`POST /v1/scan`, `POST /v1/convert`, `GET /health`) so the engine
can run as a KILN compute app beside the other house services —
deploy recipe in `DEPLOY.md`. The service is stateless; quotes ride
each request.

## Tests

```sh
cd engines/octopus && python3 -m unittest -v
```

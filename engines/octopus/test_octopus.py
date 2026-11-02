"""Octopus core tests — pure stdlib unittest. Run: python3 -m unittest -v"""
import unittest

from octopus import build_graph, convert, find_gaps

# A fixture universe: SOL priced in USDC on two venues at slightly
# different rates, SPCX (a token) priced in SOL by a pump curve, and
# SPCX priced in USDC (too cheaply) by an indexer — the triangular
# gap the octopus arm should find.
QUOTES = [
    {"venue": "Raydium", "base": "SOL", "quote": "USDC", "price": 100.0},
    {"venue": "Orca", "base": "SOL", "quote": "USDC", "price": 100.0},
    {"venue": "pump.fun", "base": "SPCX", "quote": "SOL", "price": 0.01},      # 1 SPCX = 0.01 SOL = $1.00
    {"venue": "GeckoTerminal", "base": "SPCX", "quote": "USDC", "price": 0.90},  # indexer says $0.90 — stale
    {"venue": "Jupiter", "base": "USDC", "quote": "USD", "price": 1.0},
]


class BuildGraph(unittest.TestCase):
    def test_both_directions_and_best_edge(self):
        g = build_graph(QUOTES)
        self.assertIn("SPCX", g["assets"])
        fwd = g["edges"][("SPCX", "SOL")]
        self.assertEqual(fwd["rate"], 0.01)
        self.assertEqual(fwd["venue"], "pump.fun")
        inv = g["edges"][("SOL", "SPCX")]
        self.assertAlmostEqual(inv["rate"], 100.0)

    def test_loud_on_bad_quotes(self):
        for bad in (
            {"venue": "v", "base": "A", "quote": "B", "price": 0},
            {"venue": "v", "base": "A", "quote": "B", "price": -1},
            {"venue": "v", "base": "A", "quote": "B", "price": "x"},
            {"venue": "v", "base": "A", "quote": "A", "price": 1},
            {"venue": "", "base": "A", "quote": "B", "price": 1},
            {"base": "A", "quote": "B", "price": 1},
        ):
            with self.assertRaises(ValueError):
                build_graph([bad])


class FindGaps(unittest.TestCase):
    def test_triangular_gap_found_and_ranked(self):
        g = build_graph(QUOTES)
        gaps = find_gaps(g, min_net_bps=100)
        self.assertTrue(gaps, "expected the SPCX gap")
        # SPCX -> USDC direct is the indexer's 0.90; routed SPCX -> SOL
        # -> USDC gives 0.01 * 100 = 1.00, ~11% over direct. (The same
        # stale price also yields the mirror gap USDC -> SOL via SPCX;
        # both are the one mispricing, seen from either side.)
        fwd = next(x for x in gaps if (x["from"], x["to"]) == ("SPCX", "USDC"))
        self.assertEqual(fwd["via"], "SOL")
        self.assertEqual(fwd["direct_venue"], "GeckoTerminal")
        self.assertEqual(fwd["leg_venues"], ["pump.fun", "Raydium"])
        self.assertGreater(fwd["gross_bps"], 1000)
        self.assertGreater(fwd["net_bps"], 100)
        self.assertEqual(fwd["leg_cost_bps"], 30.0)
        mirror = next(x for x in gaps if (x["from"], x["to"]) == ("USDC", "SOL"))
        self.assertEqual(mirror["via"], "SPCX")
        # ranked descending by net_bps
        nets = [x["net_bps"] for x in gaps]
        self.assertEqual(nets, sorted(nets, reverse=True))

    def test_costs_can_kill_a_gap(self):
        g = build_graph(QUOTES)
        # A punitive cost assumption must remove the same gap — costs
        # are real inputs, not decoration.
        gaps = find_gaps(g, min_net_bps=100, leg_cost_bps=900)
        self.assertFalse(any(x["from"] == "SPCX" and x["to"] == "USDC" for x in gaps))

    def test_threshold_filters(self):
        g = build_graph(QUOTES)
        self.assertEqual(find_gaps(g, min_net_bps=100000), [])

    def test_no_gap_when_prices_agree(self):
        g = build_graph([
            {"venue": "a", "base": "SOL", "quote": "USDC", "price": 100.0},
            {"venue": "b", "base": "SPCX", "quote": "SOL", "price": 0.01},
            {"venue": "c", "base": "SPCX", "quote": "USDC", "price": 1.0},
        ])
        self.assertEqual(find_gaps(g, min_net_bps=10), [])


class Convert(unittest.TestCase):
    def test_convert_via_intermediate(self):
        g = build_graph(QUOTES)
        out = convert(500, "SPCX", "USDC", g)
        # Best path prices SPCX at its curve value: 500 * 1.00 = 500.
        self.assertAlmostEqual(out["amount_out"], 500.0)
        self.assertEqual(out["path"], ["SPCX", "SOL", "USDC"])

    def test_convert_direct_and_identity(self):
        g = build_graph(QUOTES)
        self.assertAlmostEqual(convert(2, "SOL", "USDC", g)["amount_out"], 200.0)
        self.assertEqual(convert(7, "SOL", "SOL", g)["amount_out"], 7.0)

    def test_convert_no_path_is_none_not_a_guess(self):
        g = build_graph(QUOTES)
        self.assertIsNone(convert(1, "SPCX", "BONK", g))

    def test_convert_loud_on_bad_amount(self):
        g = build_graph(QUOTES)
        with self.assertRaises(ValueError):
            convert(-1, "SOL", "USDC", g)


if __name__ == "__main__":
    unittest.main()

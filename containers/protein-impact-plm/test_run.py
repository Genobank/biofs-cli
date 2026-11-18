"""Unit tests for the plm container logic. No model and no network: a fake scorer stands in for the language model.
Published GT variants only (Q778P, F222L); no sample data."""

import copy
import hashlib
import math
import os
import unittest

import run

FIXTURES = os.path.join(os.path.dirname(__file__), "..", "..", "test", "fixtures")


def load_seq(acc):
    with open(os.path.join(FIXTURES, acc + ".fasta")) as f:
        return "".join(l.strip() for l in f if not l.startswith(">"))


A = load_seq("P08514")  # ITGA2B precursor, 1039 residues, signal peptide 31


def job():
    return {
        "schema": run.SCHEMA,
        "layer": "plm",
        "models": {"esm2_650m": {"hf_repo": "facebook/esm2_t33_650M_UR50D", "revision": "0" * 40}},
        "sequences": {"ITGA2B": {"uniprot": "P08514", "signal": 31, "length": 1039,
                                 "seq_sha256": hashlib.sha256(A.encode()).hexdigest(), "sequence": A}},
        "subs": [
            {"variant": "ITGA2B:p.Gln778Pro", "gene": "ITGA2B", "pos": 778, "mature_pos": 747, "ref": "Q", "alt": "P"},
            {"variant": "ITGA2B:p.Phe222Leu", "gene": "ITGA2B", "pos": 222, "mature_pos": 191, "ref": "F", "alt": "L"},
        ],
    }


class FakeScorer(object):
    """Gives every residue a fixed log probability, with the reference residue most likely, and records calls."""

    def __init__(self):
        self.calls = []

    def logprobs(self, mature, index):
        self.calls.append((len(mature), index, mature[index]))
        ref = mature[index]
        raw = {a: (2.0 if a == ref else -float(i) / 4.0) for i, a in enumerate(run.STANDARD)}
        z = math.log(sum(math.exp(v) for v in raw.values()))
        return {a: v - z for a, v in raw.items()}


class CheckJob(unittest.TestCase):
    def test_valid_job_passes(self):
        self.assertIn("ITGA2B", run.check_job(job()))

    def test_refuses_other_layers_and_schemas(self):
        j = job(); j["layer"] = "md"
        with self.assertRaises(run.JobError): run.check_job(j)
        j = job(); j["schema"] = "x"
        with self.assertRaises(run.JobError): run.check_job(j)

    def test_refuses_a_sequence_that_differs_from_the_pin(self):
        j = job(); seq = A[:100] + ("A" if A[100] != "A" else "C") + A[101:]
        j["sequences"]["ITGA2B"]["sequence"] = seq
        with self.assertRaisesRegex(run.JobError, "hash"): run.check_job(j)

    def test_refuses_residues_outside_the_standard_20(self):
        j = job(); j["sequences"]["ITGA2B"]["sequence"] = A[:-1] + "X"
        with self.assertRaisesRegex(run.JobError, "non-standard"): run.check_job(j)

    def test_refuses_a_wrong_reference_residue(self):
        j = job(); j["subs"][0]["ref"] = "A"
        with self.assertRaisesRegex(run.JobError, "has Q"): run.check_job(j)

    def test_refuses_a_position_in_the_signal_peptide(self):
        j = job(); j["subs"][0].update({"pos": 20, "mature_pos": -11, "ref": A[19]})
        with self.assertRaisesRegex(run.JobError, "outside the mature chain"): run.check_job(j)

    def test_refuses_mature_numbering_that_disagrees(self):
        j = job(); j["subs"][0]["mature_pos"] = 778
        with self.assertRaisesRegex(run.JobError, "mature_pos"): run.check_job(j)

    def test_refuses_a_job_with_no_models(self):
        j = job(); j["models"] = {}
        with self.assertRaisesRegex(run.JobError, "no models"): run.check_job(j)

    def test_refuses_identity_and_non_standard_alt(self):
        j = job(); j["subs"][0]["alt"] = "Q"
        with self.assertRaises(run.JobError): run.check_job(j)
        j = job(); j["subs"][0]["alt"] = "B"
        with self.assertRaises(run.JobError): run.check_job(j)


class Scoring(unittest.TestCase):
    def test_scorer_receives_the_mature_chain_and_the_right_index(self):
        fake = FakeScorer()
        out = run.score(job(), {"esm2_650m": fake})
        self.assertEqual(len(fake.calls), 2)
        by_index = {c[1]: c for c in fake.calls}
        self.assertEqual(by_index[746], (1008, 746, "Q"))   # 778 - 31 - 1; mature chain is 1,008 residues
        self.assertEqual(by_index[190], (1008, 190, "F"))   # 222 - 31 - 1
        self.assertEqual([r["variant"] for r in out["records"]], ["ITGA2B:p.Gln778Pro", "ITGA2B:p.Phe222Leu"])

    def test_two_substitutions_at_one_position_cost_one_forward_pass(self):
        j = job()
        j["subs"].append({"variant": "ITGA2B:p.Gln778Arg", "gene": "ITGA2B", "pos": 778, "mature_pos": 747, "ref": "Q", "alt": "R"})
        fake = FakeScorer()
        out = run.score(j, {"esm2_650m": fake})
        self.assertEqual(len(fake.calls), 2)
        self.assertEqual(len(out["records"]), 3)

    def test_llr_rank_and_entropy(self):
        logp = {a: -3.0 for a in run.STANDARD}
        logp["Q"] = -0.1; logp["P"] = -9.0
        s = run.summarize_position(logp, "Q", "P")
        self.assertAlmostEqual(s["llr"], -8.9, places=4)
        self.assertEqual(s["ref_rank"], 1)
        self.assertEqual(s["alt_rank"], 20)
        self.assertGreater(s["position_entropy"], 0)
        flat = {a: math.log(1.0 / 20) for a in run.STANDARD}
        self.assertAlmostEqual(run.summarize_position(flat, "Q", "P")["position_entropy"], math.log(20), places=3)

    def test_a_scorer_that_returns_the_wrong_alphabet_is_refused(self):
        class Bad(object):
            def logprobs(self, mature, index): return {"A": -1.0}
        with self.assertRaisesRegex(run.JobError, "20 standard residues"):
            run.score(job(), {"esm2_650m": Bad()})

    def test_output_is_numbers_and_ranks_only(self):
        out = run.score(job(), {"esm2_650m": FakeScorer()})
        for rec in out["records"]:
            for key, val in rec.items():
                if key == "variant":
                    continue
                self.assertTrue(all(isinstance(v, (int, float)) for v in val.values()), key)


if __name__ == "__main__":
    unittest.main()

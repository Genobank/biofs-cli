#!/usr/bin/env python3
"""protein-impact plm: masked-marginal log-likelihood ratios of KNOWN missense substitutions.

Scores only. Nothing here generates, samples, designs or optimizes a sequence: the model is asked, for a
position that already carries a known substitution, how likely each residue is, and the answer is
summarized as numbers. Input is job.json written by `biofs protein-impact exec`; output is out.json.

  python run.py /work/job.json /work/out.json
"""

import hashlib
import json
import math
import os
import sys

STANDARD = "ACDEFGHIKLMNPQRSTVWY"
SCHEMA = "genobank.protein-impact.container-job/v1"


class JobError(Exception):
    pass


def sha256_hex(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def check_job(job):
    """Fail closed on anything that is not exactly what the executor sends."""
    if job.get("schema") != SCHEMA:
        raise JobError("unexpected job schema")
    if job.get("layer") != "plm":
        raise JobError("this image serves the plm layer only")
    genes = job.get("sequences") or {}
    for gene, g in genes.items():
        seq = g.get("sequence", "")
        if not seq or any(c not in STANDARD for c in seq):
            raise JobError("%s: sequence is empty or holds non-standard residues" % gene)
        if len(seq) != g.get("length"):
            raise JobError("%s: length %d, expected %s" % (gene, len(seq), g.get("length")))
        if sha256_hex(seq) != g.get("seq_sha256"):
            raise JobError("%s: sequence hash does not match the pin" % gene)
        if not isinstance(g.get("signal"), int) or not 0 <= g["signal"] < len(seq):
            raise JobError("%s: bad signal peptide length" % gene)
    for s in job.get("subs") or []:
        g = genes.get(s["gene"])
        if g is None:
            raise JobError("no sequence for %s" % s["gene"])
        pos = s["pos"]
        if not isinstance(pos, int) or pos <= g["signal"] or pos > len(g["sequence"]):
            raise JobError("%s: position %s is outside the mature chain" % (s["variant"], pos))
        found = g["sequence"][pos - 1]
        if found != s["ref"]:
            raise JobError("%s: the sequence has %s at %d, not %s" % (s["variant"], found, pos, s["ref"]))
        if s["alt"] not in STANDARD or s["alt"] == s["ref"]:
            raise JobError("%s: alt must be a different standard residue" % s["variant"])
        if s["mature_pos"] != pos - g["signal"]:
            raise JobError("%s: mature_pos disagrees with the signal peptide length" % s["variant"])
    if not job.get("models"):
        raise JobError("no models pinned for this layer")
    return genes


def summarize_position(logp, ref, alt):
    """logp maps each standard residue to its log probability at the position (full-vocabulary log softmax)."""
    llr = logp[alt] - logp[ref]
    order = sorted(STANDARD, key=lambda a: -logp[a])
    probs = [math.exp(logp[a]) for a in STANDARD]
    z = sum(probs)
    entropy = -sum((p / z) * math.log(p / z) for p in probs if p > 0)
    return {
        "llr": round(llr, 4),
        "logp_ref": round(logp[ref], 4),
        "logp_alt": round(logp[alt], 4),
        "alt_rank": order.index(alt) + 1,   # 1 = the most probable residue; 20 = the least
        "ref_rank": order.index(ref) + 1,
        "position_entropy": round(entropy, 4),
    }


def score(job, scorers):
    """scorers: model key -> object with logprobs(mature_sequence, index) -> {residue: log probability}."""
    genes = check_job(job)
    by_position = {}
    for s in job["subs"]:
        by_position.setdefault((s["gene"], s["pos"]), []).append(s)
    records = {s["variant"]: {"variant": s["variant"]} for s in job["subs"]}
    for key, scorer in scorers.items():
        for (gene, pos), subs in sorted(by_position.items()):
            g = genes[gene]
            mature = g["sequence"][g["signal"]:]
            index = pos - g["signal"] - 1
            if mature[index] != subs[0]["ref"]:
                raise JobError("%s: mature indexing disagrees with the sequence" % subs[0]["variant"])
            logp = scorer.logprobs(mature, index)
            if set(logp) != set(STANDARD):
                raise JobError("scorer %s did not return the 20 standard residues" % key)
            for s in subs:
                records[s["variant"]][key] = summarize_position(logp, s["ref"], s["alt"])
    return {"records": [records[s["variant"]] for s in job["subs"]], "summary": {"models": sorted(scorers)}}


class Esm2Scorer(object):
    """Masked marginal: mask the position, read the model's distribution there (Meier et al. 2021)."""

    def __init__(self, hf_repo, revision):
        import torch
        from transformers import AutoTokenizer, EsmForMaskedLM
        self.torch = torch
        torch.set_num_threads(max(1, os.cpu_count() or 1))
        self.tokenizer = AutoTokenizer.from_pretrained(hf_repo, revision=revision)
        self.model = EsmForMaskedLM.from_pretrained(hf_repo, revision=revision).eval()
        self.ids = {a: self.tokenizer.convert_tokens_to_ids(a) for a in STANDARD}
        if any(i is None or i == self.tokenizer.unk_token_id for i in self.ids.values()):
            raise JobError("tokenizer does not know all 20 standard residues")

    def logprobs(self, mature, index):
        torch = self.torch
        if len(mature) > 1022:
            raise JobError("sequence of %d residues exceeds the 1,022-residue context" % len(mature))
        enc = self.tokenizer(mature, return_tensors="pt")
        tok = index + 1  # position 0 is <cls>
        enc["input_ids"][0, tok] = self.tokenizer.mask_token_id
        with torch.no_grad():
            logits = self.model(**enc).logits[0, tok]
        lp = torch.log_softmax(logits.float(), dim=-1)
        return {a: float(lp[i]) for a, i in self.ids.items()}


def main(argv):
    if len(argv) != 3:
        sys.stderr.write("usage: run.py job.json out.json\n")
        return 2
    with open(argv[1]) as f:
        job = json.load(f)
    check_job(job)  # before any weight is downloaded
    scorers = {}
    for key, m in job["models"].items():
        if key != "esm2_650m":
            raise JobError("model %s is not supported by this image" % key)
        scorers[key] = Esm2Scorer(m["hf_repo"], m["revision"])
    out = score(job, scorers)
    import platform
    out["summary"]["python"] = platform.python_version()
    try:
        import torch
        import transformers
        out["summary"].update({"torch": torch.__version__, "transformers": transformers.__version__})
    except ImportError:
        pass
    out["summary"]["models_pinned"] = {k: v["revision"] for k, v in job["models"].items()}
    with open(argv[2], "w") as f:
        json.dump(out, f)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except JobError as e:
        sys.stderr.write("protein-impact plm refused: %s\n" % e)
        sys.exit(2)
